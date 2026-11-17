/**
 * The `niubash` tool definition: schema, validation, execution, and the
 * `ctx.jobs` adaptation (background runs and foreground timeout promotion).
 *
 * The execution/job flow mirrors @deepseek-ai/dsh-tool-pwsh (MIT, DeepSeek
 * Harness) call-for-call where the contracts overlap, with a self-contained
 * Niubash process layer instead of the ctx.shell seam: the seam admits one
 * executor per composition, and on Windows that executor stays pwsh.
 */

import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import { spawnNiu } from './process.js'
import { renderNiubashResult, renderPromoted, renderJobRead, ringDelta } from './render.js'
import { describeStartupError, toolAborted, resolveWorkdir, buildEnv, workdirError, TOO_LONG_GUIDANCE } from './util.js'
import {
  TOOL_NAME,
  DESCRIPTION,
  UNAVAILABLE_DESCRIPTION,
  MAX_COMMAND_CHARS,
  unavailableMessage,
} from './prompt.js'

export { describeStartupError, resolveWorkdir, buildEnv } from './util.js'

function validateArgs(args) {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new ToolArgsError(['invalid command: expected a non-empty string'])
  }
  if (typeof args.description !== 'string' || args.description.trim().length === 0) {
    throw new ToolArgsError(['invalid description: expected a non-empty string'])
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new ToolArgsError([`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`])
  }
  if (args.command.length > MAX_COMMAND_CHARS) {
    throw new ToolArgsError([TOO_LONG_GUIDANCE])
  }
}

/** Parameter surface shared by the live tool and the unavailable stub. */
function parameters(background, promote) {
  return {
    description: {
      type: 'string',
      required: true,
      description:
        'Clear, concise description of what this command does in active voice, ' +
        '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; ' +
        '"git status" → "Show working tree status"; "npm test" → "Run the test suite".',
    },
    command: { type: 'string', required: true, description: 'The bash command to execute (bash syntax, not PowerShell).' },
    timeoutMs: {
      type: 'number',
      description: promote
        ? 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.'
        : 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
    },
    workdir: {
      type: 'string',
      description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
    },
    ...(background
      ? {
          run_in_background: {
            type: 'boolean',
            description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
          },
        }
      : {}),
  }
}

const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
  cwd: { type: 'string', required: true },
}

const PROMOTED_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'promoted' },
  cwd: { type: 'string', required: true },
  jobId: { type: 'string', required: true },
  timeoutMs: { type: 'number', required: true },
  output: { type: 'string', required: true },
}

const STREAM_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    spillPath: { type: 'string' },
  },
}

const FOREGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'foreground' },
  cwd: { type: 'string', required: true },
  exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
  signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
  timedOut: { type: 'boolean', required: true },
  aborted: { type: 'boolean', required: true },
  stopped: { type: 'string' },
  timeoutMs: { type: 'number', required: true },
  stdout: STREAM_OUTPUT_SCHEMA,
  stderr: STREAM_OUTPUT_SCHEMA,
}

/**
 * Build the live `niubash` tool.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {object} options.config - resolved plugin config.
 * @param {string} options.niuPath - resolved niu.exe path.
 * @param {object|undefined} options.jobs - the job registry when composed.
 */
