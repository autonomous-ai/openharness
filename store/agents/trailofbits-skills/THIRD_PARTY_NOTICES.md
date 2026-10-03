# Third-party notices

**Trail of Bits Skills** — [trailofbits/skills](https://github.com/trailofbits/skills), by Trail of Bits
and the authors named in each plugin's `.claude-plugin/plugin.json`. Creative Commons
Attribution-ShareAlike 4.0 International — `LICENSE-trailofbits`. Not vendored and not modified:
`toolchain/fetch-upstream.sh` fetches the eleven code-audit plugins listed in `VERSIONS` (with the
repository's `LICENSE` and `README.md`) at the pinned commit into `upstream/`, and their skills are
linked into the agent's session as they are. Reports an agent writes with them are the person's output.

**Semgrep** — [semgrep/semgrep](https://github.com/semgrep/semgrep) 1.173.0, LGPL-2.1, Semgrep, Inc.
**pip-audit** — [pypa/pip-audit](https://github.com/pypa/pip-audit) 2.10.1, Apache-2.0, Trail of Bits
and the PyPA. Not vendored: installed from PyPI by `toolchain/setup.sh` into this package's `.venv/`
at the versions `VERSIONS` pins. Semgrep's registry rules carry their own licences; the plugins fetch
only the rulesets they name, at scan time, with metrics off.

**playwright-core** — [microsoft/playwright](https://github.com/microsoft/playwright) 1.63.0,
Apache-2.0, Microsoft Corporation. Installed from npm by `toolchain/setup.sh` at the version pinned in
`package-lock.json`, to print the PDF report. **Chrome for Testing headless shell** — Google,
BSD-3-Clause with the licences in its own `LICENSE.headless_shell`; downloaded into `browsers/` only
on a machine with no Chrome. Neither is vendored.

Everything else here — the manifest, `AGENTS.md`, the `trailofbits-harness` skill, the workspace
template, the report and verdict tool and its tests — is Autonomous's under `LICENSE` (MIT). It is
not an adaptation of Trail of Bits' material, which it loads unchanged.
