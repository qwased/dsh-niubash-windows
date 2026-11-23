/**
 * Unit tests for the pure modules: niu.exe resolution, prompt invariants,
 * stream capture, rendering, and helpers. No Niubash install or DSH runtime
 * needed. Run: node --test test/unit.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
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
import { spawnNiu } from '../lib/process.js'
import { renderNiubashResult, renderPromoted, ringDelta, renderJobRead } from '../lib/render.js'
import { describeStartupError, resolveWorkdir, buildEnv, toolAborted, workdirError, commandLineLength, commandLineFits, WINDOWS_COMMAND_LINE_MAX, COMMAND_LINE_HEADROOM } from '../lib/util.js'
import {
  sandboxSupport,
  approveRequestedMode,
  confineArgv,
  classifySettled,
  foregroundFacts,
  notesFor,
  sandboxStartupFailure,
  jobDetailNote,
  spawnFailureNote,
  runnerFailureMarker,
  missingSandboxHelpers,
  REQUIRED_HELPERS,
  sandboxHelpers,
} from '../lib/sandbox.js'
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
  // The 0.3.1 wording states the same preference ("Prefer it for command-line work;
  // use pwsh for PowerShell-specific tasks"); only the phrase changed, not the policy.
  assert.match(DESCRIPTION, /Prefer it for command-line work; use pwsh for PowerShell-specific tasks/)
  assert.match(DESCRIPTION, /niu -c/)
  assert.match(DESCRIPTION, /32000 characters/)
  assert.match(PROMPT_SECTION, /Use niubash as the default shell/)
  assert.match(PROMPT_SECTION, /Use pwsh only when the task needs PowerShell itself/)
  // The preference section must not reference the Pi tool name.
  assert.doesNotMatch(PROMPT_SECTION, /powershell tool/)
})

test('prompt: the streamlined description keeps every ordinary calling contract', () => {
  assert.match(DESCRIPTION, /fresh process/)
  assert.match(DESCRIPTION, /workdir/)
  assert.match(DESCRIPTION, /without PTY/)
  assert.match(DESCRIPTION, /native children receive/)
  assert.match(DESCRIPTION, /bundled Windows-native builds/)
  assert.match(DESCRIPTION, /exit code: N/)
  assert.match(DESCRIPTION, /description` before `command/)
  assert.match(PROMPT_SECTION, /read, grep, glob and edit/)
})

test('prompt: deep toolchain details live in the bundled skill, not the prompt', () => {
  // The toolbelt mapping, force-kill settlement and exit-code reminder moved to skill/SKILL.md.
  assert.doesNotMatch(PROMPT_SECTION, /WinuxCmd|bsdtar/)
  assert.doesNotMatch(PROMPT_SECTION, /force-killed/)
  assert.doesNotMatch(PROMPT_SECTION, /exit code: N/)
  assert.doesNotMatch(DESCRIPTION, /WinuxCmd|bsdtar|niugit/)
  // ...and the skill that took them over actually states them.
  const raw = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
  const { content } = parseSkillFrontmatter(raw)
  assert.match(content, /WinuxCmd/)
  assert.match(content, /bsdtar/)
  assert.match(content, /force-killed/)
  assert.match(content, /native children receive/)
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
  // Sandbox troubleshooting is owned by the skill, so the routing gate must advertise it.
  assert.match(parsed.description, /sandbox denial/)
  assert.match(parsed.content, /## Sandbox denials and escalation/)
  assert.match(parsed.content, /SetNamedSecurityInfoW/)
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

// ---------------------------------------------------------------- sandbox.js

const fakeStream = (text) => ({ text, truncated: false })

/** Minimal stand-in for @deepseek-ai/dsh-sandbox: the 12 exports this plugin uses. */
function fakeHelpers(overrides = {}) {
  const calls = {
    validate: [],
    approve: [],
    classify: [],
    match: [],
    spawn: [],
    confine: [],
  }
  class SandboxUnavailableError extends Error {
    constructor(mode, detail) {
      super(
        `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; ` +
          'refusing to run the command unconfined.' +
          (detail === undefined ? '' : ` Runner failure: ${detail}`),
      )
      this.name = 'SandboxUnavailableError'
      this.code = 'SANDBOX_UNAVAILABLE'
    }
  }
  class SandboxEscalationError extends Error {
    constructor(message, code) {
      super(message)
      this.name = 'SandboxEscalationError'
      this.code = code
    }
  }
  const h = {
    ESCALATION_TARGETS: ['workspace-write', 'danger-full-access'],
    sandboxDenialMarker: (mode) => `[sandbox: file access denied under ${mode} mode]`,
    escalationHintMarker: (subject) =>
      `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions + justification]`,
    validateEscalationArgs(sandboxPermissions, justification) {
      calls.validate.push([sandboxPermissions, justification])
      if (sandboxPermissions !== undefined && justification === undefined) {
        throw new SandboxEscalationError(
          'invalid escalation: sandbox_permissions requires a justification',
          'SANDBOX_ESCALATION_INVALID_ARGUMENT',
        )
      }
      if (justification !== undefined && sandboxPermissions === undefined) {
        throw new SandboxEscalationError(
          'invalid escalation: justification is only valid together with sandbox_permissions',
          'SANDBOX_ESCALATION_INVALID_ARGUMENT',
        )
      }
      if (justification !== undefined && justification.trim().length === 0) {
        throw new SandboxEscalationError('invalid justification: expected a non-empty sentence', 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
      }
    },
    async approveEscalation(request, approval) {
      calls.approve.push([request, approval])
      if (request.requestedMode === request.effectiveMode) return request.effectiveMode
      if (request.requestedMode === 'workspace-write' && request.effectiveMode === 'danger-full-access') {
        throw new SandboxEscalationError(
          `sandbox escalation to "${request.requestedMode}" is not strictly wider`,
          'SANDBOX_ESCALATION_INVALID_ARGUMENT',
        )
      }
      return request.requestedMode
    },
    classifyRunnerFailure(exitCode, stderr, rules) {
      calls.classify.push([exitCode, stderr, rules])
      if (exitCode === null || exitCode === 0) return undefined
      for (const rule of rules) {
        if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
        const informational = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()))
        const fatal = rule.fatalSignatures.map((signature) => signature.toLowerCase())
        for (const line of stderr.split(/\r?\n/)) {
          if (informational.has(line.toLowerCase())) continue
          if (fatal.some((signature) => line.toLowerCase().includes(signature))) return { detail: line }
        }
      }
      return undefined
    },
    matchesSignature(exitCode, stderr, signatures) {
      calls.match.push([exitCode, stderr, signatures])
      if (exitCode === null || exitCode === 0) return false
      return signatures.some((signature) => stderr.toLowerCase().includes(signature.toLowerCase()))
    },
    isRunnerSpawnFailure(error, runnerProgram, workdir) {
      calls.spawn.push([error, runnerProgram, workdir])
      if (runnerProgram === undefined) return false
      try {
        if (!statSync(workdir).isDirectory()) return false
      } catch {
        return false
      }
      if (typeof error?.code !== 'string' || !['ENOENT', 'EACCES'].includes(error.code)) return false
      if (typeof error.syscall !== 'string') return false
      const exact = `spawn ${runnerProgram}`
      if (error.path === undefined) return error.syscall === exact
      return error.path === runnerProgram && (error.syscall === 'spawn' || error.syscall === exact)
    },
    SandboxUnavailableError,
    SandboxEscalationError,
  }
  return { h: Object.assign(h, overrides), calls }
}