export function buildNiubashTool({ ctx, config, niuPath, jobs }) {
  const backgroundEnabled = config.enableRunInBackground !== false
  const background = jobs !== undefined && backgroundEnabled
  const promote = background && config.promoteOnTimeout !== false
  const budgets = {
    maxOutputBytes: config.maxOutputBytes ?? 64000,
    maxSpillBytes: config.maxSpillBytes ?? 64 * 1024 * 1024,
    graceMs: config.graceMs ?? 3000,
  }
  const defaultTimeoutMs = config.timeoutMs ?? 120000
  const maxTimeoutMs = config.maxTimeoutMs ?? 600000

  /** Register the command as a job; the process spawns inside the starter, after admission. */
  const startJob = (registry, args, exec, spec) => {
    let proc
    let stopped
    const idleRead = (from) => ({ text: '', nextOffset: from, lossy: false })
    const id = registry.start({
      kind: 'niubash',
      label: args.command,
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      ...(exec.agent ? { owner: exec.agent.id } : {}),
      output: [
        { channel: 'stdout', read: (from) => (proc ? proc.observed.stdout.readFrom(from) : idleRead(from)) },
        { channel: 'stderr', read: (from) => (proc ? proc.observed.stderr.readFrom(from) : idleRead(from)) },
      ],
      run: () => {
        try {
          proc = spawnNiu(spec)
        } catch (error) {
          return {
            cancel: () => {},
            done: Promise.resolve({ status: 'failed', detail: error instanceof Error ? error.message : String(error) }),
          }
        }
        return {
          // A kill from outside this call (the human's, a parallel job_kill)
          // reaches the process here; its reason is what the model reads.
          cancel: (reason) => {
            stopped = reason ?? 'killed'
            proc.kill(stopped)
          },
          done: proc.done.then(() => {
            const spawnError = proc.spawnError()
            if (spawnError !== undefined) {
              return { status: 'failed', detail: spawnError instanceof Error ? spawnError.message : String(spawnError) }
            }
            if (proc.wasKilled()) {
              return { status: 'killed', detail: proc.killReason() ?? 'killed before exit' }
            }
            return { status: 'completed', detail: `exit code: ${proc.child.exitCode ?? 0}` }
          }),
        }
      },
    })
    return { id, process: () => proc, stopped: () => stopped }
  }

  /** Wait on a registered foreground command until it settles or the timeout passes. */
  const waitOnJob = async (registry, attached, exec, workdir, timeoutMs) => {
    const owner = exec.agent?.id
    /** Stop the job on this call's own account and stay until it settles. */
    const stop = async (reason) => {
      registry.kill(attached.id, owner, reason)
      const settled = await registry.wait(attached.id, timeoutMs, owner)
      if (settled.status !== 'running' && settled.status !== 'stopping') registry.remove(attached.id, owner)
      return settled
    }
    let view
    try {
      view = await registry.wait(attached.id, timeoutMs, owner, exec.signal)
    } catch {
      // The wait rejects only for the caller's abort: the command goes with the call.
      await stop('tool call aborted')
      throw toolAborted()
    }
    if (view.status === 'running' || view.status === 'stopping') {
      // The wait timed out: the job keeps running. One consuming read seeds the
      // result with the output so far, so job_output continues exactly after it.
      const read = registry.read(attached.id, owner)
      return {
        kind: 'promoted',
        cwd: workdir,
        jobId: attached.id,
        timeoutMs,
        output: renderJobRead(ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? []),
      }
    }
    // Settled while the call waited: the model never saw the id, so the record
    // leaves the registry with this result.
    registry.remove(attached.id, owner)
    const proc = attached.process()
    if (proc === undefined) {
      throw new Error(view.detail ?? 'niubash job failed before the process started')
    }
    let result
    try {
      result = await proc.result()
    } catch (error) {
      throw describeStartupError(error, niuPath)
    }
    const stopped = attached.stopped()
    return {
      kind: 'foreground',
      cwd: workdir,
      timeoutMs,
      ...result,
      ...(stopped !== undefined ? { stopped } : {}),
    }
  }

  return defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: parameters(background, promote),
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: BACKGROUND_OUTPUT_PROPERTIES },
          { type: 'object', additionalProperties: false, properties: PROMOTED_OUTPUT_PROPERTIES },
          { type: 'object', additionalProperties: false, properties: FOREGROUND_OUTPUT_PROPERTIES },
        ],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.kind === 'background'
              ? `started background job ${value.jobId}`
              : value.kind === 'promoted'
                ? renderPromoted(value)
                : renderNiubashResult(value),
        },
      ],
      presentationMeta: (_args, value) => ({ cwd: value.cwd }),
    },
    async execute(args, exec) {
      validateArgs(args)
      // niubash spawns with the harness authority and cannot enforce the file
      // sandbox; under a confining session policy, refuse instead of bypassing it.
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const policy = sandboxPolicy?.resolve(exec.agent ? { session: exec.agent.session } : {})
      if (policy !== undefined && policy.mode !== 'danger-full-access') {
        throw new Error(
          `niubash is disabled under the "${policy.mode}" sandbox because it runs commands unconfined; ` +
            'use the pwsh tool (it enforces the sandbox), or ask the user to switch this session to danger-full-access',
        )
      }
      if (exec.signal.aborted) throw toolAborted()
      const sessionCwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const workdir = resolveWorkdir(args.workdir, sessionCwd)
      // Refuse an unusable launch directory before any spawn or job admission,
      // so the model sees the real cause instead of a spawn-ENOENT guess.
      const wdProblem = workdirError(workdir)
      if (wdProblem !== undefined) throw new ToolArgsError([wdProblem])
      const timeoutMs = Math.min(args.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs)
      const spec = {
        niuPath,
        command: args.command,
        workdir,
        env: buildEnv(ctx.get('shellEnv')?.collect(exec)),
        ...budgets,
      }

      if (args.run_in_background === true) {
        // Undeclared keys are allowed, so schema omission also needs enforcement.
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        if (jobs === undefined) {
          throw new ToolContextUnavailableError('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        if (exec.signal.aborted) throw toolAborted()
        const started = startJob(jobs, args, exec, { ...spec, timeoutMs: 0, signal: undefined })
        return { kind: 'background', jobId: started.id, cwd: workdir }
      }

      // A foreground call is a job the tool waits on, so the command is visible
      // and killable from the moment it starts and outlives the wait when the
      // timeout passes. Admission refused at the start falls back to the
      // deadline kill, exactly as a composition without a registry does.
      if (jobs !== undefined && promote) {
        let attached
        try {
          attached = startJob(jobs, args, exec, { ...spec, timeoutMs: 0, signal: undefined })
        } catch (error) {
          ctx.logger?.warn?.(`niubash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`)
        }
        if (attached !== undefined) return waitOnJob(jobs, attached, exec, workdir, timeoutMs)
      }

      const proc = spawnNiu({ ...spec, timeoutMs, signal: exec.signal })
      let result
      try {
        result = await proc.result()
      } catch (error) {
        throw describeStartupError(error, niuPath)
      }
      if (result.aborted) throw toolAborted()
      return { kind: 'foreground', cwd: workdir, timeoutMs, ...result }
    },
    presentCall: (args) => {
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: args.description }],
        }
      }
      return {
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }
    },
    presentResult: (args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true
      const isPromoted = result.value?.kind === 'promoted'
      if (isBackground || isPromoted || result.isError) {
        return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
      }
      const { body, ...exit } = parseExitStatus(raw)
      return { card: 'terminal', output: body, ...exit }
    },
  })
}

/**
 * A same-schema stub for machines without a usable Niubash: every call fails
 * with the paths that were checked. It deliberately carries no preference
 * guidance — telling the model to prefer a tool that cannot run would be wrong.
 */
export function buildUnavailableTool({ failure }) {
  return defineTool({
    name: TOOL_NAME,
    description: UNAVAILABLE_DESCRIPTION,
    parameters: parameters(false, false),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: FOREGROUND_OUTPUT_PROPERTIES },
      render: (_args, value) => [{ type: 'text', text: renderNiubashResult(value) }],
    },
    async execute() {
      throw new Error(unavailableMessage(failure))
    },
  })
}