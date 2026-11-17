/**
 * End-to-end smoke test against the real niu.exe through lib/process.js —
 * the same process layer the DSH tool uses, without needing a DSH runtime.
 *
 * Skips (exit 0) when Niubash is absent; SMOKE_REQUIRED=1 turns the skip into
 * a failure. Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveNiu } from '../lib/niu.js'
import { spawnNiu } from '../lib/process.js'
import { renderNiubashResult } from '../lib/render.js'
import { buildEnv } from '../lib/util.js'

const resolution = resolveNiu()
if (!resolution.found) {
  const message = 'Niubash (niu.exe) not found; skipping smoke test. Install Niubash or set DSH_NIUBASH_PATH.'
  if (process.env.SMOKE_REQUIRED === '1') {
    console.error(message)
    process.exit(1)
  }
  console.log(message)
  process.exit(0)
}

const niuPath = resolution.path
console.log(`smoke: using ${niuPath} (source: ${resolution.source})`)

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok - ${name}`)
  } catch (error) {
    console.error(`  FAIL - ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

const run = (command, extra = {}) =>
  spawnNiu({
    niuPath,
    command,
    workdir: process.cwd(),
    env: buildEnv({}),
    timeoutMs: 30000,
    ...extra,
  })

await check('echo + exit 0', async () => {
  const result = await run('echo hello-niubash').result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.match(result.stdout.text, /hello-niubash/)
})

await check('non-zero exit is a result, not a rejection', async () => {
  const result = await run('exit 7').result()
  assert.equal(result.exitCode, 7)
  const text = renderNiubashResult({ ...result, timeoutMs: 30000 })
  assert.match(text, /\[exit code: 7\]$/)
})

await check('stderr is captured separately', async () => {
  const result = await run('echo to-out; echo to-err 1>&2').result()
  assert.match(result.stdout.text, /to-out/)
  assert.match(result.stderr.text, /to-err/)
  const text = renderNiubashResult({ ...result, timeoutMs: 30000 })
  assert.match(text, /\[stderr\]\nto-err/)
})

await check('CJK output is UTF-8 clean', async () => {
  const result = await run('echo 你好，世界！🐂').result()
  assert.match(result.stdout.text, /你好，世界！🐂/)
})

await check('workdir is honored', async () => {
  const result = await run('pwd', { workdir: tmpdir() }).result()
  // pwd prints the POSIX dialect (/c/...); compare resolved shapes, not strings.
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout.text.trim(), /^\/[a-z]\//i)
  const win = await run('cygpath -w "$(pwd)"', { workdir: tmpdir() }).result()
  assert.equal(win.exitCode, 0)
  assert.ok(win.stdout.text.toLowerCase().startsWith(tmpdir().toLowerCase().slice(0, 3)))
})

await check('environment passes through (managed + custom)', async () => {
  const result = await run('echo "$DSH_SMOKE_VAR:$NO_COLOR"', { env: buildEnv({ DSH_SMOKE_VAR: 'managed-ok' }) }).result()
  assert.match(result.stdout.text, /managed-ok:1/)
})

await check('pipes, loops, and command substitution work', async () => {
  const result = await run('for i in 1 2 3; do echo "n$i"; done | wc -l').result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text.trim(), '3')
})

await check('timeout kills the tree and reports timedOut', async () => {
  const started = Date.now()
  const result = await run('sleep 30', { timeoutMs: 800 }).result()
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 10000, 'timeout kill should settle quickly')
  const text = renderNiubashResult({ ...result, timeoutMs: 800 })
  assert.match(text, /\[timed out after 800ms\]/)
})

await check('caller abort kills the process', async () => {
  const controller = new AbortController()
  const proc = run('sleep 30', { timeoutMs: 0, signal: controller.signal })
  setTimeout(() => controller.abort(), 300)
  const result = await proc.result()
  assert.equal(result.aborted, true)
})

await check('overflow truncates to the tail and spills the full output', async () => {
  const proc = run('for i in $(seq 1 3000); do echo "line-$i-0123456789"; done', { maxOutputBytes: 4000 })
  const result = await proc.result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.truncated, true)
  assert.ok(result.stdout.spillPath, 'spill path reported')
  assert.ok(existsSync(result.stdout.spillPath), 'spill file exists')
  const full = readFileSync(result.stdout.spillPath, 'utf8')
  assert.match(full, /^line-1-/)
  assert.match(full, /line-3000-/)
  assert.match(result.stdout.text, /line-3000-/)
  assert.doesNotMatch(result.stdout.text, /^line-1-/)
  const text = renderNiubashResult({ ...result, timeoutMs: 30000 })
  assert.match(text, /\[output truncated; full output: /)
})

await check('live offset reads stream output; kill settles the handle', async () => {
  const proc = run('for i in $(seq 1 5); do echo "chunk-$i"; sleep 0.2; done; sleep 30', { timeoutMs: 0 })
  // Wait until some output exists, then read incrementally without consuming.
  let read = proc.observed.stdout.readFrom(0)
  const deadline = Date.now() + 5000
  while (read.nextOffset === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    read = proc.observed.stdout.readFrom(0)
  }
  assert.ok(read.nextOffset > 0, 'output arrived')
  assert.match(read.text, /chunk-1/)
  const again = proc.observed.stdout.readFrom(0)
  assert.equal(again.text, read.text, 'reads are non-consuming')
  proc.kill('smoke kill')
  await proc.done
  assert.equal(proc.wasKilled(), true)
  assert.equal(proc.killReason(), 'smoke kill')
})

await check('a missing niu.exe rejects result() with a spawn error', async () => {
  const proc = spawnNiu({
    niuPath: join(tmpdir(), 'definitely-missing-niu.exe'),
    command: 'echo x',
    workdir: process.cwd(),
    env: buildEnv({}),
    timeoutMs: 5000,
  })
  await assert.rejects(() => proc.result(), (error) => error.code === 'ENOENT')
})

await check('bash state does not persist between calls', async () => {
  await run('export SMOKE_STATE=kept; cd /tmp').result()
  const result = await run('echo "${SMOKE_STATE:-unset}"').result()
  assert.match(result.stdout.text, /unset/)
})

console.log(`smoke: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)