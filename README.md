# Niubash for Windows

Adds a `niubash` tool to DeepSeek Harness that runs bash commands through
[Niubash](https://unixwin.dev) — a GNU bash-compatible shell implemented
natively for Windows — while the built-in `pwsh` tool stays untouched next to
it. A prompt section makes niubash the default shell; pwsh remains the choice
for PowerShell-specific work.

## What it does

- Registers `niubash` (never overrides `pwsh` or any other tool).
- Each call is a fresh `niu -c <command>` process in the session working
  directory; `workdir` overrides it per call. No rc files or plugins load.
- Foreground results mirror the pwsh marker contract: stdout, `[stderr]`
  section, `[output truncated; full output: <path>]`, `[timed out after Nms]`,
  `[stopped: <reason>]`, `[exit code: N]`. Non-zero exits are results, not
  tool errors.
- Per-stream output keeps the last 64,000 bytes in memory; overflow spills the
  complete stream to a temp file (cap 64 MiB) whose path is reported.
- With the job runtime composed (`dsh-jobs-local` + `dsh-tool-jobs`, part of
  the standard desktop profile):
  - `run_in_background: true` returns a job id immediately; collect with
    `job_output`, stop with `job_kill`.
  - Every foreground command is a job from its start; a command that outlives
    its timeout keeps running and the call returns
    `[still running after Nms; moved to background job <id>]`.
- Managed `DSH_*` environment: collected through `ctx.shellEnv` exactly like
  pwsh, layered over the harness environment with `NO_COLOR=1 PAGER=cat
  GIT_PAGER=cat`.
- Safety: niubash runs with the harness process authority and cannot enforce
  the DSH file sandbox. Under a confining session policy (`read-only` or
  `workspace-write`) the tool refuses to run and points at pwsh; it works in
  `danger-full-access` sessions.
- When `niu.exe` is missing, a same-schema stub is registered: every call
  fails with every checked path and how to fix it, and the prompt says
  "use pwsh" instead of advertising a preference that cannot be honored.
- Outside Windows the plugin is inert: no tool, no prompt section.

## Requirements

| Component | Version |
|---|---|
| DeepSeek Harness | 0.1.0-rc.2 … <0.3.0 (verified on 0.2.2-rc.3, desktop profile) |
| Niubash | 1.5.0 or later (`niu.exe`, MIT, <https://unixwin.dev>) |
| OS | Windows (verified on Windows 11; other builds untested) |

## Install

From npm, through any of the three DSH entry points:

```text
plugin_manager install_bundle target=dsh-niubash-windows
```

```bash
dsh plugin --profile <profile> add dsh-niubash-windows
```

or **Plugins → Add plugin** with `dsh-niubash-windows` as the install spec.
Each route activates the bundle in that profile, inserting one row
(`id: niubash`); no profile file is edited by hand. Pin a version with
`dsh-niubash-windows@0.2.0` when a later release should not be picked up.

From a local checkout (development), install the directory instead:

```text
plugin_manager install_bundle target=D:\dsh-wsl-project\dsh-niubash-windows
```

or **Plugins → Add plugin → local directory**.

## Configuration

Row config (Plugins page) or the bundle patch:

| Field | Default | Meaning |
|---|---|---|
| `niuPath` | `''` | Explicit `niu.exe` file path; authoritative when set |
| `timeoutMs` | `120000` | Default foreground timeout (ms) |
| `maxTimeoutMs` | `600000` | Cap for per-call `timeoutMs` overrides |
| `maxOutputBytes` | `64000` | Per-stream in-memory tail retention |
| `maxSpillBytes` | `67108864` | Per-stream full-output spill cap |
| `graceMs` | `3000` | Kill escalation / pipe-drain grace |
| `enableRunInBackground` | `true` | Expose `run_in_background` while jobs are composed |
| `promoteOnTimeout` | `true` | Timed-out foreground commands keep running as jobs |
| `preferPrompt` | `true` | Inject the "prefer niubash over pwsh" prompt section |
| `registerSkill` | `true` | Register the bundled `niubash` troubleshooting skill |

`niu.exe` resolution order: `niuPath` config → `DSH_NIUBASH_PATH` →
`PI_NIUBASH_PATH` (continuity with the Pi extension) → `PATH` →
`%LOCALAPPDATA%\Programs\Niubash\niu.exe` → `%ProgramFiles%\Niubash\niu.exe`.
The lookup happens once at plugin activation; restart DSH after installing or
moving Niubash. An authoritative setting that points at a directory, a missing
file, or an unexpanded `%NAME%` is reported, not silently ignored.

## Shell choice

| Task | Tool |
|---|---|
| bash syntax, pipes, loops, heredocs, shell scripts | `niubash` |
| Unix tooling (`rg`, `sed`, `awk`, `tar`, …) | `niubash` |
| `git`, builds, test runners, language toolchains | `niubash` |
| .NET / COM, registry, services, event logs, CIM/WMI, remoting | `pwsh` |
| Reading, editing, searching files | `read` / `edit` / `grep` / `glob` |
| Interactive fullscreen TUI (`vim`, `ssh -t`, `tmux`) | neither — no PTY |

Inside niubash, `git`/`rg`/`ls`/`find`/`grep`/`awk`/`sed` resolve to Niubash's
bundled WinuxCmd builds (`tar` is Windows' bsdtar); call the full executable
path for the stock tool. `pwd` prints the `/c/...` dialect while native
children receive `C:\...`. A single command is limited to about 32K characters
by the Windows command line — write longer scripts to a file and run it.

## Bundled skill

The package ships a troubleshooting skill (`skill/SKILL.md` +
`skill/references/`) and registers it with the DSH skill registry as provider
`dsh-niubash-windows` (`source: bundled`, rank 600). It installs with the
package — no separate `~/.dsh/skills` entry — and appears in the skill catalog
of new sessions after a DSH restart. The skill is deliberately gated: it loads
for path anomalies, missing/surprising commands, wpm/doctor repair, niu
debugger questions, PTC serialization failures, and engine-vs-bash divergence,
not for ordinary command execution (the tool description owns that contract).

Adapted from the pi-niubash-windows skill: the Pi codemode payload section is
replaced by the DSH result contract (separate streams, exit-code markers,
timeout promotion, spill paths) and PTC `run_code` bridge rules (lossless-JSON
arguments and return values). `references/` are verbatim upstream Niubash
snapshots with SHA256 provenance in `ATTRIBUTION.md`. A user-level
`~/.dsh/skills/niubash` (rank 400) or project skill overrides the bundled copy;
set `registerSkill: false` to opt out entirely.

## Known limitations

- No file-sandbox enforcement (see Safety above); confining sessions must use
  pwsh.
- No PTY emulation; interactive fullscreen programs are out of scope.
- `niu -c` loads no rc and no plugins; use `NIU_ENV=<file>` when a command
  needs an initialization file.
- Niubash 1.5.0 pipeline argv defect (upstream rubash#3511): a double-quoted
  pipeline argument mixing a live command substitution with an apostrophe
  delivers U+0017 instead of `'`. Compute the substitution into a variable
  before the pipeline until the fixed engine ships. Not reproduced on rubash
  `29bbf52481c3` (verified 2026-11-17); check the pin with
  `"$NIU_SHELL" --version`.
- The child environment inherits the harness environment (minus ambient
  `DSH_*`, plus the managed snapshot); unlike the pwsh executor it does not
  scrub ambient credentials beyond that.

## Development

```bash
npm test           # unit tests: resolution, capture, render, helpers (no Niubash needed)
npm run test:smoke # end-to-end against the real niu.exe (skips when absent)
```

Layout:

```text
index.js          plugin entry: platform gate, resolve, prompt section, registration
lib/niu.js        pure niu.exe resolution (config → env → PATH → install dirs)
lib/prompt.js     tool name, description, prompt section, unavailable texts
lib/capture.js    bounded stream capture with spill file + offset readers
lib/process.js    niu -c process handles (deadline, tree kill, observed reads)
lib/render.js     model-facing result text (pwsh marker parity)
lib/util.js       pure helpers: workdir, env layering, startup-error guidance
lib/tool.js       defineTool + ctx.jobs adaptation (background, promotion)
lib/skill.js      bundled skill provider (frontmatter parse, list/get)
skill/            SKILL.md + verbatim upstream references (troubleshooting)
test/             unit tests and the opt-in smoke test
docs/DETAIL.md    plugin detail page
```

## License & attribution

MIT — see [LICENSE](LICENSE). Ported from
[pi-niubash-windows](https://github.com/qwased/pi-niubash-windows) (MIT,
Copyright (c) 2026 qwased); the execution/job/marker contracts follow
DeepSeek Harness's `dsh-tool-pwsh` (MIT). The bundled skill adapts the
pi-niubash-windows skill (same upstream); `skill/references/` keeps verbatim
Niubash documentation snapshots under their upstream MIT license.