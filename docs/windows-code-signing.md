# Windows code signing

Windows files the Desktop and CLI releases publish are Authenticode-signed through
[Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing), as
**AUTONOMOUS INC.** Signing removes the SmartScreen "Windows protected your PC" prompt from a signed publisher's
installer as reputation builds, lets Smart App Control run the app, and gives antivirus a publisher to trust.

Signing is off until the repository variable `WINDOWS_SIGNING` is `required`. Until then the signing jobs are skipped
and Windows ships unsigned, exactly as before this change.

## What is signed

| Release | Job | Files |
| --- | --- | --- |
| Desktop (`release-desktop.yml`) | `sign-windows` | every `.exe` and `.dll` in `Harness-windows-x64.zip` and `Harness-windows-arm64.zip` (`Harness.exe`, `harness-desktop.exe`, `harness_pipe_io.dll`, Flutter's and the plugins' DLLs), and `harness-install.exe` |
| CLI (`release.yml`) | `pty-sign` | `harness-pty.exe`, `harness-launch.exe`, `harness.exe`, `harness-serial.exe` for x64 and arm64 |

A file that already carries a valid signature keeps it: Microsoft's `conpty.dll` and `OpenConsole.exe` are not
re-signed. A file whose signature is broken fails the job.

## How it works

```
build-windows (x64)   ─┐                            ┌─> upload-windows ─> publish
build-windows (arm64) ─┴─> sign-windows (x64 only) ─┘
pty-build (x64, arm64) ──> pty-sign (x64 only) ──────> windows-staging
```

- **One x64 job per release.** The Artifact Signing action does not run on Windows Arm runners. Authenticode signing
  does not depend on the CPU, so the x64 job signs the arm64 files too.
- **`.github/actions/windows-signing`** does the work:
  1. List every `.exe` and `.dll` without a signature.
  2. Sign in to Azure with the job's GitHub OIDC token (`azure/login@v3`). There is no client secret.
  3. Sign with `azure/artifact-signing-action@v2`, using SHA-256 and an RFC 3161 timestamp from
     `timestamp.acs.microsoft.com`. Artifact Signing certificates last about three days, so the timestamp is what
     keeps a signature valid after that.
  4. Verify every `.exe` and `.dll` with `Get-AuthenticodeSignature`. Each needs status Valid and a timestamp, and
     each one we signed must name `WINDOWS_SIGNING_PUBLISHER`. The check uses the publisher name, not a thumbprint,
     because the certificate changes every few days.
- **Desktop zips are opened, signed and written again** with the entries `package-windows.ps1` writes, under the same
  artifact names (`overwrite: true`). `upload-windows` and `check-windows-zip.py` are unchanged. The manifest's
  sha256 is the hash of the signed bytes.
- **Gate.** `upload-windows` and `windows-staging` accept a skipped signing job only while `WINDOWS_SIGNING` is not
  `required`. Once it is, a failed or skipped signature stops the Windows publish. Nothing falls back to unsigned.
- **Candidate reuse.** While signing is required, `desktop-release-candidate.py` refuses a prepared candidate without
  a successful `sign-windows` job. A candidate built before signing was turned on is rebuilt, not shipped unsigned.
- **PR CI is unchanged.** Signing runs only in the release workflows.

## Setup

### 1. Azure (owner, once)

Identity validation is done: **AUTONOMOUS INC.**, Public Trust, United States, valid until 29 January 2029. Renew
it before then in the portal (Artifact Signing account → Identity validations → Renew).

The remaining steps wait for the organisation's permission grant:

1. **Artifact Signing account.** Create one in the subscription and note its name and region. The endpoint is
   regional, e.g. `https://eus.codesigning.azure.net/` for East US.
2. **Certificate profile.** In the account, create a **Public Trust** profile from the AUTONOMOUS INC. identity
   validation. Note its name.
3. **App registration.** In Microsoft Entra ID → App registrations, create e.g. `openharness-windows-signing`. Note
   its client ID and the tenant ID. Do not create a client secret.
4. **Federated credential.** On that app → Certificates & secrets → Federated credentials → Add:
   - scenario: GitHub Actions deploying Azure resources
   - organization and repository: this repository
   - scenario: **Other issuer**, issuer `https://token.actions.githubusercontent.com`, audience
     `api://AzureADTokenExchange`
   - subject: **`repo:autonomous-ai@98006261/openharness@1322671404:environment:release`**

   This repository uses GitHub's immutable OIDC subject (`gh api repos/autonomous-ai/openharness/actions/oidc/customization/sub`
   shows `use_immutable_subject: true`), which names the org and repository by ID too. The subject the "GitHub
   Actions" scenario writes, `repo:autonomous-ai/openharness:environment:release`, never matches, and `azure/login`
   fails with `AADSTS700213: No matching federated identity record`. Only jobs in that environment can sign, and the
   environment's own rules decide which branches and tags those are.
5. **Role.** On the certificate profile (not the account or the subscription) → Access control (IAM), assign
   **Artifact Signing Certificate Profile Signer** to the app registration.

