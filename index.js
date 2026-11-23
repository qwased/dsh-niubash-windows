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
import { sandboxHelpers, sandboxSupport, missingSandboxHelpers } from './lib/sandbox.js'
import { PROMPT_SECTION, UNAVAILABLE_SECTION } from './lib/prompt.js'
import { registerNiubashSkill } from './lib/skill.js'

/**
 * Runtime mirror of cordis `FiberState`. `FiberState` is an
 * `export const enum`: TypeScript erases it, so @deepseek-ai/cordis 4.1.0 has
 * no runtime export and a named import throws. First-party code reads the same
 * literals (dsh-host-plugin-inventory mirrors the numeric table; compiled
 * outputs compare `fiber.state === 2`).
 */
const FIBER_STATE_LOADING = 1
const FIBER_STATE_ACTIVE = 2

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
  registerSkill: z.boolean().default(true),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  if (!isSupportedPlatform()) return

  // The bundled troubleshooting skill ships in this package's skill/ directory
  // and registers whenever the skill registry is composed — even when niu.exe
  // is missing, because install/link repair is exactly when it is needed.
  // Optional injection mirrors the jobs seam: no skills service, no skill.
  if (config.registerSkill !== false) {
    ctx.inject(['skills'], (skillCtx) => {
      registerNiubashSkill(skillCtx)
    })
  }

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

  // Registration follows two optional service sets (jobs; sandbox +
  // sandboxPolicy) and the sandbox helpers can only be imported
  // asynchronously. One refresh() reads the CURRENT snapshot, computes the one
  // variant to register, and replaces the previous registration; `epoch`
  // rejects a stale async resolution and the ACTIVE guard prevents rebuilding
  // while the plugin unloads.
  let disposeTool = () => {}
  // The last definition that registered successfully, so a failed replacement
  // can put the previous tool back instead of leaving the composition empty.
  let lastDefinition
  let epoch = 0
  const active = () => ctx.fiber.state === FIBER_STATE_ACTIVE
  /** LOADING is this plugin's own apply(); registering there is safe. */
  const registrationWindow = () => {
    const state = ctx.fiber.state
    return state === FIBER_STATE_LOADING || state === FIBER_STATE_ACTIVE
  }

  /**
   * Build and install one definition, replacing the previous registration.
   * The build runs before the old definition is disposed, and a failed
   * registration restores it, so an exception cannot leave the composition
   * without a tool or become an unhandled rejection.
   */
  const install = (build) => {
    let definition
    try {
      definition = build()
    } catch (error) {
      ctx.logger?.warn?.(`niubash: tool definition failed: ${String(error)}`)
      return
    }
    try {
      disposeTool()
      disposeTool = ctx.tools.register(definition)
      lastDefinition = definition
    } catch (error) {
      ctx.logger?.warn?.(`niubash: tool registration failed: ${String(error)}`)
      if (lastDefinition === undefined) return
      try {
        disposeTool = ctx.tools.register(lastDefinition)
      } catch (restoreError) {
        ctx.logger?.warn?.(`niubash: restoring the previous tool failed: ${String(restoreError)}`)
      }
    }
  }

  /**
   * Import the helpers once, then build the support object for the current
   * services. A missing package or a package without a required export
   * degrades to "no sandbox support": the tool still registers and confined
   * calls fail closed (D7).
   */
  const loadSupport = async () => {
    if (!resolution.found) return undefined // the unavailable stub needs no sandbox helpers
    const h = await sandboxHelpers().catch((error) => {
      ctx.logger?.warn?.(`niubash: @deepseek-ai/dsh-sandbox is not loadable; sandbox support disabled: ${String(error)}`)
      return undefined
    })
    if (h === undefined) return undefined
    const missing = missingSandboxHelpers(h)
    if (missing.length > 0) {
      ctx.logger?.warn?.(
        `niubash: @deepseek-ai/dsh-sandbox is missing required exports (${missing.join(', ')}); sandbox support disabled`,
      )
      return undefined
    }
    return sandboxSupport(ctx, h)
  }

  /** Rebuild the tool for the current (jobs, sandbox, sandboxPolicy) set. */
  const refresh = () => {
    const mine = ++epoch
    if (!resolution.found) {
      // The stub needs no helpers, so loadSupport() would resolve in the same
      // microtask as apply() — before cordis marks the fiber ACTIVE. In a
      // composition without jobs/sandbox this is the ONLY registration
      // attempt, so an async path would be dropped by active() and no tool
      // (not even the documented stub) would exist. Register synchronously.
      if (registrationWindow()) install(() => buildUnavailableTool({ failure: resolution }))
      return
    }
    void loadSupport().then(
      (support) => {
        if (mine !== epoch || !active()) return
        install(() =>
          buildNiubashTool({ ctx, config, niuPath: resolution.path, jobs: ctx.get('jobs'), support }),
        )
      },
      (error) => ctx.logger?.warn?.(`niubash: sandbox support unavailable: ${String(error)}`),
    )
  }

  // tools.register() owns its disposer in the tools service's effect, not in
  // this plugin fiber, so a late async registration must be revoked here.
  // Effects dispose in reverse creation order: the inject disposers below run
  // first (active() is false then, so they skip refresh), this one last.
  ctx.effect(() => () => {
    disposeTool()
  }, 'niubash: tool registration')

  ctx.inject(['jobs'], (jobCtx) => {
    refresh()
    jobCtx.effect(() => () => {
      if (active()) refresh()
    }, 'niubash: job-backed registration')
  })
  ctx.inject(['sandbox', 'sandboxPolicy'], (sandboxCtx) => {
    refresh()
    sandboxCtx.effect(() => () => {
      if (active()) refresh()
    }, 'niubash: sandbox-aware registration')
  })
  refresh() // baseline: register even when neither optional service is composed
}