const fakeCtx = (services) => ({ get: (name) => services[name] })

const fakeExec = (overrides = {}) => ({
  agent: { session: { id: 's1' } },
  callId: 'call-1',
  signal: new AbortController().signal,
  ...overrides,
})

const fakeWrap = (overrides = {}) => ({
  argv: ['C:\\node\\node.exe', 'C:\\dsh\\runner.js', '--', 'C:\\niu.exe', '-c', 'echo ok'],
  enforcement: 'partial',
  denialSignatures: ['permission denied', 'access is denied'],
  runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
  ...overrides,
})

test('U1 sandboxSupport: escalation modes follow the composed services', () => {
  const { h } = fakeHelpers()
  const available = sandboxSupport(fakeCtx({ sandbox: {}, sandboxPolicy: {} }), h)
  assert.equal(available.h, h)
  assert.deepEqual(available.escalationModes, h.ESCALATION_TARGETS)
  assert.deepEqual(available.notes({ mode: 'workspace-write', denied: true }), [
    h.sandboxDenialMarker('workspace-write'),
    h.escalationHintMarker('command'),
  ])
  assert.deepEqual(available.notes({ mode: 'workspace-write', denied: false }), [])
  assert.deepEqual(sandboxSupport(fakeCtx({ sandbox: {} }), h).escalationModes, [])
  assert.deepEqual(sandboxSupport(fakeCtx({ sandboxPolicy: {} }), h).escalationModes, [])
})

