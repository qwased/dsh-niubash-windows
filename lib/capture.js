/**
 * Bounded per-stream output capture with a full-output spill file.
 *
 * Mirrors the dsh-pwsh-local budgets: the last `maxBytes` bytes stay in memory
 * for offset reads; once a stream overflows, every byte (including the
 * pre-overflow head) is written to `spillPath`, capped at `maxSpillBytes`.
 * `readFrom` is a non-consuming offset reader with the exact `JobSourceRead`
 * shape the `ctx.jobs` registry pumps, so background jobs stream live output.
 *
 * Offsets are UTF-8 byte offsets. A read that starts inside a multi-byte
 * character may begin with U+FFFD; chunk boundaries are otherwise preserved.
 */

import { closeSync, openSync, writeSync } from 'node:fs'

export class StreamCapture {
  /**
   * @param {object} options
   * @param {number} options.maxBytes - in-memory tail retention (default 64000).
   * @param {number} options.maxSpillBytes - full-output spill cap (default 64 MiB).
   * @param {string} options.spillPath - file created lazily on first overflow.
   */
  constructor({ maxBytes = 64000, maxSpillBytes = 64 * 1024 * 1024, spillPath }) {
    this.maxBytes = maxBytes
    this.maxSpillBytes = maxSpillBytes
    this.spillPath = spillPath
    /** @type {{at: number, buf: Buffer}[]} */
    this.chunks = []
    this.retainedBytes = 0
    this.total = 0
    this.spillFd = null
    this.spillWritten = 0
    this.spillTruncated = false
    this.closed = false
  }

  /** Whether the stream overflowed and keeps a spill file. */
  get spilled() {
    return this.spillFd !== null || this.spillWritten > 0
  }

  /** Append one captured chunk. */
  push(buf) {
    if (this.closed || buf.length === 0) return
    const at = this.total
    this.total += buf.length

    // Spill before retention trimming: while total <= maxBytes nothing has been
    // trimmed yet, so opening here and writing the retained chunks + this one
    // keeps the spill file complete.
    if (this.spillFd === null && this.total > this.maxBytes) {
      this.spillFd = openSync(this.spillPath, 'w')
      for (const chunk of this.chunks) this.#writeSpill(chunk.buf)
    }
    if (this.spillFd !== null) this.#writeSpill(buf)

    this.chunks.push({ at, buf })
    this.retainedBytes += buf.length
    while (this.chunks.length > 1 && this.retainedBytes - this.chunks[0].buf.length >= this.maxBytes) {
      this.retainedBytes -= this.chunks.shift().buf.length
    }
    if (this.chunks.length === 1 && this.retainedBytes > this.maxBytes) {
      const chunk = this.chunks[0]
      const keep = chunk.buf.subarray(chunk.buf.length - this.maxBytes)
      this.chunks[0] = { at: chunk.at + (chunk.buf.length - keep.length), buf: keep }
      this.retainedBytes = keep.length
    }
  }

  #writeSpill(buf) {
    if (this.spillTruncated) return
    const room = this.maxSpillBytes - this.spillWritten
    if (room <= 0) {
      this.spillTruncated = true
      return
    }
    const slice = buf.length <= room ? buf : buf.subarray(0, room)
    writeSync(this.spillFd, slice)
    this.spillWritten += slice.length
    if (slice.length < buf.length) this.spillTruncated = true
  }

  /**
   * Non-consuming read of everything captured since `fromByte`.
   * When the offset slid out of the retained window, returns the whole
   * retained tail with `lossy: true` (the spill file keeps the full stream).
   * @param {number} fromByte
   * @returns {{text: string, nextOffset: number, lossy: boolean, spillPath?: string}}
   */
  readFrom(fromByte) {
    const total = this.total
    const extra = this.spilled ? { spillPath: this.spillPath } : {}
    if (fromByte >= total) return { text: '', nextOffset: total, lossy: false, ...extra }
    const earliest = this.chunks.length > 0 ? this.chunks[0].at : total
    const lossy = fromByte < earliest
    const start = lossy ? earliest : fromByte
    const parts = []
    for (const chunk of this.chunks) {
      const end = chunk.at + chunk.buf.length
      if (end <= start) continue
      const offset = Math.max(0, start - chunk.at)
      parts.push(offset === 0 ? chunk.buf : chunk.buf.subarray(offset))
    }
    return { text: Buffer.concat(parts).toString('utf8'), nextOffset: total, lossy, ...extra }
  }

  /**
   * The retained tail as a foreground result stream.
   * @returns {{text: string, truncated: boolean, spillPath?: string}}
   */
  tail() {
    const earliest = this.chunks.length > 0 ? this.chunks[0].at : 0
    const read = this.readFrom(earliest)
    return {
      text: read.text,
      truncated: this.total > this.maxBytes,
      ...(this.spilled ? { spillPath: this.spillPath } : {}),
    }
  }

  /** Release the spill descriptor; further pushes are dropped. */
  close() {
    this.closed = true
    if (this.spillFd !== null) {
      try {
        closeSync(this.spillFd)
      } catch {
        // Best-effort: the file content already reached the disk.
      }
      this.spillFd = null
    }
  }
}