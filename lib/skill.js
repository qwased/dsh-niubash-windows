/**
 * Bundled `niubash` troubleshooting skill provider.
 *
 * Ships the skill inside this package ("installed with the bundle"): the
 * provider reads `skill/SKILL.md` from the package directory at catalog time,
 * so a linked or copied install carries its own skill without a separate
 * `~/.dsh/skills` entry. Pattern follows `@deepseek-ai/dsh-skill-office`:
 * `source: 'bundled'`, rank 600, directory `resourceBase` so the model can
 * resolve `references/` against the package.
 *
 * Precedence: filesystem skills (project/user ranks 100-500) outrank this
 * bundled copy (600), so a user may override it by placing their own
 * `niubash` skill under `~/.dsh/skills` or a project root.
 *
 * No runtime imports on purpose: unit tests load this module directly. The
 * frontmatter parser supports the single-line scalar subset this package's
 * SKILL.md uses (name, description); block scalars are rejected, not guessed.
 */

import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'niubash'
export const PROVIDER_NAME = 'dsh-niubash-windows'
/** Mirrors BUNDLED_SKILL_RANK from @deepseek-ai/dsh-skill; kept literal to stay dependency-free. */
export const BUNDLED_SKILL_RANK = 600

const DEFAULT_SKILL_DIR = fileURLToPath(new URL('../skill/', import.meta.url))
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Parse the SKILL.md frontmatter subset: top-level `key: value` lines with
 * single-line plain or quoted scalars. Indented continuation lines (nested
 * metadata) and comments are ignored; block scalars throw so a malformed
 * routing description is reported instead of silently degraded.
 * @param {string} raw - full SKILL.md text.
 * @returns {{ name: string, description: string, content: string }}
 */
export function parseSkillFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw new Error('SKILL.md has no YAML frontmatter')
  /** @type {Record<string, string>} */
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s/u.test(line) || line.trim() === '' || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/u.exec(line)
    if (kv === null) continue
    let value = kv[2].trim()
    if (value.startsWith('|') || value.startsWith('>')) {
      throw new Error(`frontmatter field "${kv[1]}" uses a block scalar; this provider supports single-line scalars only`)
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[kv[1]] = value
  }
  const name = data.name
  const description = data.description
  if (name === undefined || name === '' || description === undefined || description === '') {
    throw new Error('frontmatter requires name and description')
  }
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`invalid skill name "${name}"`)
  return { name, description, content: raw.slice(match[0].length).trim() }
}

/** Missing paths persist until the file appears; other read errors, such as locks, may clear. */
function persistentReadFailure(error) {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Register the bundled `niubash` skill provider on `ctx.skills`.
 * Registration belongs to the calling (injected) fiber: the registry removes
 * the provider when that fiber disposes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying the skill registry.
 * @param {{ skillDir?: string }} [options] - skill directory override (tests).
 */
export function registerNiubashSkill(ctx, options = {}) {
  const skillDir = options.skillDir ?? DEFAULT_SKILL_DIR
  const skillPath = join(skillDir, 'SKILL.md')
  let reportedFailure
  async function readSkill(signal) {
    let raw
    try {
      raw = await readFile(skillPath, { encoding: 'utf8', signal })
    } catch (error) {
      if (signal?.aborted === true) throw error
      return { kind: 'failed', error, persistent: persistentReadFailure(error) }
    }
    try {
      return { kind: 'loaded', ...parseSkillFrontmatter(raw) }
    } catch (error) {
      return { kind: 'failed', error, persistent: true }
    }
  }
  function report(error) {
    const failure = String(error)
    if (reportedFailure !== failure) {
      reportedFailure = failure
      ctx.logger.warn(`${PROVIDER_NAME}: skill "${SKILL_NAME}" is unavailable: ${failure}`)
    }
  }
  ctx.skills.registerProvider((control) => ({
    name: PROVIDER_NAME,
    async list(listOptions) {
      const read = await readSkill(listOptions.signal)
      if (read.kind === 'failed') {
        report(read.error)
        return { candidates: [], complete: read.persistent }
      }
      reportedFailure = undefined
      return [{
        name: read.name,
        description: read.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        resourceBase: { kind: 'directory', path: skillDir.split(sep).join('/') },
        locator: skillPath,
        path: skillPath,
      }]
    },
    async get(candidate, getOptions) {
      const { rank: _rank, locator: _locator, ...summary } = candidate
      const read = await readSkill(getOptions.signal)
      if (read.kind === 'failed') {
        report(read.error)
        if (!read.persistent) throw read.error
        control.invalidate()
        return undefined
      }
      return { ...summary, content: read.content }
    },
  }))
}