test('U2 approveRequestedMode: no escalation returns without touching h', async () => {
  const poisoned = {
    get validateEscalationArgs() {
      throw new Error('h must not be touched')
    },
  }
  const result = await approveRequestedMode(fakeCtx({}), fakeExec(), { command: 'echo ok' }, undefined, {
    h: poisoned,
    escalationModes: [],
  })
  assert.equal(result, undefined)
})

test('U3 same-mode retry is free (short-circuit before validation and approval)', async () => {
  const { h, calls } = fakeHelpers()
  h.validateEscalationArgs = () => {
    throw new Error('validation must not run for a same-mode retry')
  }
  h.approveEscalation = async () => {
    throw new Error('approval must not run for a same-mode retry')
  }
  const result = await approveRequestedMode(
    fakeCtx({}),
    fakeExec(),
    { sandbox_permissions: 'workspace-write' },
    { mode: 'workspace-write' },
    { h, escalationModes: ['workspace-write', 'danger-full-access'] },
  )
  assert.equal(result, undefined)
  assert.equal(calls.approve.length, 0)
})

test('U4 blank justification without permissions is not an escalation request', async () => {
  const poisoned = {
    get validateEscalationArgs() {
      throw new Error('h must not be touched')
    },
  }
  const result = await approveRequestedMode(fakeCtx({}), fakeExec(), { justification: '' }, { mode: 'workspace-write' }, {
    h: poisoned,
    escalationModes: ['danger-full-access'],
  })
  assert.equal(result, undefined)
})

test('U5 permissions without justification is INVALID_ARGUMENT', async () => {
  const { h } = fakeHelpers()
  await assert.rejects(
    approveRequestedMode(
      fakeCtx({}),
      fakeExec(),
      { sandbox_permissions: 'danger-full-access' },
      { mode: 'workspace-write' },
      { h, escalationModes: h.ESCALATION_TARGETS },
    ),
    (error) => error.code === 'SANDBOX_ESCALATION_INVALID_ARGUMENT',
  )
})

test('U6 escalation without a policy or service is UNAVAILABLE, never a TypeError', async () => {
  const { h } = fakeHelpers()
  const args = { sandbox_permissions: 'danger-full-access', justification: 'need it for the build' }
  await assert.rejects(
    approveRequestedMode(fakeCtx({}), fakeExec(), args, undefined, { h, escalationModes: h.ESCALATION_TARGETS }),
    (error) =>
      error instanceof h.SandboxEscalationError &&
      !(error instanceof TypeError) &&
      error.code === 'SANDBOX_ESCALATION_UNAVAILABLE',
  )
  await assert.rejects(
    approveRequestedMode(fakeCtx({}), fakeExec(), args, { mode: 'workspace-write' }, { h, escalationModes: [] }),
    (error) => error.code === 'SANDBOX_ESCALATION_UNAVAILABLE',
  )
})

test('U7 confineArgv: danger-full-access runs unwrapped and never touches the backend', async () => {
  let confined = 0
  const sandbox = {
    confine: async () => {
      confined += 1
      return fakeWrap()
    },
  }
  const { h } = fakeHelpers()
  const policy = { mode: 'danger-full-access', workspaceRoot: 'C:\\ws' }
  assert.equal(await confineArgv(fakeCtx({ sandbox }), policy, ['C:\\niu.exe', '-c', 'echo ok'], undefined, { h }), undefined)
  assert.equal(confined, 0)
})

