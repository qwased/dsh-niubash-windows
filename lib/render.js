/**
 * Model-facing result rendering for the niubash tool — mirrors the pwsh/bash
 * marker contract so both shells read the same: stdout, a marked `[stderr]`
 * section, truncation notices with spill paths, then sandbox notes, then
 * timeout/stopped/signal/exit markers. Non-zero exits are reported, not errored.
 *
 * The sandbox marker text lives in @deepseek-ai/dsh-sandbox, but this module
 * stays a pure, dependency-free function: the registration-time
 * `support.notes()` closure produces the `notes` array and this function only
 * interleaves it. That is what keeps `npm test` loadable without DSH packages.
 *
 * Ported from dsh-tool-pwsh `src/render.ts` (MIT, DeepSeek Harness).
 */

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees. A clean exit (0, no
 * signal) produces no marker; the exit marker stays last because the UI card's
 * exit pill parses it from there. `notes` are the sandbox markers (denial,
 * escalation hint, runner failure) injected by the caller.
 */
export function renderNiubashResult(result, notes = []) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = [...notes]
  // A command may trap the termination and exit 0 after timeout; still report interruption.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  // A kill from outside the call (the human stopping its job) is not a command failure.
  if (result.stopped !== undefined) markers.push(`[stopped: ${result.stopped}]`)
  if (result.signal !== null && result.signal !== undefined) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** A foreground call that stopped waiting: output so far, then the still-running marker. */
export function renderPromoted(promoted) {
  const body = promoted.output.length > 0
    ? promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n`
    : ''
  return `${body}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]`
}

/**
 * The ring chunks of one consuming registry read as a process read: stdout
 * chunks in order, then every stderr chunk in one `[stderr]` section.
 */
export function ringDelta(chunks) {
  const out = chunks.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = chunks.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/** A promoted call's embedded read: delta plus the dropped-output notice when lossy. */
export function renderJobRead(delta, lossy, spillPaths) {
  if (!lossy) return delta
  const notice = `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notice}`
}