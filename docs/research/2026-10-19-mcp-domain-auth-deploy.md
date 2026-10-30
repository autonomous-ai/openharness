# MCP Registry — domain auth deploy runbook

October 19, 2026. We publish the Harness MCP server to the Official MCP Registry under the domain
namespace `ai.autonomous.harness/*` (so no GitHub org Owner is needed). This runs a public-key
auth check against the website. This file lists what DevOps must deploy and the publish steps.

## What changed for the domain namespace

- `server.json` name -> `ai.autonomous.harness/harness`
- `cli/packages/harness-mcp/package.json` `mcpName` -> `ai.autonomous.harness/harness` (npm `0.2.0`)
- `website/scripts/listings.spec.ts` expected name -> `ai.autonomous.harness/harness`

## Step 1 — web team: serve the auth file (MUST be live before login)

Deploy `website/public/.well-known/mcp-registry-auth`, served exactly at:

```
https://harness.autonomous.ai/.well-known/mcp-registry-auth
```

Content (PUBLIC key — safe to commit; the private key is never in this repo):

```
v=MCPv1; k=ed25519; p=PK1G8xTW2TMjhLrYzDNFYv/5+TRosm8SPNip06Fvfug=
```

It lives at `website/public/.well-known/mcp-registry-auth`, which is already under
`public/` (Next.js serves `public/*` at the root), so no `next.config.js` change is needed.
Place it beside the existing `public/llms.txt` and `public/agents/`.

Verify after deploy:

```
curl -s -o /dev/null -w "%{http_code}\n" https://harness.autonomous.ai/.well-known/mcp-registry-auth
# expect 200 (was 404 before)
```

Note: keep it a plain-text file, no trailing whitespace, exactly one line.

## Step 2 — npm: republish with the new mcpName (needs npm org 2FA)

```bash
cd cli/packages/harness-mcp
npm publish --access public       # version 0.2.0, mcpName ai.autonomous.harness/harness
npm view @autonomous-ai/harness-mcp version   # confirm 0.2.0
```

This is additive: `@autonomous-ai/harness-mcp@0.1.0` (old mcpName) stays on npm;
`0.2.0` is what new `npx` installs get. The registry's ownership check reads the latest
published version's `mcpName`, so `0.2.0` must be the version `server.json` names.

## Step 3 — build the release server.json (from the release commit)

Only the repo's `server.json` template lives in `main`; `make mcpb` fills in the real
version + sha256. Run from a checkout of the release tag (e.g. `v0.4.19_cli`):

```bash
make mcpb ARGS="0.4.19"           # writes mcpb/dist/server.json + harness-mcp.mcpb, prints sha256
```

This writes `cli/packages/harness-mcp/mcpb/dist/server.json` with:
- `name: ai.autonomous.harness/harness`
- `version: 0.4.19` (the CLI release the bundle is attached to)
- npm package version `0.2.0`
- the `.mcpb` asset sha256

## Step 4 — login + publish to the Official MCP Registry

Install the CLI and log in with the domain auth (uses the Ed25519 private key, which is
NOT committed — keep it out of the repo, e.g. in a secrets manager or a gitignored file):

```bash
brew install mcp-publisher

# the private key (hex of the `priv:` block) is held separately; feed it via env/file:
mcp-publisher login http --domain harness.autonomous.ai \
  --private-key "<priv hex from the key generated for this deploy>"

mcp-publisher validate cli/packages/harness-mcp/mcpb/dist/server.json
mcp-publisher publish cli/packages/harness-mcp/mcpb/dist/server.json

# confirm
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.autonomous.harness"
```

Order: **web file (1) -> npm (2) -> build server.json (3) -> login+publish (4).**
The registry fetches the npm package (checks `mcpName`) and HEADs the `.mcpb` URL, so
steps 1–3 must be live before `publish`.

## Security

- Public key: committed in `website/public/.well-known/mcp-registry-auth`.
- Private key: **never** commit. Keep it in a secrets manager / gitignored file. Only the
  `mcp-publisher login http --private-key` call needs it.
