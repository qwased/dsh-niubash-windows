/**
 * Pure helpers shared by the tool layer: workdir resolution, environment
 * layering, startup-error guidance, and the structured abort. No DSH imports,
 * so unit tests load this module directly.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { statSync } from 'node:fs'
import { MAX_COMMAND_CHARS } from './prompt.js'

/**
 * Pre-flight the launch directory so a missing cwd is reported as itself,
 * not misattributed to niu.exe (spawn ENOENT looks identical for both).
 * @param {string} workdir
 * @returns {string|undefined} an actionable message, or undefined when usable.
 */
export function workdirError(workdir) {
  let stats
  try {
    stats = statSync(workdir)
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT') return `working directory does not exist: ${workdir}`
    if (code === 'EACCES' || code === 'EPERM') return `working directory is not accessible: ${workdir}`
    return `working directory cannot be used: ${workdir} (${code ?? 'unknown error'})`
  }
  if (!stats.isDirectory()) return `workdir is not a directory: ${workdir}`
  return undefined
}

/** Windows limits one command line to ~32K characters; refuse before spawn. */
export const TOO_LONG_GUIDANCE =
  `Command line too long: Windows limits a single command to about ${MAX_COMMAND_CHARS} characters. ` +
  'Write the script to a file and run that file, or split the command into smaller calls.'

const NOT_STARTED_GUIDANCE = (niuPath) =>
  `Could not start niu.exe at ${niuPath}: the file does not exist or cannot be executed. ` +
  'The plugin config niuPath / DSH_NIUBASH_PATH must point at niu.exe itself; reinstall Niubash or fix the path, then restart DSH.'

const PERMISSION_GUIDANCE = (niuPath) =>
  `Could not start niu.exe at ${niuPath}: permission denied. ` +
  'Check the file permissions and the plugin config niuPath / DSH_NIUBASH_PATH, then restart DSH.'

/** Errno codes Windows reports when the shell executable itself cannot start. */
const NOT_STARTED_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EFTYPE', 'EINVAL', 'UNKNOWN'])

/** Turn a shell startup failure into actionable guidance, preserving errno and cause. */
export function describeStartupError(error, niuPath) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const code = error?.code
  const syscall = error?.syscall

  let guidance
  if (code === 'ENAMETOOLONG' || code === 'E2BIG' || message.includes('ENAMETOOLONG')) {
    guidance = TOO_LONG_GUIDANCE
  } else if (
    code &&
    NOT_STARTED_CODES.has(code) &&
    (syscall === undefined || syscall === 'spawn' || String(syscall).startsWith('spawn '))
  ) {
    guidance = code === 'EACCES' || code === 'EPERM' ? PERMISSION_GUIDANCE(niuPath) : NOT_STARTED_GUIDANCE(niuPath)
  }
  if (!guidance) return error
  const replacement = new Error(guidance, { cause: error })
  if (code) replacement.code = code
  return replacement
}

/** The structured abort the foreground paths throw when the caller cancels. */
export function toolAborted() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

/** Resolve a relative per-call override against the session's current directory. */
export function resolveWorkdir(modelWorkdir, sessionCwd) {
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) return resolvePath(sessionCwd, modelWorkdir)
  return modelWorkdir
}

/**
 * The child environment: the harness environment minus inherited DSH_* names,
 * the model-friendly terminal overrides, then the trusted shellEnv snapshot last.
 */
export function buildEnv(dshEnv) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_')) delete env[key]
  }
  env.NO_COLOR = '1'
  env.PAGER = 'cat'
  env.GIT_PAGER = 'cat'
  Object.assign(env, dshEnv ?? {})
  return env
}