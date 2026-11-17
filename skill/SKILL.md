---
name: niubash
description: Troubleshooting and deep contract for the Niubash shell behind DSH's niubash tool on Windows. Load when paths look wrong (pwd prints /c/... while a native child receives C:\...), a command is missing or resolves to a surprising build, a niu prompt/alias/plugin does not load, wpm install or link repair is needed, the niu debugger/DAP/base64 handoff is involved, a PTC run_code call fails on argument serialization, or documented engine behaviour differs from bash. Do not load for ordinary command execution — the tool description owns calling conventions, truncation, exit codes, timeouts and the shell choice. 中文触发：路径不对 / 命令找不到或版本奇怪 / wpm 安装或链接修复 / niu 调试器 / 引擎行为与 bash 不一致 / PTC 参数序列化报错.
license: MIT
metadata:
  upstream: https://unixwin.dev
  adapted-from: pi-niubash-windows skill (MIT, Copyright (c) 2026 qwased)
---

# Niubash — deep contract (DeepSeek Harness)

Troubleshooting companion to the `niubash` tool. The tool description and the
"Shell choice (niubash)" prompt section own ordinary calling conventions; this
skill owns the engine contract underneath them. Run the live check first; use
`references/` when the host cannot answer.

## State resets between calls

- One `niubash` tool call is one `niu -c <command>` process. `cd`, `export`, shell
  functions, aliases and variables do not survive into the next call. Pass
  `workdir` instead of `cd`, re-establish state, or put the whole sequence in one
  command.
- No rc and no plugins load under `-c`. Point `NIU_ENV=<file>` (or `BASH_ENV`) at an
  init file, or `source` it explicitly at the start of the command.
- Do not nest a shell to "get bash semantics": the outer tool is already the
  shell. `cmd /c` and `wsl` are fine only when the task needs their own native
  semantics (batch built-ins, a Linux distribution), not as a workaround for
  bash behaviour.
- `--ec` / `--encoded-command` fixes quoting for hosts that cannot pass argv
  safely; this tool passes argv verbatim and does not need it, and it never
  lifts the ~32K command-line limit.

## Paths that surprise scripts

The internal form is Windows-native; `/c/...`, `/mnt/c/...` and the install tree
`/usr/...` are deterministic input dialects. The outputs that break naive
comparisons:

| Observation | Meaning | Verify |
|---|---|---|
| `pwd` / `$PWD` prints `/c/Users/...` | POSIX-style spelling inside the shell | `pwd; /usr/bin/pwd` |
| a native child receives `C:\Users\...` | translation happens at the process boundary | `cmd /c cd` |
| `printf '%s\n' /tmp/x` prints `/tmp/x` | literal data is never rewritten | `test -d /tmp && echo real-tmp` |
| `ssh`/`wsl` receive the spelling verbatim | namespace bridges opt out | `command -v ssh` |

Never compare a path to the command input string; resolve both sides
(`test -f C:/...`, `realpath`, or compare `pwd` after `cd`). A path that misbehaves
against the contract is a bug, not a missing variable: there is no
`MSYS_NO_PATHCONV`-equivalent. Full table: `references/paths.md`.

## Interactive boundaries

- There is no PTY: interactive fullscreen programs (`vim`, `tmux`, `ssh -t`,
  `script`) are out of scope.
- Do **not** launch `niu --debug` from inside this tool. The debugger reads
  commands from the controlling terminal and this tool has none, so it can wait
  until the call times out (and then promote to a background job). Use a real
  `niu` TTY, or a DAP client against `niu --dap <script>`.

## DSH result contract

The structured result of `await tools.niubash({...})` (PTC) has three shapes:

- `kind: 'foreground'` — `exitCode`, `signal`, `timedOut`, `aborted`, optional
  `stopped`, `timeoutMs`, and **separate** `stdout`/`stderr`, each
  `{ text, truncated, spillPath? }`. A non-zero `exitCode` is a result, not a tool
  error; a force-killed command settles as `exitCode: 1` without a signal marker
  (an interruption, not a command failure).
- `kind: 'promoted'` — the command outlived `timeoutMs` and keeps running as a
  job (`promoteOnTimeout`, default on). Collect with `job_output`, stop with
  `job_kill`.
