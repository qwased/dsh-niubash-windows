/**
 * Real-machine integration for the DSH Windows sandbox adaptation.
 *
 * Gated: runs only when DSH_SANDBOX_IT=1 on Windows with a real DSH install
 * and a real niu.exe. It exercises the actual Windows ACL seam
 * (`ctx.sandbox.confine()`), the runner failure dialect, and the plugin's tool
 * layer against that seam.
 *
 *   DSH_SANDBOX_IT=1 node test/sandbox.integration.mjs
 *
 * I1–I9 follow PLAN-sandbox-adaptation.md §8.2; T0–T16 are the tool-layer
 * checks that `npm test` cannot host (lib/tool.js needs @deepseek-ai/dsh-tools,
 * which a bare checkout does not have); R1–R4 drive the real cordis
 * registration lifecycle against a fake `tools` service. The DSH packages are
 * imported from the installation below, and a resolve hook routes the plugin's
 * bare `@deepseek-ai/*` imports to that same installation, so no node_modules
 * is created inside this repository.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveNiu } from '../lib/niu.js'
import { MAX_COMMAND_CHARS } from '../lib/prompt.js'
import { buildEnv, commandLineFits, commandLineLength } from '../lib/util.js'

if (process.env.DSH_SANDBOX_IT !== '1') {
  console.log('sandbox integration: skipped (set DSH_SANDBOX_IT=1 to run)')
  process.exit(0)
}
if (process.platform !== 'win32') {
  console.log('sandbox integration: skipped (Windows only)')
  process.exit(0)
}

const DSH =
  process.env.DSH_INSTALL_PATH ??
  join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const PACKAGES = join(DSH, 'node_modules', '@deepseek-ai')
const REQUIRED = [
  'dsh-sandbox/lib/index.js',
  'dsh-sandbox-local/lib/index.js',
  'dsh-sandbox-windows-acl/lib/runner.js',
  'cordis/lib/index.js',
]
for (const relative of REQUIRED) {
  if (!existsSync(join(PACKAGES, relative))) {
    console.error(`sandbox integration: DSH install not found at ${DSH} (missing ${relative})`)
    process.exit(1)
  }
}

const resolution = resolveNiu()
if (!resolution.found) {
  console.error('sandbox integration: niu.exe not found; install Niubash or set DSH_NIUBASH_PATH')
  process.exit(1)
}
const niuPath = resolution.path
console.log(`sandbox integration: DSH=${DSH}\nsandbox integration: niu=${niuPath}`)

// The plugin's bare imports must resolve to the installation's copies; the
// repository intentionally has no node_modules.
const dshRequire = createRequire(join(DSH, 'package.json'))
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      try {
        return { url: pathToFileURL(dshRequire.resolve(specifier)).href, shortCircuit: true }
      } catch {
        // Fall through to the default resolver for packages the DSH tree lacks.
      }
    }
    return nextResolve(specifier, context)
  },
})

const { LocalSandboxProvider } = await import(
  pathToFileURL(join(PACKAGES, 'dsh-sandbox-local/lib/index.js')).href
)
const { Context } = await import(pathToFileURL(join(PACKAGES, 'cordis/lib/index.js')).href)
const h = await import(pathToFileURL(join(PACKAGES, 'dsh-sandbox/lib/index.js')).href)
const { buildNiubashTool } = await import('../lib/tool.js')
const { sandboxSupport } = await import('../lib/sandbox.js')
// The plugin entry needs the resolve hook above (it imports @deepseek-ai/* at
// module scope), so it is loaded dynamically here, not with a static import.
const index = await import('../index.js')

// One provider for the whole run: workspace-write grants are cached per
// provider lifetime, exactly as the plugin's session path uses them.
const root = mkdtempSync(join(tmpdir(), 'niubash-it-'))
const ws = join(root, 'ws')
mkdirSync(ws, { recursive: true })
const outside = join(root, 'outside.txt')
const toBashPath = (path) => path.replaceAll('\\', '/')

const serviceCtx = new Context()
const provider = new LocalSandboxProvider(serviceCtx, {
  runnerCommand: [],
  runnerFailureSignatures: [],
  probeTimeoutMs: 5000,
})

const signal = new AbortController().signal
const policy = (mode, sessionId = 'it-session') => ({
  mode,
  workspaceRoot: ws,
  ...(sessionId === undefined ? {} : { sessionId }),
})
const confine = (mode, argv, sessionId) => provider.confine(argv, policy(mode, sessionId), signal)

function runArgv(argv, { cwd = ws, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: buildEnv({}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      try {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
      } catch {
        // already gone
      }
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (buffer) => (stdout += buffer))
    child.stderr.on('data', (buffer) => (stderr += buffer))
    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ error, stdout, stderr })
      }
    })
    child.on('close', (exitCode) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ exitCode, stdout, stderr })
      }
    })
  })
}

const niu = (script) => [niuPath, '-c', script]
const runConfined = async (mode, script, options) => {
  const wrap = await confine(mode, niu(script))
  return { wrap, ...(await runArgv(wrap.argv, options)) }
}

const failures = []
async function check(id, title, fn) {
  try {
    const detail = await fn()
    console.log(`ok - ${id} ${title}${detail === undefined ? '' : `: ${detail}`}`)
  } catch (error) {
    failures.push(`${id} ${title}`)
    console.error(`FAIL - ${id} ${title}`)
    console.error(error)
  }
}

// ------------------------------------------------------------ I1–I9

await check('I1', 'workspace-write echo ok', async () => {
  const { exitCode, stdout, stderr } = await runConfined('workspace-write', 'echo ok')
  assert.equal(exitCode, 0)
  assert.match(stdout, /ok/)
  assert.doesNotMatch(stderr, /file access denied|permission denied/i)
  // S3: the workspace ROOT itself is writable, not only directories below it.
  const rootFile = join(ws, 'in-ws.txt')
  const workspaceWrite = await runConfined('workspace-write', `echo inside > "${toBashPath(rootFile)}"`)
  assert.equal(workspaceWrite.exitCode, 0, `workspace root write failed: ${workspaceWrite.stderr}`)
  assert.equal(readFileSync(rootFile, 'utf8').trim(), 'inside')
})

await check('I2', 'workspace-write denies a write outside the workspace', async () => {
  const { exitCode, stderr } = await runConfined('workspace-write', `echo x > "${toBashPath(outside)}"`)
  assert.notEqual(exitCode, 0)
  assert.match(stderr, /permission denied/i)
  assert.equal(existsSync(outside), false)
})

await check('I3', 'workspace-write $TMP is a private writable dsh-* directory', async () => {
  const { exitCode, stdout } = await runConfined(
    'workspace-write',
    'printf t > "$TMP/it.txt" && echo "TMP=$TMP" && echo wrote-ok',
  )
  assert.equal(exitCode, 0)
  assert.match(stdout, /TMP=.*dsh-/i)
  assert.match(stdout, /wrote-ok/)
})

await check('I4', 'pipes and child processes work confined', async () => {
  const { exitCode, stdout } = await runConfined(
    'workspace-write',
    'printf "a\\nb\\n" | grep b >/dev/null && git --version >/dev/null && echo chain-ok',
  )
  assert.equal(exitCode, 0)
  assert.match(stdout, /chain-ok/)
})

await check('I5', 'the runner reports its own failure as 127 + windows-acl-run:', async () => {
  const runner = join(PACKAGES, 'dsh-sandbox-windows-acl/lib/runner.js')
  const missing = join(root, 'no-such-workspace')
  const result = spawnSync(
    process.execPath,
    [runner, '--workspace', missing, '--temp', tmpdir(), '--mode', 'workspace-write', '--', niuPath, '-c', 'echo never'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true },
  )
  assert.equal(result.status, 127)
  assert.match(result.stderr, /windows-acl-run: /)
})

await check('I6', 'read-only denies workspace and temp writes with the dialect', async () => {
  const workspaceWrite = await runConfined('read-only', `echo x > "${toBashPath(join(ws, 'ro.txt'))}"`)
  assert.notEqual(workspaceWrite.exitCode, 0)
  assert.match(workspaceWrite.stderr, /permission denied/i)
  assert.equal(existsSync(join(ws, 'ro.txt')), false)
  const tempWrite = await runConfined('read-only', 'printf t > "$TMP/ro.txt"')
  assert.notEqual(tempWrite.exitCode, 0)
  assert.match(tempWrite.stderr, /permission denied/i)
})

await check('I7', 'killing the runner kills the inner niu process tree', async () => {
  const wrap = await confine('workspace-write', niu('echo $$ > pid.txt; sleep 60'))
  const child = spawn(wrap.argv[0], wrap.argv.slice(1), {
    cwd: ws,
    env: buildEnv({}),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const closed = new Promise((resolve) => child.on('close', resolve))
  const pidFile = join(ws, 'pid.txt')
  const deadline = Date.now() + 10000
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(existsSync(pidFile), 'the inner command started')
  const innerPid = readFileSync(pidFile, 'utf8').trim()
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  await closed
  await new Promise((resolve) => setTimeout(resolve, 500))
  const listing = spawnSync('tasklist', ['/FI', `PID eq ${innerPid}`, '/NH'], { encoding: 'utf8' }).stdout
  assert.doesNotMatch(listing, new RegExp(`\\b${innerPid}\\b`))
})

await check('I8', 'real confine() returns the documented wrap shape', async () => {
  const workspaceWrap = await confine('workspace-write', niu('echo ok'))
  assert.equal(workspaceWrap.enforcement, 'partial')
  assert.equal(workspaceWrap.argv[0], process.execPath)
  const separator = workspaceWrap.argv.indexOf('--')
  assert.ok(separator > 0)
  assert.deepEqual(workspaceWrap.argv.slice(separator + 1), niu('echo ok'))
  assert.ok(workspaceWrap.argv.includes('--write-sid'))
  assert.ok(workspaceWrap.argv.includes('--temp-write-sid'))
  assert.ok(Array.isArray(workspaceWrap.denialSignatures) && workspaceWrap.denialSignatures.length > 0)
  assert.ok(Array.isArray(workspaceWrap.runnerFailureRules) && workspaceWrap.runnerFailureRules.length > 0)
  const workspacePrefix = workspaceWrap.argv.slice(0, separator).join(' ').length
  const readOnlyWrap = await confine('read-only', niu('echo ok'))
  const readOnlySeparator = readOnlyWrap.argv.indexOf('--')
  const readOnlyPrefix = readOnlyWrap.argv.slice(0, readOnlySeparator).join(' ').length
  assert.ok(workspacePrefix > readOnlyPrefix, `workspace prefix ${workspacePrefix} > read-only ${readOnlyPrefix}`)
  assert.ok(readOnlyPrefix < 400, `read-only prefix ${readOnlyPrefix} stays inside the §5.9 budget`)
  assert.ok(workspacePrefix < 600, `workspace prefix ${workspacePrefix} stays inside the §5.9 budget`)
  // P2-5: bind those width bounds to the real Windows budget. The exact argv is
  // only known after confine(), so measure it with the tool's own estimators: the
  // wrap must fit, and one command at the tool's MAX_COMMAND_CHARS cap must still
  // fit behind the real runner prefix (both limits share one 32767 budget).
  const measure = (wrap, label) => {
    const command = { program: wrap.argv[0], args: wrap.argv.slice(1) }
    assert.ok(commandLineFits(command), `the real ${label} wrap fits the Windows command line`)
    return commandLineLength([command.program, ...command.args])
  }
  const workspaceLine = measure(workspaceWrap, 'workspace-write')
  const readOnlyLine = measure(readOnlyWrap, 'read-only')
  // The worst case the tool can accept: a command at its MAX_COMMAND_CHARS cap
  // behind the real runner prefix, exactly as confine() would spell it.
  const cappedCommand = {
    program: workspaceWrap.argv[0],
    args: [...workspaceWrap.argv.slice(1, separator + 1), niuPath, '-c', 'x'.repeat(MAX_COMMAND_CHARS)],
  }
  const cappedLine = commandLineLength([cappedCommand.program, ...cappedCommand.args])
  assert.ok(
    commandLineFits(cappedCommand),
    `a ${MAX_COMMAND_CHARS}-char command still fits behind the real prefix (${cappedLine} chars)`,
  )
  return (
    `prefix read-only=${readOnlyPrefix} workspace=${workspacePrefix}; ` +
    `line read-only=${readOnlyLine} workspace=${workspaceLine} capped=${cappedLine}`
  )
})

await check('I8b', 'the escalation vocabulary comes from the real module', async () => {
  assert.deepEqual(h.ESCALATION_TARGETS, ['workspace-write', 'danger-full-access'])
  const support = sandboxSupport(
    { get: (name) => ({ sandbox: provider, sandboxPolicy: { resolve: () => policy('workspace-write') } })[name] },
    h,
  )
  assert.deepEqual(support.escalationModes, h.ESCALATION_TARGETS)
})

await check('I9', 'lib/render.js and lib/sandbox.js import without DSH packages', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'niubash-bare-'))
  const renderUrl = pathToFileURL(join(process.cwd(), 'lib', 'render.js')).href
  const sandboxUrl = pathToFileURL(join(process.cwd(), 'lib', 'sandbox.js')).href
  const script = `await import(${JSON.stringify(renderUrl)}); await import(${JSON.stringify(sandboxUrl)}); console.log('IMPORT-OK')`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: bare,
    encoding: 'utf8',
    env: { ...buildEnv({}), NODE_PATH: '' },
    timeout: 30000,
    windowsHide: true,
  })
  rmSync(bare, { recursive: true, force: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /IMPORT-OK/)
})

// ------------------------------------------------------------ T0–T16 (tool layer)

const fakeCtx = ({ mode, sandboxService = provider, approval, jobs }) => {
  const services = {
    sandbox: sandboxService,
    sandboxPolicy: { resolve: () => policy(mode) },
    approval,
    jobs,
    shellEnv: undefined,
  }
  return {
    get: (name) => services[name],
    logger: { warn: () => {} },
    workingDirectory: { ensure: async () => ws },
  }
}

const exec = {
  agent: { id: 'it-agent', session: { id: 'it-session' } },
  callId: 'it-call',
  signal,
}

const makeTool = (ctx) =>
  buildNiubashTool({
    ctx,
    config: {},
    niuPath,
    jobs: ctx.get('jobs'),
    support: sandboxSupport(ctx, h),
  })

function makeJobRegistry() {
  const records = new Map()
  let count = 0
  return {
    start(spec) {
      const id = `it-job-${++count}`
      records.set(id, { handle: spec.run() })
      return id
    },
    async wait(id) {
      await records.get(id).handle.done
      return { status: 'completed' }
    },
    read() {
      return { chunks: [], lossy: false, job: { output: {} } }
    },
    remove(id) {
      records.delete(id)
    },
    kill() {},
    outcome: async (id) => records.get(id).handle.done,
  }
}

await check('T0', 'tool: the danger-full-access baseline runs unwrapped', async () => {
  const tool = makeTool(fakeCtx({ mode: 'danger-full-access' }))
  const result = await tool.execute({ description: 'echo', command: 'echo ok' }, exec)
  assert.equal(result.kind, 'foreground')
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout.text, /ok/)
  // No confine() means no wrap at all: the sandbox fact carries no enforcement.
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
})

await check('T1', 'tool: workspace-write echo ok carries sandbox facts', async () => {
  const tool = makeTool(fakeCtx({ mode: 'workspace-write' }))
  const result = await tool.execute({ description: 'echo', command: 'echo ok' }, exec)
  assert.equal(result.kind, 'foreground')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', enforcement: 'partial', denied: false })
})

await check('T2', 'tool: a denial renders the marker and keeps [exit code] last', async () => {
  const tool = makeTool(fakeCtx({ mode: 'workspace-write' }))
  const result = await tool.execute(
    { description: 'write outside', command: `echo x > "${toBashPath(outside)}"` },
    exec,
  )
  assert.notEqual(result.exitCode, 0)
  assert.equal(result.sandbox.denied, true)
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /\[sandbox: file access denied under workspace-write mode\]/)
  assert.match(rendered, /escalation available/)
  assert.ok(rendered.trimEnd().endsWith(`[exit code: ${result.exitCode}]`), 'exit marker must stay last')
})

await check('T3', 'tool: a same-mode retry needs no justification or approval', async () => {
  let approvals = 0
  const tool = makeTool(
    fakeCtx({ mode: 'workspace-write', approval: { request: async () => (approvals += 1, 'rejected') } }),
  )
  const result = await tool.execute(
    { description: 'echo', command: 'echo retry', sandbox_permissions: 'workspace-write' },
    exec,
  )
  assert.equal(result.exitCode, 0)
  assert.equal(approvals, 0)
})

await check('T4', 'tool: an allowed-once escalation runs this call unconfined', async () => {
  const approval = { request: async () => 'allowed-once' }
  const tool = makeTool(fakeCtx({ mode: 'workspace-write', approval }))
  const target = join(root, 'escalated.txt')
  const result = await tool.execute(
    {
      description: 'write outside',
      command: `echo x > "${toBashPath(target)}"`,
      sandbox_permissions: 'danger-full-access',
      justification: 'the build must write outside the workspace',
    },
    exec,
  )
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  assert.equal(existsSync(target), true)
  rmSync(target, { force: true })
})

await check('T4b', 'tool: an allowed-once read-only escalation runs confined as workspace-write', async () => {
  let approvals = 0
  const approval = { request: async () => (approvals += 1, 'allowed-once') }
  const tool = makeTool(fakeCtx({ mode: 'read-only', approval }))
  const target = join(ws, 'escalated-inside.txt')
  const result = await tool.execute(
    {
      description: 'write inside the workspace',
      command: `echo escalated > "${toBashPath(target)}"`,
      sandbox_permissions: 'workspace-write',
      justification: 'the read-only session must write this file inside the workspace',
    },
    exec,
  )
  assert.equal(result.exitCode, 0)
  assert.equal(approvals, 1, 'the escalation asked the user exactly once')
  assert.equal(result.sandbox.mode, 'workspace-write')
  assert.equal(result.sandbox.denied, false)
  assert.equal(readFileSync(target, 'utf8').trim(), 'escalated')
  rmSync(target, { force: true })
})

await check('T5', 'tool: a rejected escalation throws and never runs the command', async () => {
  const marker = join(root, 'rejected.txt')
  const tool = makeTool(fakeCtx({ mode: 'workspace-write', approval: { request: async () => 'rejected' } }))
  await assert.rejects(
    tool.execute(
      {
        description: 'write outside',
        command: `echo x > "${toBashPath(marker)}"`,
        sandbox_permissions: 'danger-full-access',
        justification: 'need to write outside',
      },
      exec,
    ),
    (error) => error.code === 'SANDBOX_ESCALATION_REJECTED',
  )
  assert.equal(existsSync(marker), false)
})

await check('T5b', 'tool: a cancelled escalation throws SANDBOX_ESCALATION_CANCELLED', async () => {
  const marker = join(root, 'cancelled.txt')
  const tool = makeTool(fakeCtx({ mode: 'workspace-write', approval: { request: async () => 'cancelled' } }))
  await assert.rejects(
    tool.execute(
      {
        description: 'write outside',
        command: `echo x > "${toBashPath(marker)}"`,
        sandbox_permissions: 'danger-full-access',
        justification: 'need to write outside',
      },
      exec,
    ),
    (error) => error.code === 'SANDBOX_ESCALATION_CANCELLED',
  )
  assert.equal(existsSync(marker), false)
})

await check('T5c', 'tool: an escalation without an approval service is UNAVAILABLE', async () => {
  const marker = join(root, 'unavailable.txt')
  const tool = makeTool(fakeCtx({ mode: 'workspace-write', approval: undefined }))
  await assert.rejects(
    tool.execute(
      {
        description: 'write outside',
        command: `echo x > "${toBashPath(marker)}"`,
        sandbox_permissions: 'danger-full-access',
        justification: 'need to write outside',
      },
      exec,
    ),
    (error) => error.code === 'SANDBOX_ESCALATION_UNAVAILABLE',
  )
  assert.equal(existsSync(marker), false)
})

await check('T6', 'tool: danger-full-access asking for workspace-write is INVALID', async () => {
  const tool = makeTool(fakeCtx({ mode: 'danger-full-access' }))
  await assert.rejects(
    tool.execute(
      {
        description: 'echo',
        command: 'echo x',
        sandbox_permissions: 'workspace-write',
        justification: 'narrowing is not an escalation',
      },
      exec,
    ),
    (error) => error.code === 'SANDBOX_ESCALATION_INVALID_ARGUMENT',
  )
})

await check('T7', 'tool: a missing runner maps to SANDBOX_UNAVAILABLE', async () => {
  const missingRunner = join(root, 'missing-runner.exe')
  const fakeWrap = {
    argv: [missingRunner, '--', 'x'],
    enforcement: 'partial',
    denialSignatures: ['permission denied'],
    runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
  }
  const tool = makeTool(
    fakeCtx({ mode: 'workspace-write', sandboxService: { confine: async () => fakeWrap } }),
  )
  await assert.rejects(
    tool.execute({ description: 'echo', command: 'echo x' }, exec),
    (error) => error.code === 'SANDBOX_UNAVAILABLE',
  )
})

await check('T7b', 'tool: a foreground-as-job call with a missing runner maps to SANDBOX_UNAVAILABLE', async () => {
  // S11 path ②: with a jobs registry the foreground call is a job, so the
  // spawn failure surfaces through proc.result() inside waitOnJob, not spawnNiu.
  const jobs = makeJobRegistry()
  const missingRunner = join(root, 'missing-runner-foreground.exe')
  const fakeWrap = {
    argv: [missingRunner, '--', 'x'],
    enforcement: 'partial',
    denialSignatures: ['permission denied'],
    runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
  }
  const tool = makeTool(
    fakeCtx({ mode: 'workspace-write', jobs, sandboxService: { confine: async () => fakeWrap } }),
  )
  await assert.rejects(
    tool.execute({ description: 'missing runner', command: 'echo never' }, exec),
    (error) => error.code === 'SANDBOX_UNAVAILABLE',
  )
})

await check('T8', 'tool: foreground-as-job keeps the facts', async () => {
  const jobs = makeJobRegistry()
  const tool = makeTool(fakeCtx({ mode: 'workspace-write', jobs }))
  const result = await tool.execute({ description: 'echo', command: 'echo via-job' }, exec)
  assert.equal(result.kind, 'foreground')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', enforcement: 'partial', denied: false })
})

await check('T9', 'tool: a background denial lands in the job detail', async () => {
  const jobs = makeJobRegistry()
  const tool = makeTool(fakeCtx({ mode: 'workspace-write', jobs }))
  const started = await tool.execute(
    { description: 'write outside', command: `echo x > "${toBashPath(outside)}"`, run_in_background: true },
    exec,
  )
  assert.equal(started.kind, 'background')
  const outcome = await jobs.outcome(started.jobId)
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.detail, /exit code: \d+; .*file access denied under workspace-write mode/)
})

await check('T10', 'tool: a background runner failure keeps status and marks the detail', async () => {
  const jobs = makeJobRegistry()
  const runnerFailureWrap = {
    argv: [process.execPath, '-e', "console.error('windows-acl-run: boom'); process.exit(127)"],
    enforcement: 'partial',
    denialSignatures: [],
    runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
  }
  const tool = makeTool(
    fakeCtx({ mode: 'workspace-write', jobs, sandboxService: { confine: async () => runnerFailureWrap } }),
  )
  const started = await tool.execute({ description: 'runner failure', command: 'echo x', run_in_background: true }, exec)
  const outcome = await jobs.outcome(started.jobId)
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.detail, /sandbox runner itself failed under workspace-write mode/)
})

/** A registry whose wait always reports running, so the caller takes the promotion path. */
function makePromotingJobRegistry() {
  const base = makeJobRegistry()
  return {
    ...base,
    async wait() {
      return { status: 'running' }
    },
    read() {
      return { chunks: [{ channel: 'stdout', text: 'promote\n' }], lossy: false, job: { output: {} } }
    },
  }
}

