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
