# Data Studio

Drop a CSV into a working analytical dashboard. Change measures, compare groups, narrow the period,
switch between trends and bars, inspect exact values and export the filtered rows. Charts and
summaries derive from your data. Errors and empty selections stay visible.

The starter runs entirely locally with no chart-library CDN. It includes a quoted-field CSV parser,
safe imports and keyboard-accessible point inspection. Browser imports are temporary until exported.
The default view expects two text dimensions plus a numeric measure; the agent can adapt that schema.

Try: “Compare regional revenue across quarters, show what changed, and let me explore the raw rows.”

Choose **Data Studio** in the Harness Store, then New Harness and an empty folder. Local development:

```sh
harness dsh install "$PWD/store/agents/data-studio" --link
harness dsh doctor autonomous/data-studio
```

Requires Node 20+ and the shared Web Viewer. Browser proofs are optional development tooling, but
the readiness helper requires a successful real-browser check; file existence is not proof.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
