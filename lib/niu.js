/**
 * Locating `niu.exe` for dsh-niubash-windows.
 *
 * Ported from pi-niubash-windows `src/niu.ts` (MIT, Copyright (c) 2026 qwased),
 * adapted for DeepSeek Harness: the plugin Config `niuPath` is the most
 * authoritative source, then `DSH_NIUBASH_PATH` (with `PI_NIUBASH_PATH` kept
 * for continuity), then PATH, then the standard install directories.
 *
 * Kept pure (only `node:fs` / `node:path`) so unit tests cover the resolution
 * order without a Niubash install or a DSH runtime.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export const NIU_EXE = 'niu.exe'
/** Environment overrides, most authoritative first. */
export const ENV_OVERRIDES = ['DSH_NIUBASH_PATH', 'PI_NIUBASH_PATH']

/**
 * - `file`: a regular file (or something `statSync` reports as one).
 * - `other`: exists but is a directory, device, or another non-file.
 * - `unverified`: `statSync` failed with an access error but `access(F_OK)` succeeded.
 *   Windows Store aliases behave this way (nodejs/node#36790); only `spawn` can tell.
 * - `missing`: nothing at that path.
 */

/** The single test seam. Production uses `defaultKind`. */

/** The tool shells out to `niu.exe`, so only Windows is supported. */
export function isSupportedPlatform(platform = process.platform) {
  return platform === 'win32'
}

function pathModule(platform) {
  return platform === 'win32' ? win32 : posix
}

function pathSeparator(platform) {
  return platform === 'win32' ? ';' : ':'
}

/**
 * Production probe. `statSync` is the only way to reject a directory, but it can
 * fail on runnable Windows Store aliases and some ACLs. Only an access error with
 * a successful `access(F_OK)` is retried as `unverified`.
 */
function defaultKind(path) {
  try {
    return statSync(path).isFile() ? 'file' : 'other'
  } catch (error) {
    const code = error?.code
    if (code !== 'EACCES' && code !== 'EPERM') return 'missing'
    try {
      accessSync(path, constants.F_OK)
      return 'unverified'
    } catch {
      return 'missing'
    }
  }
}

/** Trim, unquote, and expand a leading `~` using the process environment. */
function normalizeSpelling(value, env, platform) {
  if (!value) return undefined
  let path = String(value).trim()
  if (path.length > 1 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).trim()
  }
  if (!path) return undefined
  const home = env.USERPROFILE || env.HOME
  if (home) {
    if (path === '~') return home
    if (/^~[\\/]/.test(path)) return pathModule(platform).join(home, path.slice(2))
  }
  return path
}

/** Whether the raw value still contains a Windows `%NAME%` reference. */
export function hasUnexpandedVariable(value) {
  return typeof value === 'string' && /%[^%\s]+%/.test(value)
}

/** `PATH` entries that could contain `niu.exe`, in order. */
export function pathCandidates(env, platform) {
  const raw = env.PATH ?? env.Path ?? ''
  const join = pathModule(platform).join
  const candidates = []
  for (const entry of raw.split(pathSeparator(platform))) {
    const directory = normalizeSpelling(entry, env, platform)
    if (directory) candidates.push(join(directory, NIU_EXE))
  }
  return candidates
}

/** Standard Niubash install locations next to their environment variables. */
export function installDirectoryCandidates(env, platform = process.platform) {
  const join = pathModule(platform).join
  const candidates = []
  if (env.LOCALAPPDATA) {
    candidates.push({ path: join(env.LOCALAPPDATA, 'Programs', 'Niubash', NIU_EXE), source: '%LOCALAPPDATA%' })
  }
  if (env.ProgramFiles) {
    candidates.push({ path: join(env.ProgramFiles, 'Niubash', NIU_EXE), source: '%ProgramFiles%' })
  }
  return candidates
}

/**
 * Resolve `niu.exe`.
 *
 * Order: plugin Config `niuPath` (authoritative), then `DSH_NIUBASH_PATH` /
 * `PI_NIUBASH_PATH` (the first one set is authoritative — a stale value is
 * reported instead of silently falling back), then `PATH`, then the two
 * standard install directories. Every probed path is returned with its source
 * and kind, so a failed lookup can explain what was checked.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.platform]
 * @param {(path: string) => 'file'|'other'|'unverified'|'missing'} [options.kindOf]
 * @param {string} [options.configuredPath] - plugin Config `niuPath`, most authoritative.
 */
export function resolveNiu(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const kindOf = options.kindOf ?? defaultKind

  /** One authoritative candidate (config or env): found, or a failure that stops the search. */
  const authoritative = (raw, source) => {
    const path = normalizeSpelling(raw, env, platform)
    if (!path) return undefined
    const kind = kindOf(path)
    if (kind === 'file' || kind === 'unverified') {
      return { found: true, path, source, verified: kind === 'file' }
    }
    return {
      found: false,
      checked: [{ path, source, kind }],
      overrideSet: true,
      overrideSource: source,
      unexpandedVariable: hasUnexpandedVariable(raw),
    }
  }

  const fromConfig = authoritative(options.configuredPath, 'config')
  if (fromConfig) return fromConfig

  for (const name of ENV_OVERRIDES) {
    const raw = env[name]
    if (raw === undefined || String(raw).trim() === '') continue
    const hit = authoritative(raw, name)
    if (hit) return hit
  }

  const checked = []
  const seen = new Set()
  const consider = (path, source) => {
    const key = platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return undefined
    seen.add(key)
    const kind = kindOf(path)
    checked.push({ path, source, kind })
    return kind === 'file' || kind === 'unverified'
      ? { found: true, path, source, verified: kind === 'file' }
      : undefined
  }

  for (const path of pathCandidates(env, platform)) {
    const hit = consider(path, 'PATH')
    if (hit) return hit
  }
  for (const candidate of installDirectoryCandidates(env, platform)) {
    const hit = consider(candidate.path, candidate.source)
    if (hit) return hit
  }

  return { found: false, checked, overrideSet: false, overrideSource: undefined, unexpandedVariable: false }
}