await check('T11', 'tool: a foreground timeout promotes the command to a background job', async () => {
  const jobs = makePromotingJobRegistry()
  const tool = makeTool(fakeCtx({ mode: 'workspace-write', jobs }))
  const result = await tool.execute({ description: 'promote', command: 'echo promote', timeoutMs: 1 }, exec)
  assert.equal(result.kind, 'promoted')
  assert.match(result.jobId, /^it-job-\d+$/)
  assert.equal(result.timeoutMs, 1)
  assert.equal(result.cwd, ws)
  assert.equal(typeof result.output, 'string')
  assert.equal(result.output, 'promote\n', 'the promoted result carries the output read so far')
  // Drain the still-registered record so its process settles before cleanup.
  await jobs.outcome(result.jobId)
})

await check('T13', 'tool: a background spawn failure marks the job failed with the runner note', async () => {
  // S11 path ③: the job record exists before spawn, so the failure lands in
  // its outcome detail instead of throwing from the tool call.
  const jobs = makeJobRegistry()
  const missingRunner = join(root, 'missing-runner-bg.exe')
  const spawnFailureWrap = {
    argv: [missingRunner, '--', 'x'],
    enforcement: 'partial',
    denialSignatures: ['permission denied'],
    runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
  }
  const tool = makeTool(
    fakeCtx({ mode: 'workspace-write', jobs, sandboxService: { confine: async () => spawnFailureWrap } }),
  )
  const started = await tool.execute(
    { description: 'missing runner', command: 'echo never', run_in_background: true },
    exec,
  )
  assert.equal(started.kind, 'background')
  const outcome = await jobs.outcome(started.jobId)
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /missing-runner-bg\.exe/)
  assert.match(outcome.detail, /sandbox runner itself failed under workspace-write mode/)
})

