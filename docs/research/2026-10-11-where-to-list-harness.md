# Where to list Harness for agents

October 11, 2026. A checklist for putting the `harness` plugin, skill and MCP server (`harness mcp`) where agents
and the people who set them up look. Nothing here has been submitted. Each entry says what it takes, what we need
first, and whether what we have qualifies today. Read from each directory's current docs or repository on this
date; anything marked **unverified** could not be confirmed there.

What we have: the marketplace `.claude-plugin/marketplace.json` (name `openharness`) with the plugin
`plugins/harness/` (the `harness` skill and `.mcp.json` running `harness mcp` over stdio), which Claude Code and
Codex both install; [harness.autonomous.ai/agents](https://harness.autonomous.ai/agents) and `/llms.txt`. The MCP
server is local only: it needs the CLI from `curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash`, with no
npm or PyPI package and no remote HTTPS endpoint.

## The one missing piece

Most MCP directories install a server from a package. An **`.mcpb` bundle** on a GitHub release (a small server
manifest whose command is `harness mcp`, and which says the CLI must be installed) unlocks the Official MCP
Registry, Smithery, and PulseMCP after it. An npm package with `mcpName` would also do, as a wrapper only.

## Checklist

### 1. Our own marketplace (Claude Code and Codex) — done in this branch

- [ ] Merge; deploy `/agents` and `/llms.txt` after a CLI release that has the agent verbs and `harness mcp`.
- [ ] Before each change to the plugin: `claude plugin validate --strict .` (fails today only on the missing
      `version`, which is left out on purpose so installs track `main`).

### 2. Anthropic's plugin directory (claude.ai/directory)

Approved plugins are mirrored into `anthropics/claude-plugins-community` (read-only; pull requests there are
closed). `claude-plugins-official` takes no submissions.

1. A paid Claude plan (Pro or Max, or an Owner on Team or Enterprise).
2. Connect GitHub on claude.ai with an account that can push to `autonomous-ai/openharness`.
3. claude.ai/directory/manage → **Submit new** → **Plugin bundle**: repository `autonomous-ai/openharness`, plugin
   path `plugins/harness`.
4. **Validate** → listing details → data handling → compliance acknowledgements → **Submit for review**. An
   automated scan runs; a reviewer publishes.

Needs first: a README for the plugin of at least 40 words and a license (we have both) that discloses what the
plugin runs and fetches, including that the CLI is installed with curl. Expect a hold for review: their checklist
expects a local MCP server to run a file inside the plugin, and ours runs `harness` from `PATH`. The name `harness`
may be held as close to an existing listing (**unverified**).

### 3. Official MCP Registry (registry.modelcontextprotocol.io)

1. `brew install mcp-publisher`; `mcp-publisher init`; fill `server.json`: name, description (100 characters at
   most), version, repository, and `packages[]` with `registryType`, `identifier` and transport `stdio`.
2. Log in for a namespace:
   - `mcp-publisher login github` gives `io.github.autonomous-ai/*`, for an Owner of the GitHub organization; or
   - DNS: a TXT record `v=MCPv1; k=ed25519; p=<public key>` on `autonomous.ai` gives `ai.autonomous/*` and its
     subdomains; or
   - HTTP: `https://harness.autonomous.ai/.well-known/mcp-registry-auth` with the same line gives
     `ai.autonomous.harness/*` only.
3. `mcp-publisher publish`; check `https://registry.modelcontextprotocol.io/v0.1/servers?search=harness`. A
   published version cannot be changed.

Needs first: the package. For `mcpb`: an https release asset on github.com whose URL contains "mcp" (for example
`/autonomous-ai/openharness/releases/download/<tag>/harness-mcp.mcpb`) and its `fileSha256`. A metadata-only entry
may be accepted (**unverified**) but no client could install it. Does not qualify today.

### 4. Smithery (smithery.ai)

1. `npm i -g smithery@latest` (Node 20+); `smithery auth login`.
2. `smithery mcp publish ./harness.mcpb -n <namespace>/harness`. The web form at smithery.ai/new takes only a
   public Streamable HTTP URL.
3. Settings → Verification for the vendor checklist.

Needs first: the same `.mcpb`, and a Smithery namespace (how one is made: **unverified**). Does not qualify today.

### 5. PulseMCP (pulsemcp.com)

Submissions are paused (pulsemcp.com/submit, updated September 3). It says it picks up servers from the Official
MCP Registry, so item 3 covers it.

### 6. Cursor

- **Marketplace** (cursor.com/marketplace/publish; public, open-source repositories; every plugin and update
  reviewed by hand). Cursor encourages a plugin over a standalone MCP listing. Needs first, beside what we have:
  `plugins/harness/.cursor-plugin/plugin.json` (only `name` is required), a root `.cursor-plugin/marketplace.json`
  pointing at `plugins/harness`, and `plugins/harness/mcp.json` with
  `{"mcpServers":{"harness":{"command":"harness","args":["mcp"]}}}`. Test from `~/.cursor/plugins/local/harness` and
  **Developer: Reload Window**. Cursor's docs do not say whether it reads `.claude-plugin`.
- **Add to Cursor link**, no submission: `cursor://anysphere.cursor-deeplink/mcp/install?name=harness&config=eyJjb21tYW5kIjoiaGFybmVzcyIsImFyZ3MiOlsibWNwIl19`
  (the config is base64 of `{"command":"harness","args":["mcp"]}`). It could go on `/agents` once `harness mcp` is
  released.
- **cursor.directory**: answered 429 to every request; **unverified**.

### 7. Glama (glama.ai/mcp/servers)

1. **Add Server** with the repository, then add a Dockerfile in the server's admin page: Glama runs every server in
   a container and lists it when it starts and answers introspection (initialize, tools/list).
2. Claim it: a root `glama.json`, `{"$schema":"https://glama.ai/mcp/schemas/server.json","maintainers":["<github-user>"]}`,
   then run the claim again.

Needs first: the Dockerfile (install the CLI, then `harness mcp`), `glama.json`, and `harness mcp` answering
initialize and tools/list with no daemon or tmux running (not checked). How the score is computed: **unverified**.
A passing Glama listing is what the largest awesome list (item 9) asks for.

### 8. Skills and OpenAI's plugin directory

- **OpenAI's public plugin directory** (ChatGPT and Codex; platform.openai.com/plugins → upload): a verified
  identity, a ZIP with `.codex-plugin/plugin.json` (or `.claude-plugin/plugin.json`, which the portal converts) and
  at least one skill, safety scans, policy attestations, no lifecycle hooks; display name and short description of
  30 characters at most. With an MCP server it needs a public HTTPS endpoint, so ours goes as **skills only**:
  the skill without `.mcp.json`. Qualifies as skills only.
- **agentskills.io**: the format and a list of clients; no registry.
- **openai/skills**: deprecated in favour of openai/plugins, which OpenAI curates; no contribution path found.
- **anthropics/skills**: no submissions.
- **skills.sh**: ranks skills from the `skills` CLI's usage (`npx skills add autonomous-ai/openharness`); no form;
  how a skill first appears: **unverified**.
- **VoltAgent/awesome-agent-skills**: a pull request adding `- **[autonomous-ai/harness](<url>)** - <10 words or
  fewer>`, titled `Add skill: autonomous-ai/harness`. It asks for real community use first.

### 9. Lists

- **punkpeye/awesome-mcp-servers**: a pull request to README.md, alphabetical under Coding Agents or Developer
  Tools: `- [autonomous-ai/openharness](https://github.com/autonomous-ai/openharness) <Glama badge> 📇 🏠 🍎 🐧 - <description>`.
  Its checks want the Glama listing (item 7) and its badge. Submit as a person, without the agents' fast-track
  marker its CONTRIBUTING mentions.
- **wong2/awesome-mcp-servers**: no pull requests; the form at mcpservers.org/submit (free review within about two
  weeks).
- **appcypher/awesome-mcp-servers**: one item per pull request, at the end of Development Tools; not updated since
  May.
- **hesreallyhim/awesome-claude-code**: the web issue form only, filed by a person; the project must be 14 days old
  and active, or have 100 stars; one line, no emoji.
- **davila7/claude-code-templates** (aitmpl.com): a pull request adding `cli-tool/components/mcps/<category>/harness-mcp.json`;
  every example there uses `npx`, so whether a command on `PATH` is accepted is **unverified**.
- **davepoon/buildwithclaude**: a pull request under `plugins/`, titled "Add harness plugin"; it also says it
  indexes plugin marketplaces (how: **unverified**).
- **claudemarketplaces.com**: updated automatically; no form (**unverified**).
- **RoggeOhta/awesome-codex-cli**: an issue or pull request; Codex-specific entries with a star badge.

## In order

1. Merge this branch and the `harness mcp` change; release the CLI; deploy `/agents` and `/llms.txt`.
2. Anthropic's directory and OpenAI's (skills only): no new files.
3. The `.mcpb` release asset and `server.json`; choose the namespace (an organization Owner for
   `io.github.autonomous-ai`, or the HTTP file on harness.autonomous.ai). Then the Official Registry, Smithery,
   and PulseMCP through the registry.
4. The Cursor files, then its marketplace; the Add to Cursor link on `/agents`.
5. Glama (Dockerfile, `glama.json`), then the MCP awesome lists.
6. The Claude Code and skills lists once the project meets their age and use rules.

Sources read: code.claude.com/docs/en/plugins (marketplaces, publish), claude.com/docs/plugins (submit,
pre-submission checklist); github.com/modelcontextprotocol/registry (docs, validators, auth handlers);
smithery.ai/docs; glama.ai/blog (glama.json, hosting); pulsemcp.com/submit; cursor.com/docs (plugins, MCP install
links); developers.openai.com/plugins (build, submission, submitting a Claude Code plugin); agentskills.io;
skills.sh/docs; and the README and contributing rules of each list above.