- `kind: 'background'` — `run_in_background: true` returned a `jobId` immediately.
  Track every job id you start; collect with `job_output` (`wait: true` only when
  genuinely blocked) and kill jobs that stopped mattering.

Truncation is per stream: the last `maxOutputBytes` (default 64,000) stay in
memory; overflow spills the complete stream to a temp file (cap
`maxSpillBytes`, 64 MiB) and reports its `spillPath`. `truncated` refers to that
tail cap. Read `spillPath` with the read tool when the tail is not enough.

Sandbox: niubash runs with the harness process authority and cannot enforce the
DSH file sandbox. Under a confining session policy (`read-only` /
`workspace-write`) the tool refuses to run — use `pwsh` there, which enforces the
sandbox. It works in `danger-full-access` sessions.

## PTC (run_code) bridge rules

- Tool arguments must be lossless JSON: **omit optional keys entirely**. An
  explicit `undefined` (e.g. `workdir: undefined`) is rejected with
  `binding arguments must be lossless JSON` before the command ever runs.
- The program's return value must also be lossless JSON: no `undefined` members
  — use `null` or omit the key, or the run is marked failed even though its
  output was captured.
- Slice `stdout.text` / `stderr.text` in the script when only a summary is needed;
  curate what you print, because only printed/returned values leave the program.

## Known upstream defects

- Niubash 1.5.0 (rubash before `0ef814fb`) corrupts a pipeline member's argv: in
  a double-quoted word that mixes a live command substitution with an
  apostrophe, the child receives U+0017 instead of `'`. Upstream fix: rubash#3511
  (merged). Workaround: compute the substitution into a variable first, e.g.
  `x=$(date); cmd "it's $x" | cat`. `niu --ec` does not avoid it. Check the pinned
  engine with `"$NIU_SHELL" --version` (it prints the rubash rev).
- Live-verified divergence (2026-11-17, Niubash 1.5.0 / rubash `29bbf52481c3` /
  WinuxCmd 1.2.1): `echo "it's $(echo ok)" | cat` printed `it's ok` with no
  U+0017 — the defect did not reproduce on this pin. Keep the workaround for
  older pins; the host wins for this session.

## Symptom → verify → reference

Run the live check first; use the bundled files when the host cannot answer.
For file inspection prefer DSH's read/grep/glob tools over shell `cat`/`find`.

| Symptom | Live check | Deep reference |
|---|---|---|
| command missing, old, or a surprising build | `command -v <tool>; type -a <tool>` | `references/quickref.md` |
| `command -v sed` prints bare `sed` | `type -a sed` — sed is a shell emulation of the WinuxCmd exe, not a resolution failure | `references/quickref.md` |
| install or links look broken | `"$NIU_SHELL" doctor; wpm links list` | `references/wpm.md` |
| prompt or alias missing | `echo "$PS1"; type -a <alias>` | `references/prompt-plugins.md` |
| plugin manifest / generated loader | `ls ~/.niubash/generated; niu plugin --help` | `references/prompt-plugins.md` |
| path/resolution question | `pwd; /usr/bin/pwd; command -v <tool>` | `references/paths.md` |
| missing Unix command | `wpm installed; wpm search NAME` | `references/wpm.md` |
| skill absent from the session catalog | new session after DSH restart; `registerSkill` row config; provider `dsh-niubash-windows` | this package's README |

Useful facts: `NIU_SHELL` carries the `niu.exe` path to every child; when the host
left `SHELL` unset, Niubash fills it with the same path in `C:/...` spelling
(`NIU_SHELL` keeps `C:\...`), so build scripts should use `NIU_SHELL` for a
byte-stable value. A command installed during the session is runnable
immediately (the resolver's negative cache invalidates), so `hash -r` is
unnecessary. `unset NAME` on an inherited variable removes it for later children.

## Provenance and updates

`references/` holds verbatim upstream snapshots (via the pi-niubash-windows
skill) plus `ATTRIBUTION.md` with the source URL, capture date, per-file SHA256
and the upstream MIT license. The DSH result-contract and PTC sections above
replace the Pi codemode contract of the original skill; do not reintroduce
Pi-only payload shapes (`output`/`exit_code`/`wall_time_seconds`). When updating
Niubash, diff the new bundle against `references/` and refresh both. If a
snapshot disagrees with the live host, the host wins for this session; record
the divergence instead of carrying a local workaround.