await check('T14', 'tool: sandbox_permissions documents the real module text', async () => {
  const tool = makeTool(fakeCtx({ mode: 'workspace-write' }))
  const parameter = tool.parameters.properties.sandbox_permissions
  assert.ok(parameter !== undefined, 'the escalation parameter is advertised when a sandbox is composed')
  assert.equal(parameter.description, h.sandboxPermissionsDescription('command'))
  // No sandbox backend means no escalation lever: the parameter must be absent.
  // (`fakeCtx` defaults sandboxService to the provider, so build the bare ctx.)
  const withoutSandbox = makeTool({
    get: (name) => (name === 'sandboxPolicy' ? { resolve: () => policy('workspace-write') } : undefined),
    logger: { warn() {} },
    workingDirectory: { ensure: async () => ws },
  })
  assert.equal(withoutSandbox.parameters.properties.sandbox_permissions, undefined)
})

await check('T15', 'tool: approval and confine failures are logged with mode, code, and callId', async () => {
  const approvalWarnings = []
  const rejected = fakeCtx({ mode: 'workspace-write', approval: { request: async () => 'rejected' } })
  rejected.logger = { warn: (message) => approvalWarnings.push(message) }
  await assert.rejects(
    makeTool(rejected).execute(
      {
        description: 'write outside',
        command: `echo x > "${toBashPath(join(root, 'logged-rejected.txt'))}"`,
        sandbox_permissions: 'danger-full-access',
        justification: 'need to write outside',
      },
      exec,
    ),
    (error) => error.code === 'SANDBOX_ESCALATION_REJECTED',
  )
  assert.equal(approvalWarnings.length, 1, `expected one approval warning, got ${JSON.stringify(approvalWarnings)}`)
  assert.match(
    approvalWarnings[0],
    /escalation approval failed \(mode: workspace-write, code: SANDBOX_ESCALATION_REJECTED, callId: it-call\)/,
  )

  const confineWarnings = []
  const failing = fakeCtx({
    mode: 'workspace-write',
    sandboxService: {
      confine: async () => {
        throw Object.assign(new Error('prepare failed'), { code: 'SANDBOX_PREPARATION_FAILED' })
      },
    },
  })
  failing.logger = { warn: (message) => confineWarnings.push(message) }
  await assert.rejects(
    makeTool(failing).execute({ description: 'echo', command: 'echo x' }, exec),
    (error) => error.code === 'SANDBOX_PREPARATION_FAILED',
  )
  assert.equal(confineWarnings.length, 1, `expected one confine warning, got ${JSON.stringify(confineWarnings)}`)
  assert.match(
    confineWarnings[0],
    /sandbox confine failed \(mode: workspace-write, code: SANDBOX_PREPARATION_FAILED, callId: it-call\)/,
  )
  const logText = [...approvalWarnings, ...confineWarnings].join(' ')
  assert.doesNotMatch(logText, /it-session/, 'audit logs must not carry the session id')
})

