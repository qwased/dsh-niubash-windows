/**
 * DSH sandbox adaptation. The plugin owns no ACL code: ctx.sandbox.confine()
 * wraps the exact [niu.exe, '-c', command] argv; this module only decides the
 * policy, runs the one-shot escalation, and classifies the settled process.
 *
 * The package import happens once, at registration (see index.js). Nothing on
 * the execution path awaits an import, and lib/render.js stays a pure module
 * (the model-facing markers reach it as a `notes` array produced by the
 * registration-time `support.notes()` closure).
 *
 * Every export takes its dependencies explicitly (`support` / `h`) so the unit
 * tests can drive it with fakes and no @deepseek-ai packages installed.
 */

let helpersPromise

/**
 * Memoized import. Callers handle a rejection; never await this per call.
 * A failed import is not cached: the next registration refresh retries, so a
 * host whose install/link was repaired does not need a DSH restart.
 */
export function sandboxHelpers() {
  helpersPromise ??= import('@deepseek-ai/dsh-sandbox').catch((error) => {
    helpersPromise = undefined
    throw error
  })
  return helpersPromise
}

/**
 * The exports this plugin actually calls. Older hosts inside the `engines.dsh`
 * range may ship `@deepseek-ai/dsh-sandbox` without one of them; that must
 * degrade to "no sandbox support" (the tool still registers and confined
 * calls fail closed), not to a registration-time TypeError that removes the
 * tool entirely.
 */
export const REQUIRED_HELPERS = Object.freeze([
  'ESCALATION_TARGETS',
  'sandboxDenialMarker',
  'escalationHintMarker',
  'classifyRunnerFailure',
  'matchesSignature',
  'isRunnerSpawnFailure',
  'SandboxUnavailableError',
  'SandboxEscalationError',
  'validateEscalationArgs',
  'approveEscalation',
])

/** The required exports missing (or mis-shapen) on `h`; `[]` when usable. */
export function missingSandboxHelpers(h) {
  if (h === undefined || h === null) return [...REQUIRED_HELPERS]
  return REQUIRED_HELPERS.filter((name) =>
    name === 'ESCALATION_TARGETS' ? !Array.isArray(h[name]) : typeof h[name] !== 'function',
  )
}

/** Upstream does not export this text; dsh-tool-pwsh keeps its own copy too. */
export const runnerFailureMarker = (mode) =>
  `[sandbox: the sandbox runner itself failed under ${mode} mode — ` +
  'the command did not run; this is a sandbox problem, not a command failure]'

const sessionArg = (exec) => (exec.agent === undefined ? {} : { session: exec.agent.session })

/** The standing per-call policy, or undefined when no policy service is composed. */
export function standingPolicy(ctx, exec) {
  return ctx.get('sandboxPolicy')?.resolve(sessionArg(exec))
}

/**
 * Everything the tool needs about the sandbox, computed once at registration.
 * `h` is the imported module (undefined when it cannot be loaded or lacks a
 * required export), so every later call is synchronous and testable with a
 * fake `h`. `available` is the registration-time service fact: the narrow
 * window where both sandbox services disappear before the replacement
 * registration lands must still fail closed instead of running unconfined.
 */
export function sandboxSupport(ctx, h) {
  const usable = h !== undefined && missingSandboxHelpers(h).length === 0
  const available = ctx.get('sandbox') !== undefined && ctx.get('sandboxPolicy') !== undefined
  const escalationModes = usable && available ? [...h.ESCALATION_TARGETS] : []
  return {
    h: usable ? h : undefined,
    available,
    escalationModes,
    notes: (sandbox) => (usable ? notesFor(h, sandbox, escalationModes) : []),
  }
}

/** The model-facing markers for one settled fact set. Sync, helper-bound. */
export function notesFor(h, sandbox, escalationModes = []) {
  if (sandbox?.runnerFailed === true) return [runnerFailureMarker(sandbox.mode)]
  if (sandbox?.denied !== true) return []
  const notes = [h.sandboxDenialMarker(sandbox.mode)]
  if (escalationModes.length > 0) notes.push(h.escalationHintMarker('command'))
  return notes
}

/**
 * Validate the pair and, when requested, approve one strictly wider mode.
 * Returns the approved mode, or undefined when no escalation was requested.
 *
 * A same-mode retry is free and needs no justification — that short-circuit
 * MUST run before validateEscalationArgs (dsh-tool-bash/src/index.ts:86-90),
 * and an empty justification without sandbox_permissions is normalized away.
 * Ordinary calls (neither field) return before touching `h`, so a composition
 * that cannot load the helpers still runs them (U2).
 */