test('U8 confineArgv: a confined mode without a backend fails closed', async () => {
  const { h } = fakeHelpers()
  const policy = { mode: 'workspace-write', workspaceRoot: 'C:\\ws' }
  await assert.rejects(
    confineArgv(fakeCtx({}), policy, ['C:\\niu.exe', '-c', 'echo ok'], undefined, { h }),
    (error) => error instanceof h.SandboxUnavailableError && error.code === 'SANDBOX_UNAVAILABLE',
  )
})

test('U8b confineArgv: unloadable helpers fail closed with a plain Error', async () => {
  let confined = 0
  const sandbox = {
    confine: async () => {
      confined += 1
      return fakeWrap()
    },
  }
  const policy = { mode: 'workspace-write', workspaceRoot: 'C:\\ws' }
  await assert.rejects(
    confineArgv(fakeCtx({ sandbox }), policy, ['C:\\niu.exe', '-c', 'echo ok'], undefined, { h: undefined }),
    (error) =>
      error.code === undefined &&
      error.name !== 'SandboxUnavailableError' &&
      /is not loadable/.test(error.message) &&
      /refusing to run the command unconfined/.test(error.message),
  )
  assert.equal(confined, 0)
})

test('U9 confineArgv: sandbox without sandboxPolicy fails closed, not with a TypeError', async () => {
  let confined = 0
  const sandbox = {
    confine: async () => {
      confined += 1
      return fakeWrap()
    },
  }
  const { h } = fakeHelpers()
  await assert.rejects(
    confineArgv(fakeCtx({ sandbox }), undefined, ['C:\\niu.exe', '-c', 'echo ok'], undefined, { h }),
    (error) =>
      !(error instanceof TypeError) &&
      error.code === undefined &&
      /mounts ctx\.sandbox without ctx\.sandboxPolicy/.test(error.message),
  )
  assert.equal(confined, 0)
})

test('U9c a narrower escalation request surfaces INVALID_ARGUMENT', async () => {
  const { h } = fakeHelpers()
  await assert.rejects(
    approveRequestedMode(
      fakeCtx({ approval: {} }),
      fakeExec(),
      { sandbox_permissions: 'workspace-write', justification: 'need it for the build' },
      { mode: 'danger-full-access' },
      { h, escalationModes: h.ESCALATION_TARGETS },
    ),
    (error) => error.code === 'SANDBOX_ESCALATION_INVALID_ARGUMENT',
  )
})

test('U10 confineArgv: a confined mode wraps the exact argv once', async () => {
  const { h } = fakeHelpers()
  const wrap = fakeWrap()
  const captured = []
  const sandbox = {
    confine: async (argv, policy, signal) => {
      captured.push({ argv, policy, signal })
      return wrap
    },
  }
  const policy = { mode: 'workspace-write', workspaceRoot: 'C:\\ws', sessionId: 's1' }
  const signal = new AbortController().signal
  const argv = ['C:\\niu.exe', '-c', 'echo ok']
  const result = await confineArgv(fakeCtx({ sandbox }), policy, argv, signal, { h })
  assert.equal(result, wrap)
  assert.equal(captured.length, 1)
  assert.deepEqual(captured[0].argv, argv)
  assert.equal(captured[0].policy, policy)
  assert.equal(captured[0].signal, signal)
})

test('U10b confineArgv: an aborted call keeps the caller abort reason', async () => {
  const { h } = fakeHelpers()
  const sandbox = {
    confine: async (_argv, _policy, signal) => {
      signal.throwIfAborted()
    },
  }
  const controller = new AbortController()
  controller.abort('user pressed stop')
  await assert.rejects(
    confineArgv(
      fakeCtx({ sandbox }),
      { mode: 'workspace-write', workspaceRoot: 'C:\\ws' },
      ['C:\\niu.exe', '-c', 'echo ok'],
      controller.signal,
      { h },
    ),
    (error) => error === 'user pressed stop',
  )
})