await check('T16', 'tool: a background call with no jobs fails before approval or confine', async () => {
  // P2-6: a call that cannot start must not disturb the user or prepare the host.
  let approvals = 0
  let confinements = 0
  const tool = makeTool(
    fakeCtx({
      mode: 'workspace-write',
      jobs: undefined,
      approval: { request: async () => (approvals += 1, 'allowed-once') },
      sandboxService: {
        async confine(argv) {
          confinements += 1
          return { argv, enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }
        },
      },
    }),
  )
  await assert.rejects(
    tool.execute(
      {
        description: 'bg',
        command: 'echo x',
        run_in_background: true,
        sandbox_permissions: 'danger-full-access',
        justification: 'need it',
      },
      exec,
    ),
    (error) => error.message.includes('background jobs unavailable'),
  )
  assert.equal(approvals, 0, 'the user must not be asked about a call that cannot start')
  assert.equal(confinements, 0, 'confine must not run for a call that cannot start')
})

// ------------------------------------------------------------ R1–R4 (registration lifecycle)

// The unavailable-stub path needs neither niu.exe nor the sandbox helpers, so a
// missing path drives exactly the minimal composition from the P1-1 regression
// (no jobs, no sandbox/sandboxPolicy) without running a single real command.
const missingNiu = join(root, 'missing-niu.exe')
let registrationHosts = 0

