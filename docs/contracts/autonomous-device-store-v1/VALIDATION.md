# Validation — 2026-09-23

Source changes only. No commit/push, daemon restart, live CLI installation, robot deployment,
Blender installation, paid model task or airplane render was performed.

Verified:

- TypeScript typecheck: passed.
- CLI build (`npm --prefix cli run build`): passed.
- Device suite: 117 tests passed in 8 files (includes the added restart/readiness regression).
- Broader Store/install/update/catalog/materialization, project folder, creation receipt,
  backend DSH and device regression run: 234 passed in 16 files, before the one additional
  device restart/readiness test. These counts overlap; do not add them.
- Final schema/fixture tests: 2 passed after checking malformed requestId error responses.
- Generated request/response JSON schemas match runtime Zod validators. Request defaults are
  optional inputs; invalid/missing requestId can be echoed/omitted in error responses.
- `git diff --check`: passed.

The first broader run used `/bin/sh` and one pre-existing materialization test saw an extra
`logout` line from that interactive shell. Re-running with `/bin/zsh` and an empty temporary
`ZDOTDIR` passed the full selected regression suite. Product shell behavior was not changed.
Runtime adapter tests use real temporary setup/doctor scripts and workspace materialization;
only their shell selection is isolated from the operator's profile. Engine creation is mocked.
Other device tests use isolated temporary durable journals/creation receipts and mock package
or engine boundaries. Transport tests verify role, encryption and hello gating at the existing
relay seam; this is not a physical Lamp acceptance run.

Reproduce the broader selection from `cli/` with an empty temporary ZDOTDIR:

```sh
SHELL=/bin/zsh ZDOTDIR=/path/to/empty-test-zdot npx vitest run \
  src/lib/autonomous-device \
  src/lib/agentCreationReceipt.spec.ts src/lib/projectFolder.spec.ts \
  src/dsh/catalog.spec.ts src/dsh/install.spec.ts src/dsh/materialize.spec.ts \
  src/dsh/service.spec.ts src/dsh/update.spec.ts src/backendSocket.dsh.spec.ts \
  --maxWorkers=1
npm run typecheck
npx tsx scripts/device-store-contract.ts --check
npm run build
```

Next joint acceptance: install the new CLI through the machine's authorized lifecycle helper,
verify existing LAN connectivity, confirm all four capabilities in a real Lamp hello, then run
discover → inspect → prepare/poll → separate turn.send against Blender. Record actual engine
login/permission prompts and generated artifacts. OS must not report a rendered airplane from
this validation or from preparation reaching ready.


## Desktop reveal and first-turn readiness follow-up

- Reproduced the reported Blender block on a real running agent: its terminal displayed the Claude
  input prompt, the registry had `active=true`, `launch.state=ready`, and `sessionId=""`; preparation
  remained `running/launch`. No test prompt was sent to force a native session into existence.
- Runtime readiness now reuses confirmed launch state, with explicit `engineAuthentication=unknown`.
- Follow-up CLI device/local WebSocket selection: 135 tests passed in 9 files; TypeScript typecheck,
  CLI build and generated schema check passed.
- Desktop dial/preparation selection: 21 tests passed. Targeted Flutter analysis passed.
- UI tests use a fake machine/terminal and assert concurrent opens, existing-tab reuse and one viewer;
  durable delivery tests use temporary journals and simulated disconnect/restart/acknowledgement.
  They do not establish a physical robot-to-Desktop end-to-end acceptance run or a rendered airplane.
- This follow-up changes readiness semantics, but does not change OS JSON schemas or capability names.
  OS integrators must read the handoff update in both language versions of the contract.
