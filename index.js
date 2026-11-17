/**
 * dsh-niubash-windows — Niubash (native Windows bash) as a DSH tool.
 *
 * Registers a `niubash` tool that runs commands through Niubash's `niu -c`,
 * keeps the built-in `pwsh` tool untouched next to it, and adds a prompt
 * section that makes niubash the default shell. Ported from the Pi extension
 * pi-niubash-windows (MIT, Copyright (c) 2026 qwased) onto the DSH tool/job
 * contracts; the process layer is self-contained because the ctx.shell seam
 * admits exactly one executor per composition (pwsh on Windows).
 *
 * Outside Windows the plugin stays inert: Niubash ships niu.exe only for
 * Windows, and a stub injecting "prefer niubash over pwsh" rules would be
 * wrong on every other platform.
 */

import z from '@deepseek-ai/schemastery'
import { isSupportedPlatform, resolveNiu } from './lib/niu.js'
import { buildNiubashTool, buildUnavailableTool } from './lib/tool.js'
import { PROMPT_SECTION, UNAVAILABLE_SECTION } from './lib/prompt.js'

/** Cordis plugin name. */
export const name = 'niubash-windows'

/** Services required before the plugin activates. */
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

/** Plugin configuration; every field has a default, so `config: {}` works. */
export const Config = z.object({
  niuPath: z.string().default(''),
  timeoutMs: z.number().default(120000),
  maxTimeoutMs: z.number().default(600000),
  maxOutputBytes: z.number().default(64000),
  maxSpillBytes: z.number().default(67108864),
  graceMs: z.number().default(3000),
  enableRunInBackground: z.boolean().default(true),
  promoteOnTimeout: z.boolean().default(true),
  preferPrompt: z.boolean().default(true),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  if (!isSupportedPlatform()) return

  const resolution = resolveNiu({ configuredPath: config.niuPath })

  // The shell-selection contract lives in the prompt, not in another tool's
  // description. Order 1015 places it right after the first-party pwsh
  // guidance (1010). interpolate:false keeps any literal braces in paths safe.
  const sectionText = resolution.found
    ? (config.preferPrompt === false ? '' : PROMPT_SECTION)
    : UNAVAILABLE_SECTION
  if (sectionText !== '') {
    ctx.systemPrompt.section({ name: 'tool:niubash', order: 1015, text: sectionText, interpolate: false })
  }

  const registerTool = (jobs) =>
    ctx.tools.register(
      resolution.found
        ? buildNiubashTool({ ctx, config, niuPath: resolution.path, jobs })
        : buildUnavailableTool({ failure: resolution }),
    )

  // The unavailable stub and the background-disabled variant need no registry.
  if (!resolution.found || config.enableRunInBackground === false) {
    registerTool(undefined)
    return
  }

  // The background surface follows the registry: the job-backed variant
  // replaces the foreground-only one while ctx.jobs is present, and the
  // foreground-only one returns when the registry unloads while this plugin
  // stays. Both registrations belong to this plugin's own fiber.
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
  }, 'niubash: plugin lifecycle')

  let foregroundOnly = ctx.get('jobs') === undefined ? registerTool(undefined) : undefined
  ctx.inject(['jobs'], (jobCtx) => {
    foregroundOnly?.()
    foregroundOnly = undefined
    const unregister = registerTool(jobCtx.jobs)
    jobCtx.effect(() => () => {
      unregister()
      if (!disposed) foregroundOnly = registerTool(undefined)
    }, 'niubash: job-backed registration')
  })
}