/** A fresh cordis root with the three injected services faked and a tools recorder. */
function makeRegistrationHost() {
  const ctx = new Context()
  const registrations = []
  let live = 0
  ctx.provide('tools', {
    register(definition) {
      registrations.push(definition.name)
      live += 1
      return () => {
        live -= 1
      }
    },
  })
  ctx.provide('systemPrompt', { section() {} })
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
  const fiber = ctx.plugin(
    { name: `niubash-reg-${++registrationHosts}`, apply: index.apply, inject: index.inject },
    { niuPath: missingNiu, registerSkill: false },
  )
  return { ctx, registrations, fiber, live: () => live }
}

/** Poll a synchronous predicate: registrations settle on later ticks. */
async function waitUntil(condition, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(condition(), `${message} (waited ${timeoutMs}ms)`)
}

await check('R1', 'registration: the minimal composition registers the unavailable stub', async () => {
  const host = makeRegistrationHost()
  await host.fiber
  await waitUntil(() => host.registrations.length === 1, 'exactly one niubash registration')
  assert.deepEqual(host.registrations, ['niubash'])
  assert.equal(host.live(), 1)
  await host.fiber.dispose()
})

await check('R2', 'registration: a late jobs service replaces the registration', async () => {
  const host = makeRegistrationHost()
  await host.fiber
  await waitUntil(() => host.registrations.length === 1, 'baseline registration')
  host.ctx.provide('jobs', {})
  await waitUntil(() => host.registrations.length === 2, 're-registration after jobs appeared')
  assert.deepEqual(host.registrations, ['niubash', 'niubash'])
  assert.equal(host.live(), 1, 'the previous disposer ran before the replacement')
  await host.fiber.dispose()
})

