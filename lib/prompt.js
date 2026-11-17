/**
 * Prompt-facing constants for the `niubash` tool.
 *
 * Ported from pi-niubash-windows `src/prompt.ts` (MIT, Copyright (c) 2026 qwased),
 * adapted for DeepSeek Harness: the sibling shell tool is `pwsh` (not `powershell`),
 * the environment override is `DSH_NIUBASH_PATH`, and the host is DSH.
 *
 * No runtime imports on purpose: unit tests load this module directly.
 */

export const TOOL_NAME = 'niubash'
export const TOOL_LABEL = 'Niubash'

/**
 * Output limits of the capture layer (lib/capture.js defaults mirror these).
 * The description quotes them; keep both in sync.
 */
export const MAX_OUTPUT_BYTES = 64000
export const MAX_COMMAND_CHARS = 32000

export const DESCRIPTION =
  'Execute a bash command in Niubash (`niu -c`), a GNU bash-compatible shell implemented natively ' +
  'for Windows (no WSL, MSYS, Cygwin, or PTY). This is the default shell on this host: prefer it ' +
  'over pwsh for command-line work; use pwsh only for PowerShell-specific tasks. Each call is a ' +
  'fresh process in the session working directory: `cd`, `export`, and shell functions do not ' +
  'persist between calls — pass `workdir` instead of `cd` — and `~/.niubashrc`/plugins do not load. ' +
  'Returns stdout and stderr; long output is truncated to its tail and the full output is saved ' +
  'to a file whose path is reported. Non-zero exits are reported as `[exit code: N]` markers, not ' +
  'tool errors. Paths are Windows-native first-class: `C:/...` always works, `/d/...` and bare `D:` ' +
  'reach drive roots, `/tmp` is the real Windows temp directory, and `~` is `USERPROFILE`; ' +
  '`pwd`/`$PWD` print the `/c/...` dialect while native children receive `C:\\...`, so do not ' +
  'compare path strings with the command input. Niubash prepends its WinuxCmd toolbelt to PATH: ' +
  '`git` (niugit) and `rg` are its bundled builds, `ls`/`find`/`grep`/`awk`/`sed` are WinuxCmd, ' +
  'and `tar` is Windows\' bsdtar; call the full executable path for the stock tool. A single ' +
  `command is limited to about ${MAX_COMMAND_CHARS} characters by the Windows command line; write ` +
  'longer scripts to a file and run that file. No PTY: interactive fullscreen TUI programs are ' +
  'not supported. Commands run with the harness process authority (no file sandbox); under a ' +
  'confining session sandbox this tool refuses to run and pwsh must be used instead. ' +
  'Provide `description` before `command` in the arguments.'

/**
 * The system-prompt section: the shell-selection contract the tool description
 * cannot own alone. Appended after the first-party pwsh guidance (order 1010).
 */
export const PROMPT_SECTION = [
  '## Shell choice (niubash)',
  'Use niubash as the default shell on this Windows host: for command-line work (pipes, loops, scripts, Unix tooling, git, builds, tests) choose it before the pwsh tool.',
  'Use pwsh only when the task needs PowerShell itself — .NET/COM objects, registry, services, event logs, CIM/WMI, remoting, or PowerShell-only modules. Everything else belongs in niubash.',
  'Inside niubash, git and the Unix toolbelt resolve to Niubash\'s bundled niugit, ripgrep and WinuxCmd builds (tar is Windows\' bsdtar); call the full executable path when the stock Windows tool is required.',
  'Use niubash for pipelines and scripts, not for reading or editing files that the read, grep, glob and edit tools handle directly.',
  'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure.',
].join('\n')

/** Shown when `niu.exe` cannot be located; never advertises the preference rule. */
export const UNAVAILABLE_DESCRIPTION =
  'Unavailable: no usable Niubash (niu.exe) was found on this machine, so this tool cannot run ' +
  'commands. Every call fails with the list of paths that were checked and how to install or ' +
  'point DSH at Niubash. Use the pwsh tool until Niubash is available and DSH is restarted.'

export const UNAVAILABLE_SECTION = [
  '## Shell choice (niubash unavailable)',
  'niubash is unavailable on this machine because Niubash (niu.exe) was not found: do not call it; use the pwsh tool for shell work until Niubash is installed and DSH is restarted.',
].join('\n')

export const INSTALL_HINT =
  'Install Niubash from https://unixwin.dev, or set DSH_NIUBASH_PATH (or the plugin config niuPath)'

/**
 * The full unavailable-tool message. Each checked path appears exactly once,
 * annotated with what was found there; the explanation blames the setting that
 * was actually authoritative.
 */
export function unavailableMessage(failure) {
  const lines = ['Niubash (niu.exe) was not found, so the niubash tool cannot run commands.']
  const overrideName = failure.overrideSource === 'config' ? 'The plugin config niuPath' : failure.overrideSource

  if (failure.checked.length === 0) {
    lines.push('Checked: (no candidate paths - PATH is empty and no install directory is known)')
  } else {
    lines.push('Checked:')
    for (const candidate of failure.checked) {
      const suffix =
        candidate.kind === 'other'
          ? ' (not a file: a directory or another special file)'
          : candidate.kind === 'missing'
            ? ' (not found)'
            : ''
      lines.push(`  - ${candidate.path}${suffix}`)
    }
  }

  if (failure.overrideSet) {
    lines.push(`${overrideName} is set, so PATH and the standard install directories were not searched.`)
    if (failure.unexpandedVariable) {
      lines.push(
        `${overrideName} still contains an unexpanded %NAME% reference; DSH does not expand Windows ` +
          'variables in this setting. Use the literal path (a leading ~ is expanded).',
      )
    }
    if (failure.checked.some((candidate) => candidate.kind === 'other')) {
      lines.push(`${overrideName} must point at the niu.exe file itself, not a directory or another special file.`)
    }
  } else if (failure.checked.some((candidate) => candidate.kind === 'other')) {
    lines.push('No usable niu.exe was found; the candidates marked above are not files.')
  }

  lines.push(`${INSTALL_HINT} to the full path of niu.exe, then restart DSH.`)
  return lines.join('\n')
}