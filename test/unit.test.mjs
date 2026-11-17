/**
 * Unit tests for the pure modules: niu.exe resolution, prompt invariants,
 * stream capture, rendering, and helpers. No Niubash install or DSH runtime
 * needed. Run: node --test test/unit.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveNiu,
  isSupportedPlatform,
  hasUnexpandedVariable,
  pathCandidates,
  installDirectoryCandidates,
} from '../lib/niu.js'
import {
  TOOL_NAME,
  DESCRIPTION,
  PROMPT_SECTION,
  UNAVAILABLE_DESCRIPTION,
  UNAVAILABLE_SECTION,
  unavailableMessage,
} from '../lib/prompt.js'
import { StreamCapture } from '../lib/capture.js'
import { renderNiubashResult, renderPromoted, ringDelta, renderJobRead } from '../lib/render.js'
import { describeStartupError, resolveWorkdir, buildEnv, toolAborted, workdirError } from '../lib/util.js'
import {
  parseSkillFrontmatter,
  registerNiubashSkill,
  SKILL_NAME,
  PROVIDER_NAME,
  BUNDLED_SKILL_RANK,
} from '../lib/skill.js'

// ---------------------------------------------------------------- niu.js

const fileKinds = (files) => (path) => (files.has(path.toLowerCase()) ? 'file' : 'missing')

test('platform gate: only win32 is supported', () => {
  assert.equal(isSupportedPlatform('win32'), true)
  assert.equal(isSupportedPlatform('linux'), false)
  assert.equal(isSupportedPlatform('darwin'), false)
})

test('resolution order: config niuPath is authoritative', () => {
  const env = { PATH: 'C:\\somewhere', DSH_NIUBASH_PATH: 'C:\\env\\niu.exe' }
  const resolution = resolveNiu({
    env,
    platform: 'win32',
    configuredPath: 'C:\\config\\niu.exe',
    kindOf: fileKinds(new Set(['c:\\config\\niu.exe', 'c:\\env\\niu.exe', 'c:\\somewhere\\niu.exe'])),
  })
  assert.equal(resolution.found, true)
  assert.equal(resolution.path, 'C:\\config\\niu.exe')
  assert.equal(resolution.source, 'config')
})

test('resolution order: DSH_NIUBASH_PATH beats PI_NIUBASH_PATH and PATH', () => {
  const env = {
    PATH: 'C:\\pathdir',
    DSH_NIUBASH_PATH: 'C:\\dsh\\niu.exe',
    PI_NIUBASH_PATH: 'C:\\pi\\niu.exe',
  }
  const resolution = resolveNiu({
    env,
    platform: 'win32',
    kindOf: fileKinds(new Set(['c:\\dsh\\niu.exe', 'c:\\pi\\niu.exe', 'c:\\pathdir\\niu.exe'])),
  })
  assert.equal(resolution.found, true)
  assert.equal(resolution.source, 'DSH_NIUBASH_PATH')
})

test('resolution order: PI_NIUBASH_PATH kept for continuity', () => {
  const env = { PATH: 'C:\\pathdir', PI_NIUBASH_PATH: 'C:\\pi\\niu.exe' }
  const resolution = resolveNiu({
    env,
    platform: 'win32',
    kindOf: fileKinds(new Set(['c:\\pi\\niu.exe'])),
  })
  assert.equal(resolution.found, true)
  assert.equal(resolution.source, 'PI_NIUBASH_PATH')
})

test('resolution order: PATH before install directories', () => {
  const env = {
    PATH: 'C:\\first;C:\\second',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  }
  const resolution = resolveNiu({
    env,
    platform: 'win32',
    kindOf: fileKinds(new Set(['c:\\second\\niu.exe', 'c:\\users\\x\\appdata\\local\\programs\\niubash\\niu.exe'])),
  })
  assert.equal(resolution.found, true)
  assert.equal(resolution.path, 'C:\\second\\niu.exe')
  assert.equal(resolution.source, 'PATH')
})

test('resolution falls back to the standard install directories', () => {
  const env = { PATH: '', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }
  const local = resolveNiu({
    env,
    platform: 'win32',
    kindOf: fileKinds(new Set(['c:\\users\\x\\appdata\\local\\programs\\niubash\\niu.exe'])),
  })
  assert.equal(local.found, true)
  assert.equal(local.source, '%LOCALAPPDATA%')
  const pf = resolveNiu({
    env,
    platform: 'win32',
    kindOf: fileKinds(new Set(['c:\\program files\\niubash\\niu.exe'])),
  })
  assert.equal(pf.found, true)
  assert.equal(pf.source, '%ProgramFiles%')
})

test('a stale authoritative override is reported, not silently ignored', () => {
  const resolution = resolveNiu({
    env: { DSH_NIUBASH_PATH: 'C:\\gone\\niu.exe', PATH: 'C:\\pathdir' },
    platform: 'win32',
    kindOf: fileKinds(new Set(['c:\\pathdir\\niu.exe'])),
  })
  assert.equal(resolution.found, false)
  assert.equal(resolution.overrideSet, true)
  assert.equal(resolution.overrideSource, 'DSH_NIUBASH_PATH')
  assert.deepEqual(resolution.checked, [{ path: 'C:\\gone\\niu.exe', source: 'DSH_NIUBASH_PATH', kind: 'missing' }])
})

test('a directory override is rejected as not-a-file', () => {
  const resolution = resolveNiu({
    env: {},
    platform: 'win32',
    configuredPath: 'C:\\Niubash',
    kindOf: () => 'other',
  })
  assert.equal(resolution.found, false)
  assert.equal(resolution.checked[0].kind, 'other')
})

test('unexpanded %NAME% references are flagged', () => {
  assert.equal(hasUnexpandedVariable('%LOCALAPPDATA%\\Niubash\\niu.exe'), true)
  assert.equal(hasUnexpandedVariable('C:\\Niubash\\niu.exe'), false)
  const resolution = resolveNiu({
    env: { DSH_NIUBASH_PATH: '%LOCALAPPDATA%\\Niubash\\niu.exe' },
    platform: 'win32',
    kindOf: () => 'missing',
  })
  assert.equal(resolution.found, false)
  assert.equal(resolution.unexpandedVariable, true)
})

test('override spelling: quotes trimmed, ~ expanded', () => {
  const env = { USERPROFILE: 'C:\\Users\\x' }
  const resolution = resolveNiu({
    env: { ...env, DSH_NIUBASH_PATH: '"~\\bin\\niu.exe"' },
    platform: 'win32',
    kindOf: fileKinds(new Set(['c:\\users\\x\\bin\\niu.exe'])),
  })
  assert.equal(resolution.found, true)
  assert.equal(resolution.path, 'C:\\Users\\x\\bin\\niu.exe')
})

test('unverified candidates (Store aliases) are handed to spawn', () => {
  const resolution = resolveNiu({
    env: { DSH_NIUBASH_PATH: 'C:\\alias\\niu.exe' },
    platform: 'win32',
    kindOf: () => 'unverified',
  })
  assert.equal(resolution.found, true)
  assert.equal(resolution.verified, false)
})

test('PATH candidates deduplicate case-insensitively on Windows', () => {
  const env = { PATH: 'C:\\Dir;C:\\dir;C:\\Other' }
  const resolution = resolveNiu({ env, platform: 'win32', kindOf: () => 'missing' })
  assert.equal(resolution.found, false)
  assert.equal(resolution.checked.filter((c) => c.source === 'PATH').length, 2)
})

test('pathCandidates and installDirectoryCandidates shapes', () => {
  assert.deepEqual(pathCandidates({ PATH: 'A;B' }, 'win32'), ['A\\niu.exe', 'B\\niu.exe'])
  assert.deepEqual(pathCandidates({ PATH: 'A:B' }, 'linux'), ['A/niu.exe', 'B/niu.exe'])
  const dirs = installDirectoryCandidates({ LOCALAPPDATA: 'L', ProgramFiles: 'P' }, 'win32')
  assert.deepEqual(dirs.map((d) => d.source), ['%LOCALAPPDATA%', '%ProgramFiles%'])
})

// ---------------------------------------------------------------- prompt.js

test('prompt invariants: names and preference contract', () => {
  assert.equal(TOOL_NAME, 'niubash')
  assert.match(DESCRIPTION, /prefer it\s+over pwsh/)
  assert.match(DESCRIPTION, /niu -c/)
  assert.match(DESCRIPTION, /32000 characters/)
  assert.match(PROMPT_SECTION, /Use niubash as the default shell/)
  assert.match(PROMPT_SECTION, /Use pwsh only when the task needs PowerShell itself/)
  // The preference section must not reference the Pi tool name.
  assert.doesNotMatch(PROMPT_SECTION, /powershell tool/)
})

test('unavailable texts never advertise the preference', () => {
  assert.doesNotMatch(UNAVAILABLE_DESCRIPTION, /default shell/)
  assert.doesNotMatch(UNAVAILABLE_SECTION, /default shell/)
  assert.match(UNAVAILABLE_SECTION, /use the pwsh tool/)
})

test('unavailableMessage lists every checked path once with annotations', () => {
  const message = unavailableMessage({
    found: false,
    overrideSet: false,
    unexpandedVariable: false,
    checked: [
      { path: 'C:\\a\\niu.exe', source: 'PATH', kind: 'missing' },
      { path: 'C:\\b', source: '%LOCALAPPDATA%', kind: 'other' },
    ],
  })
  assert.match(message, /C:\\a\\niu\.exe \(not found\)/)
  assert.match(message, /C:\\b \(not a file/)
  assert.match(message, /Install Niubash from https:\/\/unixwin\.dev/)
})

test('unavailableMessage blames the authoritative override', () => {
  const message = unavailableMessage({
    found: false,
    overrideSet: true,
    overrideSource: 'DSH_NIUBASH_PATH',
    unexpandedVariable: true,
    checked: [{ path: '%LOCALAPPDATA%\\niu.exe', source: 'DSH_NIUBASH_PATH', kind: 'missing' }],
  })
  assert.match(message, /DSH_NIUBASH_PATH is set, so PATH and the standard install directories were not searched/)
  assert.match(message, /unexpanded %NAME%/)
})

// ---------------------------------------------------------------- capture.js

function tempSpillPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'niubash-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'spill.txt')
}

test('capture: small output stays in memory, no spill', (t) => {
  const capture = new StreamCapture({ maxBytes: 100, spillPath: tempSpillPath(t) })
  capture.push(Buffer.from('hello '))
  capture.push(Buffer.from('world'))
  const tail = capture.tail()
  assert.equal(tail.text, 'hello world')
  assert.equal(tail.truncated, false)
  assert.equal(tail.spillPath, undefined)
  assert.equal(capture.spilled, false)
})

test('capture: overflow keeps the tail and spills the complete stream', (t) => {
  const spillPath = tempSpillPath(t)
  const capture = new StreamCapture({ maxBytes: 10, spillPath })
  capture.push(Buffer.from('0123456789')) // 10 bytes: at the cap, no spill yet
  assert.equal(capture.spilled, false)
  capture.push(Buffer.from('ABCDEFGHIJ')) // overflow
  const tail = capture.tail()
  assert.equal(tail.truncated, true)
  assert.equal(tail.text, 'ABCDEFGHIJ')
  assert.equal(tail.spillPath, spillPath)
  capture.close()
  assert.equal(readFileSync(spillPath, 'utf8'), '0123456789ABCDEFGHIJ')
})

test('capture: a single huge chunk is tail-sliced and fully spilled', (t) => {
  const spillPath = tempSpillPath(t)
  const capture = new StreamCapture({ maxBytes: 8, spillPath })
  const huge = Buffer.from('x'.repeat(64) + 'TAIL1234')
  capture.push(huge)
  const tail = capture.tail()
  assert.equal(tail.text, 'TAIL1234')
  assert.equal(tail.truncated, true)
  capture.close()
  assert.equal(readFileSync(spillPath, 'utf8'), huge.toString('utf8'))
})

test('capture: readFrom offsets are non-consuming and byte-exact', (t) => {
  const capture = new StreamCapture({ maxBytes: 1000, spillPath: tempSpillPath(t) })
  capture.push(Buffer.from('abc'))
  capture.push(Buffer.from('def'))
  const first = capture.readFrom(0)
  assert.equal(first.text, 'abcdef')
  assert.equal(first.nextOffset, 6)
  assert.equal(first.lossy, false)
  const again = capture.readFrom(0) // non-consuming
  assert.equal(again.text, 'abcdef')
  const delta = capture.readFrom(3)
  assert.equal(delta.text, 'def')
  const empty = capture.readFrom(6)
  assert.equal(empty.text, '')
  assert.equal(empty.nextOffset, 6)
})

test('capture: lossy reads return the retained tail with the spill path', (t) => {
  const spillPath = tempSpillPath(t)
  const capture = new StreamCapture({ maxBytes: 6, spillPath })
  capture.push(Buffer.from('aaaa'))
  capture.push(Buffer.from('bbbb'))
  capture.push(Buffer.from('cccc'))
  const read = capture.readFrom(0) // offset 0 slid out of the window
  assert.equal(read.lossy, true)
  // Retention trims whole chunks only: bbbb+cccc (8 bytes) is the retained tail.
  assert.equal(read.text, 'bbbbcccc')
  assert.equal(read.nextOffset, 12)
  assert.equal(read.spillPath, spillPath)
  capture.close()
  assert.equal(readFileSync(spillPath, 'utf8'), 'aaaabbbbcccc')
})

test('capture: spill cap stops writing but keeps the path', (t) => {
  const spillPath = tempSpillPath(t)
  const capture = new StreamCapture({ maxBytes: 4, maxSpillBytes: 10, spillPath })
  capture.push(Buffer.from('0123456789ABCDEF'))
  capture.close()
  assert.equal(readFileSync(spillPath, 'utf8'), '0123456789')
  assert.equal(capture.tail().spillPath, spillPath)
})

test('capture: UTF-8 content survives chunked pushes', (t) => {
  const capture = new StreamCapture({ maxBytes: 1000, spillPath: tempSpillPath(t) })
  const text = '你好，世界！🐂'
  const buf = Buffer.from(text, 'utf8')
  capture.push(buf.subarray(0, 5))
  capture.push(buf.subarray(5))
  assert.equal(capture.tail().text, text)
})

// ---------------------------------------------------------------- render.js

const stream = (text, truncated = false, spillPath) => ({ text, truncated, ...(spillPath ? { spillPath } : {}) })

test('render: clean exit has no marker', () => {
  const text = renderNiubashResult({ exitCode: 0, signal: null, timedOut: false, timeoutMs: 1000, stdout: stream('ok\n'), stderr: stream('') })
  assert.equal(text, 'ok\n')
})

test('render: empty output renders (no output)', () => {
  const text = renderNiubashResult({ exitCode: 0, signal: null, timedOut: false, timeoutMs: 1000, stdout: stream(''), stderr: stream('') })
  assert.equal(text, '(no output)')
})

test('render: non-zero exit marker stays last', () => {
  const text = renderNiubashResult({ exitCode: 3, signal: null, timedOut: false, timeoutMs: 1000, stdout: stream('boom'), stderr: stream('') })
  assert.equal(text, 'boom\n[exit code: 3]')
})

test('render: stderr section and truncation notices', () => {
  const text = renderNiubashResult({
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: 1000,
    stdout: stream('out', true, 'C:\\tmp\\o.txt'),
    stderr: stream('err'),
  })
  assert.equal(text, 'out\n[output truncated; full output: C:\\tmp\\o.txt]\n[stderr]\nerr')
})

test('render: timeout, stopped, and signal markers', () => {
  const text = renderNiubashResult({ exitCode: 1, signal: null, timedOut: true, stopped: 'user stopped', timeoutMs: 500, stdout: stream(''), stderr: stream('') })
  assert.equal(text, '(no output)\n[timed out after 500ms]\n[stopped: user stopped]\n[exit code: 1]')
  const sig = renderNiubashResult({ exitCode: null, signal: 'SIGTERM', timedOut: false, timeoutMs: 500, stdout: stream(''), stderr: stream('') })
  assert.match(sig, /\[killed by signal: SIGTERM\]$/)
})

test('render: promoted and job reads', () => {
  assert.equal(renderPromoted({ jobId: 'niubash-abc', timeoutMs: 100, output: 'partial' }), 'partial\n[still running after 100ms; moved to background job niubash-abc]')
  assert.equal(renderPromoted({ jobId: 'niubash-abc', timeoutMs: 100, output: '' }), '[still running after 100ms; moved to background job niubash-abc]')
  const delta = ringDelta([
    { at: 0, text: 'a', channel: 'stdout' },
    { at: 1, text: 'e', channel: 'stderr' },
    { at: 2, text: 'b', channel: 'stdout' },
  ])
  assert.equal(delta, 'ab\n[stderr]\ne')
  assert.equal(renderJobRead('x', true, ['C:\\s.txt']), 'x\n[some output was dropped from memory; full output: C:\\s.txt]')
  assert.equal(renderJobRead('x', false, []), 'x')
})

// ---------------------------------------------------------------- util.js

test('resolveWorkdir: relative resolves against the session cwd', () => {
  assert.equal(resolveWorkdir(undefined, 'C:\\ws'), 'C:\\ws')
  assert.equal(resolveWorkdir('sub', 'C:\\ws'), join('C:\\ws', 'sub'))
  assert.equal(resolveWorkdir('D:\\other', 'C:\\ws'), 'D:\\other')
  assert.equal(resolveWorkdir('sub', undefined), 'sub')
})

test('buildEnv: strips inherited DSH_*, applies terminal overrides and the managed snapshot last', () => {
  process.env.DSH_TEST_AMBIENT = 'stale'
  try {
    const env = buildEnv({ DSH_SESSION_ID: 's1', DSH_TEST_AMBIENT: 'managed' })
    assert.equal(env.DSH_TEST_AMBIENT, 'managed')
    assert.equal(env.DSH_SESSION_ID, 's1')
    assert.equal(env.NO_COLOR, '1')
    assert.equal(env.PAGER, 'cat')
    assert.equal(env.GIT_PAGER, 'cat')
  } finally {
    delete process.env.DSH_TEST_AMBIENT
  }
})

test('describeStartupError: ENOENT spawn becomes actionable guidance with cause', () => {
  const original = Object.assign(new Error('spawn C:\\gone\\niu.exe ENOENT'), { code: 'ENOENT', syscall: 'spawn C:\\gone\\niu.exe' })
  const guided = describeStartupError(original, 'C:\\gone\\niu.exe')
  assert.notEqual(guided, original)
  assert.match(guided.message, /Could not start niu\.exe at C:\\gone\\niu\.exe/)
  assert.match(guided.message, /DSH_NIUBASH_PATH/)
  assert.equal(guided.code, 'ENOENT')
  assert.equal(guided.cause, original)
})

test('describeStartupError: unrelated errors pass through unchanged', () => {
  const original = Object.assign(new Error('output temp file failed'), { code: 'EIO', syscall: 'open' })
  assert.equal(describeStartupError(original, 'C:\\niu.exe'), original)
})

test('toolAborted carries the AbortError name', () => {
  const error = toolAborted()
  assert.equal(error.name, 'AbortError')
  assert.match(error.message, /aborted/)
})

test('workdirError: missing directory is reported as itself, not as niu.exe', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'niubash-wd-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(workdirError(dir), undefined)
  const missing = join(dir, 'no-such-subdir')
  assert.equal(workdirError(missing), `working directory does not exist: ${missing}`)
  const file = join(dir, 'a-file.txt')
  writeFileSync(file, 'x')
  assert.equal(workdirError(file), `workdir is not a directory: ${file}`)
})

// ---------------------------------------------------------------- skill.js

const skillFile = (dir) => join(dir, 'SKILL.md')
const writeSkill = (dir, raw) => { mkdirSync(dir, { recursive: true }); writeFileSync(skillFile(dir), raw) }
const MINIMAL_SKILL = '---\nname: niubash\ndescription: Troubleshooting skill for tests.\nlicense: MIT\nmetadata:\n  upstream: https://unixwin.dev\n---\n\n# Body\n\nInstructions.\n'

function fakeSkillCtx() {
  const warnings = []
  let provider
  let invalidated = 0
  const control = { invalidate: () => { invalidated += 1 }, signal: new AbortController().signal }
  const ctx = {
    skills: { registerProvider: (factory) => { provider = factory(control); return () => {} } },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ctx, warnings, provider: () => provider, invalidated: () => invalidated }
}

test('skill: the packaged SKILL.md parses and keeps the routing gate', () => {
  const raw = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
  const parsed = parseSkillFrontmatter(raw)
  assert.equal(parsed.name, SKILL_NAME)
  assert.ok(parsed.description.length > 100)
  assert.match(parsed.description, /Do not load for ordinary command execution/)
  // A plain YAML scalar must not contain ": " — the filesystem provider would reject the file.
  assert.ok(!parsed.description.includes(': '))
  assert.ok(parsed.content.startsWith('# Niubash'))
  assert.ok(!parsed.content.includes('name: niubash'))
  assert.match(parsed.content, /## DSH result contract/)
  assert.match(parsed.content, /## PTC \(run_code\) bridge rules/)
})

test('skill: frontmatter parser unquotes scalars and ignores nested metadata', () => {
  const parsed = parseSkillFrontmatter('---\nname: "niubash"\ndescription: \'Quoted description.\'\nmetadata:\n  upstream: https://unixwin.dev\n---\nBody.\n')
  assert.equal(parsed.name, 'niubash')
  assert.equal(parsed.description, 'Quoted description.')
  assert.equal(parsed.content, 'Body.')
})

test('skill: frontmatter parser rejects missing or unsupported input', () => {
  assert.throws(() => parseSkillFrontmatter('# no frontmatter'), /no YAML frontmatter/)
  assert.throws(() => parseSkillFrontmatter('---\nname: niubash\n---\nBody.'), /requires name and description/)
  assert.throws(() => parseSkillFrontmatter('---\nname: niubash\ndescription: >-\n  folded\n---\nBody.'), /block scalar/)
  assert.throws(() => parseSkillFrontmatter('---\nname: Not_Kebab\ndescription: x\n---\nBody.'), /invalid skill name/)
})

test('skill: provider lists a bundled candidate and loads its body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'niubash-skill-'))
  const harness = fakeSkillCtx()
  registerNiubashSkill(harness.ctx, { skillDir: dir })
  writeSkill(dir, MINIMAL_SKILL)
  const candidates = await harness.provider().list({ signal: undefined })
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, SKILL_NAME)
  assert.equal(candidate.description, 'Troubleshooting skill for tests.')
  assert.equal(candidate.provider, PROVIDER_NAME)
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.ok(!candidate.resourceBase.path.includes('\\'))
  assert.equal(candidate.locator, skillFile(dir))
  const definition = await harness.provider().get(candidate, { signal: undefined })
  assert.equal(definition.content, '# Body\n\nInstructions.')
  assert.ok(!('rank' in definition) && !('locator' in definition))
  assert.equal(harness.warnings.length, 0)
})

test('skill: a missing SKILL.md is a persistent failure (complete empty catalog, invalidate on get)', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'niubash-skill-')), 'absent')
  const harness = fakeSkillCtx()
  registerNiubashSkill(harness.ctx, { skillDir: dir })
  const observation = await harness.provider().list({ signal: undefined })
  assert.deepEqual(observation, { candidates: [], complete: true })
  await harness.provider().list({ signal: undefined })
  assert.equal(harness.warnings.length, 1) // each distinct failure reported once
  const candidate = { name: SKILL_NAME, description: 'x', invocation: { modelInvocable: true, userInvocable: true }, provider: PROVIDER_NAME, source: 'bundled', rank: BUNDLED_SKILL_RANK, locator: skillFile(dir) }
  assert.equal(await harness.provider().get(candidate, { signal: undefined }), undefined)
  assert.equal(harness.invalidated(), 1)
})

test('skill: invalid frontmatter is persistent and keeps the catalog complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'niubash-skill-'))
  const harness = fakeSkillCtx()
  registerNiubashSkill(harness.ctx, { skillDir: dir })
  writeSkill(dir, '# no frontmatter at all')
  const observation = await harness.provider().list({ signal: undefined })
  assert.deepEqual(observation, { candidates: [], complete: true })
  assert.equal(harness.warnings.length, 1)
})
