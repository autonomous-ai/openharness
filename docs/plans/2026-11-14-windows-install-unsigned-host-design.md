# installPs1.spec builds its unsigned terminal host the way the other install cases do

## Problem

windows.yml's step "Two real builds: the pty host rollover and the payload install" is red on both Windows jobs (x64
and arm64, run 43560364769 on 2026-11-14). It had not run since 2026-11-02, because an earlier step in the same job was
red, so the `install` job after it was skipped as well. Two cases in `cli/src/scripts/installPs1.spec.ts` fail with
the installer's refusal, the Restricted case with:

```
The terminal host is not signed as Harness releases are, so Windows can block it, and it was not installed:
harness-pty.exe is UnknownError; harness-launch.exe is UnknownError; harness.exe is NotSigned; ...
```

- "installs by irm | iex under the Restricted execution policy, and harness then runs from a Restricted PowerShell"
  (the `after 0` expectation);
- "removes a terminal host probation marker when it moves current-pty, and keeps it when the pointer stays" (the
  `moved.status` expectation).

## Cause (confirmed)

#4018 (2026-11-11) made `install.ps1` refuse a terminal host that is not signed as Harness releases are
(`Assert-HarnessPtySigned`, on the unpacked host and on a version folder already there), as designed. A developer's or
CI build is unsigned; `HARNESS_ALLOW_UNSIGNED=1` is the existing, documented door for it (docs/windows-code-signing.md;
windows.yml's `install` job sets it; the updater's `ptySignatures.ts` reads it). The spec's `install()` helper already
passes it for every unsigned build.

The two red cases do not go through that helper:
- the Restricted `irm | iex` case builds its own environment for `powershell.exe` (it needs `HARNESS_INSTALL_MANIFEST`
  rather than `-Manifest`), without the allowance;
- the probation case calls `Install-HarnessPty` through `ps()` on version folders of placeholder text files, which the
  check on a version folder already there now refuses.

So `install.ps1` behaves correctly; the two cases set up their build differently from the rest of the spec. #4018's own
CI did not show it because this step was skipped.

## Change

Test-only, in `cli/src/scripts/installPs1.spec.ts`. `install.ps1`, the updater and every workflow stay as they are:

1. **One environment for an install run.** A helper `installEnv(home, subkey, env = {}, modulePath = 'default')`
   builds the environment every whole install run uses (`USERPROFILE`, `HARNESS_INSTALL_ENV_KEY`,
   `HARNESS_ALLOW_UNSIGNED=1`, then `env`), over `powershellEnv(modulePath, ...)`. `install()`, the
   Restricted `irm | iex` case and the `irm | iex` failure case ("reports the failure and leaves the PowerShell it was
   iex-ed into running", green today because it fails before the terminal host) all use it, so no whole install case
   builds its own environment.
2. **The probation case allows its placeholder host as the rest of the spec does.** Both of its `ps()` calls
   (`Install-HarnessPty` on version folders of placeholder text files) pass `{ HARNESS_ALLOW_UNSIGNED: '1' }`, the same
   door "names each terminal host file that is unsigned or signed by someone else" already uses. One way: no
   function override. The signature check keeps its own case (that one, which asserts the refusal without the door).
3. **No dead parameter.** `install()`'s `signed` parameter has no caller (#4018 added it without a case that passes
   it), so it goes, with the comment that names a case that does not exist.
4. **The check stays wired in.** With 1 and 2, every case that runs `Install-HarnessPty` allows its unsigned host,
   and the probation case's red was the only test that held it to `Assert-HarnessPtySigned`. A case in
   `install.ps1, as written` (it runs on every platform, PR CI too) requires both calls, on the unpacked download
   before it moves into place and on a version folder already there before `current-pty` names it. Found in the final
   review.

The refusal on real installs stays exactly as strict: no new switch, environment variable or flag.

## Tests

The red tests are the two existing cases, red on Windows today (run 43560364769, both jobs). After the change both pass,
with the rest of `installPs1.spec.ts`, on windows.yml's step on x64 and arm64. They run only on Windows
(`describe.runIf(windows)`), so the red-then-green evidence is that workflow run, started only with the orchestrator's go.
The wiring case (Change 4) guards code that is already right, so its red is shown on `install.ps1` with either
`Assert-HarnessPtySigned` call removed, locally, and not committed.

## Same cause elsewhere

A search of the CLI's specs for runs of `install.ps1` or `Install-HarnessPty` (`cli/src`, `*.spec.ts`) finds the
terminal host installed only by `installPs1.spec.ts`; `installPs1App.spec.ts` runs `-App` installs of a desktop
fixture, which install no terminal host. `windowsCiChecks.spec.ts` and the windows.yml `install` job already set the
allowance. windows-desktop.yml also runs `installPs1.spec.ts`, so the same change fixes it there.

## Platforms

Windows x64 and arm64 (test only). macOS and Linux skip these cases.