### 2. GitHub (repository admin)

1. **Environment.** The signing jobs run in the existing `release` environment. Add these to it as environment
   variables (Settings → Environments → `release`). They are identifiers, not secrets:

   | Variable | Value |
   | --- | --- |
   | `AZURE_CLIENT_ID` | the app registration's client ID |
   | `AZURE_TENANT_ID` | the tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | the subscription holding the signing account |
   | `SIGNING_ENDPOINT` | the account's regional endpoint |
   | `SIGNING_ACCOUNT` | the account name |
   | `SIGNING_PROFILE` | the certificate profile name |
   | `WINDOWS_SIGNING_PUBLISHER` | optional: the certificate's common name, `AUTONOMOUS INC.` when unset |

2. **Deployment branches and tags.** `release` allows branch `main` and tags `v*`, which covers `v*_desktop` and
   `v*_cli` tag releases and runs dispatched from `main`. A Desktop candidate prepared from a PR branch
   (`make release-desktop ARGS="--prepare"`) is refused by the environment while signing is required: its
   `sign-windows` fails and the candidate is not made. Either prepare candidates from `main` after the merge, or add
   a branch pattern for candidate branches to the environment.

   Do not add required reviewers. A signing job that waits for approval holds the release run.
3. **Switch.** Settings → Secrets and variables → Actions → **Variables** (repository, not environment):
   `WINDOWS_SIGNING` = `required`. It has to be a repository variable because the jobs' `if:` reads it before any
   environment loads. Set it only after the first test below passes.

## First run and rollout

1. **Lint.** Run `actionlint .github/workflows/release.yml .github/workflows/release-desktop.yml`. PR CI's `plan` job
   lints neither release workflow.
2. **Desktop candidate.** Set `WINDOWS_SIGNING=required`, then from `main` run
   `make release-desktop ARGS="--prepare"` (or **Actions → Release desktop → Run workflow** with
   `prepare_only: true`). This builds, signs and verifies without publishing to users. Check that `sign-windows`
   lists each file, that its summary names AUTONOMOUS INC., and that `upload-windows` passes `check-windows-zip.py`.
3. **CLI dry run.** Run **Actions → Release → Run workflow** with the `metadata-test.json` path. `pty-sign` signs, and
   `windows-staging` publishes to `harness/staging-dry-run`.
4. **On a real PC** (Windows 11, Smart App Control on if possible), download the candidate's or staging installer in
   Edge:
   - File → Properties → Digital Signatures shows AUTONOMOUS INC. with a timestamp.
   - `Get-AuthenticodeSignature harness-install.exe` reports Valid.
   - Smart App Control lets the installer and app run.
   - SmartScreen shows the publisher. A new publisher can still get one prompt until reputation builds; record what
     you see.
5. **Docs.** Once a signed release is out, update the copy that says Windows is unsigned:
   - the `note:` in `docs/superpowers/specs/2026-10-19-windows-installer-design.md` (around line 258) and the installer
     UI text it describes
   - the SmartScreen and Smart App Control rows in that spec and in `2026-10-18-windows-desktop-design.md`
   - the antivirus note in `2026-10-16-windows-native-cli-design.md`

**Turning it off.** Set `WINDOWS_SIGNING` to anything other than `required`, or delete it. Releases then ship
unsigned again. Files already published stay validly signed, because each signature is timestamped.

## Design

- **Growth:** N/A. Nothing is stored. The Azure account logs each signing request; Azure retains those logs.
- **Concurrency:** N/A. Each release signs its own artifacts in its own job.
- **Read cost:** N/A.
- **Scale:** a Desktop release signs about 20 to 40 files and a CLI release 8. The Basic plan includes 5,000
  signatures a month, about 100 releases. The first warning is the Azure quota on the account's metrics page, or a
  `429` in the signing step.
- **Compatibility:** Windows does not care whether a file is signed. The updater and `install.ps1` compare sha256 from
  the manifest, which is computed after signing.
- **Migration and rollback:** see Turning it off. Prepared unsigned candidates are rebuilt automatically.
- **Audience:** Azure enforces it. Only the `release` environment's OIDC subject has the Signer role, and only
  on one certificate profile.
- **Identity:** a dedicated app registration with a federated credential. No person's login and no long-lived secret.
- **Failure:** a signing or verification failure fails the job, and with signing required that stops the Windows
  publish. Nothing ships unsigned silently.
- **Platforms:** Windows x64 and arm64, both signed on an x64 runner. macOS signing (`macos-signing`) is unchanged.

## Not covered yet

- **The updater and `harness-install.exe` do not check the publisher** of what they download; they rely on sha256
  from the manifest. Requiring an AUTONOMOUS INC. signature there is a separate change for after signing is live.
- **`windows-desktop.yml`'s staging release mode** builds unsigned staging packages. Add the same signing job there
  if staging E2E should cover signed files.
- **The Windows Node runtime** (`release-node-runtime-windows.yml`) republishes nodejs.org's `node.exe`, which the
  OpenJS Foundation already signs.