await check('R3', 'registration: removing jobs re-registers and keeps one live tool', async () => {
  const host = makeRegistrationHost()
  await host.fiber
  await waitUntil(() => host.registrations.length === 1, 'baseline registration')
  const removeJobs = host.ctx.provide('jobs', {})
  await waitUntil(() => host.registrations.length === 2, 're-registration after jobs appeared')
  assert.equal(host.live(), 1)
  // The disposer settles once the injected fiber released the service; polling
  // the observable registration is the assertion, so its promise is not awaited.
  void Promise.resolve(removeJobs()).catch(() => {})
  await waitUntil(() => host.registrations.length === 3, 're-registration after jobs disappeared')
  assert.deepEqual(host.registrations, ['niubash', 'niubash', 'niubash'])
  assert.equal(host.live(), 1, 'the job-backed disposer was released')
  await host.fiber.dispose()
})

await check('R4', 'registration: disposing the plugin fiber removes the tool', async () => {
  const host = makeRegistrationHost()
  await host.fiber
  await waitUntil(() => host.registrations.length === 1, 'baseline registration')
  await host.fiber.dispose()
  await waitUntil(() => host.live() === 0, 'the registration was released')
  assert.equal(host.live(), 0)
  assert.deepEqual(host.registrations, ['niubash'], 'unload must not rebuild the tool')
})

// ------------------------------------------------------------ cleanup + report

try {
  provider.revokeAclGrants()
} catch (error) {
  console.error(`sandbox integration: grant cleanup failed: ${String(error)}`)
}
rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`sandbox integration: ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log('sandbox integration: all checks passed')
}