test('U11 classifySettled: a runner failure outranks a denial', () => {
  const { h } = fakeHelpers()
  const wrap = fakeWrap()
  const settled = classifySettled(
    { exitCode: 127, stderr: fakeStream('cleanup: left a temp dir\nwindows-acl-run: --workspace is not a directory\n') },
    wrap,
    { mode: 'workspace-write' },
    { h },
  )
  assert.deepEqual(settled.sandbox, {
    mode: 'workspace-write',
    enforcement: 'partial',
    denied: false,
    runnerFailed: true,
  })
  assert.equal(settled.runnerFailure.detail, 'windows-acl-run: --workspace is not a directory')
})

test('U12 classifySettled: a denial needs a matching signature on a non-zero exit', () => {
  const { h } = fakeHelpers()
  const wrap = fakeWrap()
  const denied = classifySettled(
    { exitCode: 1, stderr: fakeStream('niu: Permission denied\n') },
    wrap,
    { mode: 'workspace-write' },
    { h },
  )
  assert.deepEqual(denied.sandbox, { mode: 'workspace-write', enforcement: 'partial', denied: true })
  const clean = classifySettled(
    { exitCode: 0, stderr: fakeStream('Permission denied') },
    wrap,
    { mode: 'workspace-write' },
    { h },
  )
  assert.deepEqual(clean.sandbox, { mode: 'workspace-write', enforcement: 'partial', denied: false })
})

test('U13 foregroundFacts: a runner failure errors; an unwrapped run reports carried facts', () => {
  const { h } = fakeHelpers()
  const wrap = fakeWrap()
  assert.throws(
    () =>
      foregroundFacts(
        { exitCode: 127, stderr: fakeStream('windows-acl-run: nope') },
        wrap,
        { mode: 'workspace-write' },
        { h },
      ),
    (error) =>
      error instanceof h.SandboxUnavailableError &&
      error.code === 'SANDBOX_UNAVAILABLE' &&
      /Runner failure: windows-acl-run: nope/.test(error.message),
  )
  const dangerous = foregroundFacts({ exitCode: 0, stderr: fakeStream('') }, undefined, {
    mode: 'danger-full-access',
  }, undefined)
  assert.deepEqual(dangerous.sandbox, { mode: 'danger-full-access', denied: false })
  const none = foregroundFacts({ exitCode: 0, stderr: fakeStream('') }, undefined, undefined, undefined)
  assert.equal(none.sandbox, undefined)
})

test('U14 notesFor: runner failure is exclusive; denial precedes the escalation hint', () => {
  const { h } = fakeHelpers()
  assert.deepEqual(notesFor(h, { mode: 'read-only', denied: true, runnerFailed: true }, ['danger-full-access']), [
    runnerFailureMarker('read-only'),
  ])
  const notes = notesFor(h, { mode: 'workspace-write', denied: true }, ['workspace-write', 'danger-full-access'])
  assert.equal(notes.length, 2)
  assert.equal(notes[0], h.sandboxDenialMarker('workspace-write'))
  assert.match(notes[1], /escalation available/)
  assert.deepEqual(notesFor(h, { mode: 'workspace-write', denied: false }, ['danger-full-access']), [])
  assert.deepEqual(notesFor(h, undefined, []), [])
})

