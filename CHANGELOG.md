# Changelog

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