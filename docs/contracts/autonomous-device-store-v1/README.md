# Shared OS contract: Autonomous device Store v1

Start with [the Store contract](../../autonomous-device-store.md).

- `request.schema.json`: decrypted request payloads, including optional input defaults.
- `response.schema.json`: successful responses and errors for the four new operations.
- `blender.fixture.json`: executable synthetic Blender walkthrough and a separate existing
  `turn.send` request. Agent IDs, timestamps and doctor output are examples, not a real render.

Schemas are generated from `cli/src/lib/autonomous-device/storeContract.ts`. Tests compare them to
the runtime validators and replay the fixture through the real service with mocked engine/install
boundaries. The separate runtime tests run real fixture setup/doctor/materialization scripts.

```sh
cd cli
npx tsx scripts/device-store-contract.ts --check
npx vitest run src/lib/autonomous-device --maxWorkers=1
```

The new capabilities are `store.list`, `store.inspect`, `agent.prepare`, `operation.get`.
Progress uses polling, not a new event type. `prepare` never sends a task. A timeout is not proof
that no work happened. Keep preparation keys and task keys separate, and read the recovery section
before implementing retries.

This is a source-level handoff, not a published release. Check the running CLI's hello capabilities.
If this contract changes after OS integration begins, coordinate both sides and update this bundle,
its generated schemas, both language guides and the matching fixtures/tests together.