test('U19 spawn attribution and job detail notes', (t) => {
  const { h } = fakeHelpers()
  const dir = mkdtempSync(join(tmpdir(), 'niubash-sandbox-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const policy = { mode: 'workspace-write' }
  const wrap = fakeWrap()
  const support = { h, escalationModes: [], notes: (facts) => notesFor(h, facts, []) }
  const runnerError = Object.assign(new Error('spawn C:\\node\\node.exe ENOENT'), {
    code: 'ENOENT',
    syscall: 'spawn C:\\node\\node.exe',
  })
  const fatal = sandboxStartupFailure(runnerError, { wrap, policy, support }, dir)
  assert.ok(fatal instanceof h.SandboxUnavailableError)
  assert.equal(fatal.code, 'SANDBOX_UNAVAILABLE')
  const niuError = Object.assign(new Error('spawn C:\\niu.exe ENOENT'), {
    code: 'ENOENT',
    syscall: 'spawn C:\\niu.exe',
  })
  assert.equal(sandboxStartupFailure(niuError, { wrap, policy, support }, dir), undefined)
  assert.equal(sandboxStartupFailure(runnerError, undefined, dir), undefined)
  assert.match(spawnFailureNote(runnerError, { wrap, policy, support }, dir), /sandbox runner itself failed/)
  assert.equal(spawnFailureNote(niuError, { wrap, policy, support }, dir), '')
  assert.match(
    jobDetailNote({ exitCode: 1, stderr: fakeStream('Permission denied') }, { wrap, policy, support }),
    /file access denied under workspace-write mode/,
  )
  assert.match(
    jobDetailNote({ exitCode: 127, stderr: fakeStream('windows-acl-run: boom') }, { wrap, policy, support }),
    /sandbox runner itself failed/,
  )
  assert.equal(jobDetailNote({ exitCode: 0, stderr: fakeStream('') }, { wrap, policy, support }), '')
})

test('U17 spawnNiu: the legacy spec keeps [-c, command] and program/args override it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'niubash-spawn-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'check-me.cjs')
  writeFileSync(script, "console.log('MUST-NOT-EXECUTE')\n")
  // Legacy spec is [niuPath, '-c', command]. With node standing in for niu.exe,
  // -c only syntax-checks the file, so the side effect must not run.
  const legacy = await spawnNiu({
    niuPath: process.execPath,
    command: script,
    workdir: dir,
    env: buildEnv({}),
    timeoutMs: 15000,
  }).result()
  assert.equal(legacy.exitCode, 0)
  assert.doesNotMatch(legacy.stdout.text, /MUST-NOT-EXECUTE/)
  // Explicit program/args win over niuPath/command.
  const explicit = await spawnNiu({
    niuPath: join(dir, 'never-used.exe'),
    command: 'ignored',
    program: process.execPath,
    args: ['-e', "console.log('EXPLICIT-OK')"],
    workdir: dir,
    env: buildEnv({}),
    timeoutMs: 15000,
  }).result()
  assert.equal(explicit.exitCode, 0)
  assert.match(explicit.stdout.text, /EXPLICIT-OK/)
})

// ---------------------------------------------------------------- sandbox render / prompt / budget

test('U15 render: sandbox notes sit between stderr and the status markers', () => {
  const text = renderNiubashResult(
    { exitCode: 1, signal: null, timedOut: true, stopped: 'user stopped', timeoutMs: 500, stdout: stream('out'), stderr: stream('err') },
    ['[sandbox: file access denied under workspace-write mode]'],
  )
  assert.equal(
    text,
    'out\n[stderr]\nerr\n[sandbox: file access denied under workspace-write mode]\n[timed out after 500ms]\n[stopped: user stopped]\n[exit code: 1]',
  )
  assert.equal(
    renderNiubashResult(
      { exitCode: 0, signal: null, timedOut: false, timeoutMs: 500, stdout: stream('ok\n'), stderr: stream('') },
      [],
    ),
    'ok\n',
  )
})

test('U16 command-line budget: fails exactly one character past the headroom', () => {
  assert.equal(COMMAND_LINE_HEADROOM, 16)
  assert.equal(commandLineLength(['p', 'x'.repeat(10)]), 18)
  const limit = WINDOWS_COMMAND_LINE_MAX - COMMAND_LINE_HEADROOM
  const atLimit = 'x'.repeat(limit - 8)
  assert.equal(commandLineLength(['p', atLimit]), limit)
  assert.equal(commandLineFits({ program: 'p', args: [atLimit] }), true)
  assert.equal(commandLineFits({ program: 'p', args: [`${atLimit}x`] }), false)
  // The runner prefix is real argv: it costs its own elements.
  assert.equal(commandLineFits({ program: 'p', args: ['x'.repeat(limit)] }), false)
})

