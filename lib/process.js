/**
 * Niubash process handles: one fresh `niu -c <command>` per call.
 *
 * Self-contained on purpose: the DSH `ctx.shell` seam admits exactly one
 * executor per composition (pwsh on Windows), so niubash spawns its own
 * process instead of replacing that executor — the two shells coexist.
 * The handle shape mirrors what the pwsh tool's job adaptation consumes:
 * `done`, `result()`, `kill()`, and non-consuming `observed` stream readers.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StreamCapture } from './capture.js'
import { workdirError } from './util.js'

/**
 * @param {object} spec
 * @param {string} spec.niuPath - absolute path of niu.exe.
 * @param {string} spec.command - the bash command (one argv element).
 * @param {string} spec.workdir - launch directory.
 * @param {Record<string, string>} spec.env - complete child environment.
 * @param {number} [spec.timeoutMs] - foreground deadline; 0/undefined arms none.
 * @param {AbortSignal} [spec.signal] - caller cancellation.
 * @param {number} [spec.maxOutputBytes] - per-stream in-memory tail retention.
 * @param {number} [spec.maxSpillBytes] - per-stream spill cap.
 * @param {number} [spec.graceMs] - kill escalation / pipe-drain grace.
 */
export function spawnNiu(spec) {
  const {
    niuPath,
    command,
    workdir,
    env,
    timeoutMs = 0,
    signal,
    maxOutputBytes = 64000,
    maxSpillBytes = 64 * 1024 * 1024,
    graceMs = 3000,
  } = spec

  // A missing cwd surfaces as spawn ENOENT, indistinguishable from a missing
  // executable; refuse it up front with the real cause.
  const wdProblem = workdirError(workdir)
  if (wdProblem !== undefined) throw new Error(wdProblem)

  const tag = randomBytes(6).toString('hex')
  const stdout = new StreamCapture({ maxBytes: maxOutputBytes, maxSpillBytes, spillPath: join(tmpdir(), `dsh-niubash-${tag}-stdout.txt`) })
  const stderr = new StreamCapture({ maxBytes: maxOutputBytes, maxSpillBytes, spillPath: join(tmpdir(), `dsh-niubash-${tag}-stderr.txt`) })

  const state = {
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    killReason: undefined,
    spawnError: undefined,
    closed: false,
  }

  const child = spawn(niuPath, ['-c', command], {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let deadlineTimer
  let graceTimer
  let onAbort
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  const settle = () => {
    if (state.closed) return
    state.closed = true
    clearTimeout(deadlineTimer)
    clearTimeout(graceTimer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    stdout.close()
    stderr.close()
    resolveDone()
  }

  child.stdout.on('data', (buf) => stdout.push(buf))
  child.stderr.on('data', (buf) => stderr.push(buf))
  child.on('error', (error) => {
    // Spawn failures (ENOENT/EACCES/...) arrive asynchronously on Windows.
    state.spawnError = error
    settle()
  })
  child.on('exit', (code, sig) => {
    state.exitCode = code
    state.signal = sig
  })
  child.on('close', settle)

  /**
   * Terminate the process tree. Windows has no process-group signal, so
   * `taskkill /F /T` is the tree kill; child.kill is the fallback. The grace
   * timer settles `done` even if the tree refuses to die (best-effort, the
   * same contract the PI extension documents).
   */
  const kill = (reason) => {
    if (state.closed) return
    if (state.killReason === undefined) state.killReason = reason
    if (child.pid !== undefined) {
      try {
        const taskkill = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
        taskkill.on('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        })
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    clearTimeout(graceTimer)
    graceTimer = setTimeout(settle, graceMs)
    graceTimer.unref?.()
  }

  if (timeoutMs > 0) {
    deadlineTimer = setTimeout(() => {
      state.timedOut = true
      kill(`timed out after ${timeoutMs}ms`)
    }, timeoutMs)
    deadlineTimer.unref?.()
  }

  if (signal !== undefined) {
    if (signal.aborted) {
      state.aborted = true
      kill('tool call aborted')
    } else {
      onAbort = () => {
        state.aborted = true
        kill('tool call aborted')
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  return {
    /** The underlying child process (pid for diagnostics). */
    child,
    /** Resolves when the process settled and its streams were released; never rejects. */
    done,
    /** True once any kill (timeout, abort, or external) was issued. */
    wasKilled: () => state.killReason !== undefined,
    /** The first kill reason, when one was issued. */
    killReason: () => state.killReason,
    /** The spawn failure, when the executable could not start. */
    spawnError: () => state.spawnError,
    /** Terminate the tree; idempotent. */
    kill,
    /** Non-consuming offset readers for the job registry's pull sources. */
    observed: {
      stdout: { readFrom: (fromByte) => stdout.readFrom(fromByte) },
      stderr: { readFrom: (fromByte) => stderr.readFrom(fromByte) },
    },
    /**
     * The settled foreground projection. Rejects only for infrastructure
     * failures (the executable could not start); exits, timeouts, and aborts
     * are descriptive results.
     */
    result: async () => {
      await done
      if (state.spawnError !== undefined) throw state.spawnError
      return {
        exitCode: state.exitCode,
        signal: state.signal,
        timedOut: state.timedOut,
        aborted: state.aborted,
        stdout: stdout.tail(),
        stderr: stderr.tail(),
      }
    },
  }
}