export async function approveRequestedMode(ctx, exec, args, standing, support) {
  if (args.sandbox_permissions !== undefined && args.sandbox_permissions === standing?.mode) return undefined
  const justification =
    args.sandbox_permissions === undefined && args.justification?.trim() === '' ? undefined : args.justification
  if (args.sandbox_permissions === undefined && justification === undefined) return undefined
  const h = support?.h
  if (h === undefined) {
    // No sandbox package at all: the composition cannot escalate. The schema does
    // not expose these parameters here, so this is an out-of-schema call.
    throw new Error('sandbox_permissions is not available in this composition (no sandbox backend to escalate)')
  }
  h.validateEscalationArgs(args.sandbox_permissions, justification)
  if (args.sandbox_permissions === undefined) return undefined
  if (standing === undefined || support.escalationModes.length === 0) {
    throw new h.SandboxEscalationError(
      'sandbox_permissions is not available in this composition (no sandboxPolicy to escalate from)',
      'SANDBOX_ESCALATION_UNAVAILABLE',
    )
  }
  return h.approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      justification,
      effectiveMode: standing.mode,
      subject: 'command',
    },
    {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName: 'niubash',
      signal: exec.signal,
    },
  )
}

/**
 * Wrap the niu argv, or return undefined for danger-full-access / no policy.
 * Fail closed twice over: a composition that mounts ctx.sandbox without
 * ctx.sandboxPolicy never runs unconfined, and a confined mode with no usable
 * backend or no loadable helpers throws instead of running.
 *
 * Execution never imports: `support.h` comes from registration (D9). A missing
 * `h` means the sandbox package is not loadable at all, so plain Error is the
 * honest failure (we cannot even construct SandboxUnavailableError).
 */
export async function confineArgv(ctx, policy, argv, signal, support) {
  if (policy === undefined) {
    if (ctx.get('sandbox') !== undefined) {
      throw new Error(
        'niubash: this composition mounts ctx.sandbox without ctx.sandboxPolicy; refusing to run the command unconfined',
      )
    }
    // Both services were composed when this tool was registered, so a policy
    // that vanished mid-call is a teardown race, not an unconfined composition.
    if (support?.available === true) {
      throw new Error(
        'niubash: the sandbox services this tool was registered under are no longer composed; refusing to run the command unconfined',
      )
    }
  }
  if (policy === undefined || policy.mode === 'danger-full-access') return undefined
  const h = support?.h
  if (h === undefined) {
    throw new Error(
      `niubash: the "${policy.mode}" sandbox is requested but @deepseek-ai/dsh-sandbox is not loadable; refusing to run the command unconfined`,
    )
  }
  const sandbox = ctx.get('sandbox')
  if (sandbox === undefined) throw new h.SandboxUnavailableError(policy.mode)
  return sandbox.confine(argv, policy, signal)
}

/**
 * Facts for one settled run plus the runner-failure detail that outranks a
 * denial (the command never ran). Sync: `wrap` exists only when confine ran,
 * which means the helpers were already loaded.
 */
export function classifySettled(result, wrap, policy, support) {
  if (wrap === undefined) {
    return { sandbox: policy === undefined ? undefined : { mode: policy.mode, denied: false } }
  }
  const runnerFailure = support.h.classifyRunnerFailure(result.exitCode, result.stderr.text, wrap.runnerFailureRules)
  const base = { mode: policy.mode, enforcement: wrap.enforcement }
  if (runnerFailure !== undefined) return { sandbox: { ...base, denied: false, runnerFailed: true }, runnerFailure }
  const denied = support.h.matchesSignature(result.exitCode, result.stderr.text, wrap.denialSignatures)
  return { sandbox: { ...base, denied } }
}

/** The foreground projection: a runner failure is an error, not a result. */
export function foregroundFacts(result, wrap, policy, support) {
  const { sandbox, runnerFailure } = classifySettled(result, wrap, policy, support)
  if (runnerFailure !== undefined) throw new support.h.SandboxUnavailableError(policy.mode, runnerFailure.detail)
  return { result, sandbox }
}

/** A spawn failure is the runner's own fault when the executable that could not start is the runner. */
export function sandboxStartupFailure(error, sandbox, workdir) {
  const { wrap, policy, support } = sandbox ?? {}
  if (wrap === undefined || support?.h === undefined) return undefined
  if (!support.h.isRunnerSpawnFailure(error, wrap.argv[0], workdir)) return undefined
  return new support.h.SandboxUnavailableError(policy.mode, String(error))
}

/** The note appended to a background job's `detail` (D6): runner failure, or denial. */
export function jobDetailNote(result, sandbox) {
  const { wrap, policy, support } = sandbox ?? {}
  if (support?.h === undefined) return ''
  const facts = classifySettled(result, wrap, policy, support).sandbox
  return facts === undefined ? '' : support.notes(facts).join(' ')
}

/** The note for a job whose process never started (spawn failure). */
export function spawnFailureNote(error, sandbox, workdir) {
  const { wrap, policy, support } = sandbox ?? {}
  if (wrap === undefined || support?.h === undefined) return ''
  if (!support.h.isRunnerSpawnFailure(error, wrap.argv[0], workdir)) return ''
  return support.notes({ mode: policy.mode, denied: false, enforcement: wrap.enforcement, runnerFailed: true }).join(' ')
}