test('U18 prompt: sandbox wording matches the first-party contract', () => {
  assert.doesNotMatch(DESCRIPTION, /confined to the session workspace/)
  assert.doesNotMatch(DESCRIPTION, /\(the user approves\)/)
  assert.doesNotMatch(DESCRIPTION, /sandbox_permissions/)
  assert.match(DESCRIPTION, /Commands may run under a file sandbox/)
  assert.match(DESCRIPTION, /file access denied under <mode> mode/)
  assert.match(DESCRIPTION, /policy denial: do not retry another way/)
  // The old refusal narrative must stay gone as well.
  assert.doesNotMatch(DESCRIPTION, /refuses/)
  assert.doesNotMatch(DESCRIPTION, /disabled under/)
  assert.doesNotMatch(DESCRIPTION, /no file sandbox/)
})

// ------------------------------------------------ helper compatibility / teardown race (review 0.3.0)

test('U20 missingSandboxHelpers: every export the plugin calls is required', () => {
  const { h } = fakeHelpers()
  assert.deepEqual(missingSandboxHelpers(h), [], 'the standard fake is complete')
  assert.deepEqual(missingSandboxHelpers({}), [...REQUIRED_HELPERS])
  assert.deepEqual(missingSandboxHelpers(null), [...REQUIRED_HELPERS])
  assert.deepEqual(missingSandboxHelpers({ ...h, ESCALATION_TARGETS: 'workspace-write' }), ['ESCALATION_TARGETS'])
  const { approveEscalation: _unused, ...partial } = h
  assert.deepEqual(missingSandboxHelpers(partial), ['approveEscalation'])
})

test('U21 sandboxSupport: an incomplete host module degrades without throwing', () => {
  const { h } = fakeHelpers()
  const ctx = fakeCtx({ sandbox: {}, sandboxPolicy: {} })
  const broken = { ESCALATION_TARGETS: ['workspace-write'] }
  const support = sandboxSupport(ctx, broken)
  assert.equal(support.h, undefined)
  assert.equal(support.available, true, 'registration-time service fact is kept')
  assert.deepEqual(support.escalationModes, [])
  assert.deepEqual(support.notes({ mode: 'workspace-write', denied: true }), [], 'a broken module produces no markers')
  // A complete module keeps the old shape, including the helper-bound notes.
  const ok = sandboxSupport(ctx, h)
  assert.equal(ok.h, h)
  assert.equal(ok.available, true)
  assert.deepEqual(ok.escalationModes, h.ESCALATION_TARGETS)
  assert.deepEqual(ok.notes({ mode: 'workspace-write', denied: true }), [
    h.sandboxDenialMarker('workspace-write'),
    h.escalationHintMarker('command'),
  ])
})

test('U22 confineArgv: a teardown race after registration fails closed', async () => {
  const { h } = fakeHelpers()
  const argv = ['C:\\niu.exe', '-c', 'echo ok']
  // Both sandbox services were present at registration and are gone now.
  await assert.rejects(
    confineArgv(fakeCtx({}), undefined, argv, undefined, { h, available: true }),
    (error) =>
      error instanceof Error &&
      !(error instanceof TypeError) &&
      error.code === undefined &&
      /no longer composed/.test(error.message),
  )
  // A composition that never had the services still runs unconfined (S1).
  assert.equal(await confineArgv(fakeCtx({}), undefined, argv, undefined, { h, available: false }), undefined)
  assert.equal(await confineArgv(fakeCtx({}), undefined, argv, undefined, undefined), undefined)
})

test('U23 sandboxHelpers: a failed import is not cached forever', async (t) => {
  const first = sandboxHelpers()
  assert.equal(sandboxHelpers(), first, 'concurrent callers share the in-flight import')
  const outcome = await first.catch((reason) => reason)
  if (!(outcome instanceof Error)) {
    t.skip('@deepseek-ai/dsh-sandbox is resolvable in this checkout')
    return
  }
  const retry = sandboxHelpers()
  assert.notEqual(retry, first, 'a rejection must not stay memoized')
  await retry.catch(() => {})
})
