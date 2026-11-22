# Changelog

## 0.2.1

Documentation only, no runtime change. Re-verified against Niubash 1.5.1
(rubash `649b3be39b76`, WinuxCmd 1.2.2) on DSH 0.2.2-rc.5.

- The rubash#3511 apostrophe/argv defect is recorded as fixed upstream and no
  longer reproducing: `echo "it's $(echo ok)" | cat` is byte-exact on the 1.5.1
  pin (verified 2026-11-23), so the variable-first workaround is scoped to
  engines older than 1.5.1 instead of being presented as current.
- The `command -v sed` bare-name symptom is now conditional on older WinuxCmd
  builds (1.5.1 prints the full path), and the requirement table names the tested
  engine baseline.
- The bundled skill records the PTC call contract measured on this host:
  required `description`, `workdir` validation before spawn, rejections instead
  of result codes, the absence of marker lines in the structured streams,
  `promoted.output` as a consuming read, and `timeoutMs` layering against the
  `run_code` budget.
- Truncation wording made exact: the retained tail can exceed `maxOutputBytes` by
  one read chunk, and a spill that reaches `maxSpillBytes` is not flagged.

## 0.2.0

- Bundled troubleshooting skill, installed with the package: `skill/SKILL.md`
  plus verbatim upstream `skill/references/` snapshots (SHA256-verified against
  pi-niubash-windows). Registered on `ctx.skills` as provider
  `dsh-niubash-windows` (`source: bundled`, rank 600) through optional
  injection, so it works with or without the job runtime and even when niu.exe
  is missing; user/project filesystem skills still override it.
- Skill content adapted to DSH: the Pi codemode payload section is replaced by
  the DSH result contract (separate stdout/stderr, exit-code markers, timeout
  promotion, spill paths) and PTC `run_code` bridge rules (lossless-JSON
  arguments and return values, job tracking). Adds the sed shell-emulation
  check and a live-verified note that the rubash#3511 apostrophe defect does
  not reproduce on pin `29bbf52481c3`.
- New row config `registerSkill` (default `true`); `skill` added to the package
  `files` list. Unit tests cover frontmatter parsing, candidate/definition
  shape, and persistent-failure semantics.

## 0.1.1

- Fix misleading diagnostics (tester anomaly A1): a nonexistent or non-directory
  `workdir` is now refused before spawn with `working directory does not exist:
  <path>` (invalid-args at the tool layer, synchronous guard in the process
  layer) instead of being misreported as a missing niu.exe — spawn ENOENT looks
  identical for a bad cwd and a bad executable.

## 0.1.0

Initial release, ported from pi-niubash-windows 0.1.0 onto DeepSeek Harness.

- `niubash` tool over a self-contained `niu -c` process layer (the ctx.shell
  seam keeps its single pwsh executor; the two shells coexist).
- Prompt section (order 1015) making niubash the default shell, pwsh reserved
  for PowerShell-specific work; unavailable variant when niu.exe is missing.
- pwsh marker parity: `[stderr]`, truncation + spill paths, timeout/stopped/
  exit markers; non-zero exits are results.
- Job integration: `run_in_background`, foreground-as-job, timeout promotion,
  live output pull sources, external kill reasons.
- Managed `DSH_*` environment via ctx.shellEnv; NO_COLOR/PAGER/GIT_PAGER.
- Sandbox honesty: refuses confining session policies instead of bypassing
  the file sandbox.
- niu.exe resolution: config niuPath → DSH_NIUBASH_PATH → PI_NIUBASH_PATH →
  PATH → standard install directories, with annotated failure reporting.
- Unit tests (resolution/capture/render/helpers) and a real-niu smoke test.