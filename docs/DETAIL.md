# Niubash for Windows

Run bash commands on Windows through [Niubash](https://unixwin.dev) — a GNU
bash-compatible shell implemented natively for Windows (no WSL, MSYS, or
Cygwin) — without giving up PowerShell.

## Functionality

- A `niubash` tool next to the built-in `pwsh` tool; neither replaces the
  other. A system-prompt section makes niubash the default shell for
  command-line work and reserves pwsh for PowerShell-specific tasks (.NET/COM,
  registry, services, event logs, CIM/WMI, remoting).
- One fresh `niu -c` process per call in the session working directory, with
  per-call `workdir` override and the managed `DSH_*` environment.
- pwsh-style results: stdout + `[stderr]` section, tail truncation with a
  full-output spill file, `[exit code: N]` / `[timed out after Nms]` /
  `[stopped: reason]` markers. Non-zero exits are results, not tool errors.
- Background jobs through the standard job runtime: `run_in_background`
  returns a job id; a foreground command that outlives its timeout keeps
  running as a background job instead of being killed.
- When `niu.exe` is missing, the tool registers as an actionable stub (every
  call lists the checked paths) and the prompt falls back to pwsh.
- A bundled `niubash` troubleshooting skill (deep engine contract, DSH result
  contract, PTC bridge rules, wpm/doctor workflows) registers with the skill
  registry and installs with the package; it loads for anomalies, not for
  ordinary command execution.

## Usage

Ask the agent to run shell work as usual — it will prefer `niubash`. Direct
calls look like:

```jsonc
{ "description": "List markdown files", "command": "ls *.md | wc -l", "timeoutMs": 30000 }
```

Configuration lives in the plugin row (Plugins page): `niuPath`, `timeoutMs`,
`maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`,
`enableRunInBackground`, `promoteOnTimeout`, `preferPrompt`, `registerSkill`. Environment
override: `DSH_NIUBASH_PATH` (absolute path to `niu.exe`).

## Essential limitations

- Windows only; on other platforms the plugin is inert.
- Windows confinement is a write boundary only (reads and network stay open)
  and reports `partial` enforcement; `additionalWritableRoots` apply to file
  tools, not to processes. `danger-full-access` sessions run unconfined by
  design.
- No PTY: interactive fullscreen programs are unsupported. No rc/plugin
  loading (`niu -c`); a single command is capped at 32000 characters, with the
  sandbox runner prefix sharing the same Windows ~32K command-line budget.
- Inside the shell, `git`/`rg` and the Unix toolbelt are Niubash's bundled
  builds; use full executable paths for stock Windows tools.

Verified against Niubash 1.5.1 (rubash `649b3be39b76`, WinuxCmd 1.2.2) on DSH
0.2.2-rc.5.
