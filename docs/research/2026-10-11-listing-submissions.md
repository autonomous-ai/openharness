# Listing submissions

October 11, 2026. What to paste and what to run for each directory in
[the checklist](2026-10-11-where-to-list-harness.md). Nothing here has been submitted or published. **Owner** marks a
step that needs an account only the owner (or an Owner of the `autonomous-ai` GitHub organization) has; the rest
needs only a GitHub account that can open a pull request. Formats and limits were read from each directory's docs or
repository on this date; **unverified** marks what could not be confirmed there.

## Before any of it

| Waits for | What |
|---|---|
| Monday's CLI release, the first with `harness mcp` | the `.mcpb` asset, the registry, Smithery, Glama's image, deploying `/agents` and `/llms.txt` |
| `@autonomous-ai/harness-mcp` published to npm (`cli/packages/harness-mcp`, `cli/RELEASE.md`; an npm account in the `autonomous-ai` organization, **Owner**) | the npm entry in `server.json`, the goose link and every `npx` line |
| Glama's listing and its badge | the largest MCP awesome list |

### The bundle, after the release

`make release-cli` tags `vX.Y.Z_cli` and CI cuts the GitHub Release. Then, from a checkout of that commit, with the
released version:

```
make mcpb ARGS="<version>"
gh release upload v<version>_cli cli/packages/harness-mcp/mcpb/dist/harness-mcp.mcpb --repo autonomous-ai/openharness
curl -fsSL https://github.com/autonomous-ai/openharness/releases/download/v<version>_cli/harness-mcp.mcpb | shasum -a 256
```

`make mcpb` prints the bundle's sha256 and writes `cli/packages/harness-mcp/mcpb/dist/server.json` with the version,
the asset's URL, that sha256 and the npm package's version. The last line must print the same sha256. A rebuild a
minute later gives another one (the zip records file times), so upload the file that build wrote and do not rebuild in between. Uploading
to a release needs write access to the repository.

## The text

Privacy policy, where a directory asks for one: https://www.autonomous.ai/privacy (Autonomous, Inc.; also in the
bundle manifest's `privacy_policies`).

Use the same words everywhere.

- **Name**: Harness
- **Repository**: https://github.com/autonomous-ai/openharness (MIT)
- **Page for agents**: https://harness.autonomous.ai/agents · plain text: https://harness.autonomous.ai/llms.txt
- **Plugin**: https://github.com/autonomous-ai/openharness/tree/main/plugins/harness
- **Skill**: https://github.com/autonomous-ai/openharness/blob/main/plugins/harness/skills/harness/SKILL.md
- **Very short** (29 characters, for limits of 30): Run coding agents in parallel
- **Short** (94 characters; the registry allows 100): Start Claude Code and Codex agents the person can watch,
  wait for them and read their answers.
- **One line** (for lists): Run Claude Code and Codex agents in tmux sessions the person can watch: start, wait for,
  read and close them over MCP or the CLI.
- **Long**:

  > Harness runs coding agents (Claude Code, Codex and others) in terminal sessions called harnesses, on the
  > person's own computers, and shows every one in its desktop, web and phone apps. An agent uses it to run other
  > agents beside its own work: start a harness on a task in a folder, wait for it, read its answer, send it a
  > follow-up and close it. The person can watch, answer or stop any of them.
  >
  > It comes as a CLI (`harness ps`, `new`, `wait`, `show`, `send`, `close`), an MCP server over stdio
  > (`harness mcp`) and a skill. An agent may give work to, and close, only the harnesses it started; the rest are
  > the person's. It runs on macOS and Linux, and needs no account for harnesses on the same computer.

- **Tags**: agents, parallel, claude-code, codex, orchestration, tmux, mcp, developer-tools
- **Tools**:

  | Tool | What it does |
  |---|---|
  | `harness_whoami` | who the agent is, on which machine, whether it may start harnesses now, and its limits |
  | `harness_list` | the harnesses on this machine: state, who started each, what each is about |
  | `harness_start` | start Claude Code or Codex on a task in a folder, by name; returns at once |
  | `harness_wait` | wait until harnesses stop working (up to 600 seconds a call) |
  | `harness_read` | a harness's state, its last ask and its answer |
  | `harness_close` | close a harness it started; the conversation is kept |
  | `harness_send` | a follow-up to a harness it started; offered only when the server runs inside a harness |

  Where Harness is not installed, the npm package and the bundle offer one tool instead, `harness_setup`, which
  says how to install it.

- **Install**:

  ```
  curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
  harness start
  ```

  MCP, with the CLI on the PATH: `{"command": "harness", "args": ["mcp"]}`.
  MCP, for clients that take npx: `npx -y @autonomous-ai/harness-mcp` (it runs `harness mcp`).
  Claude Code: `claude mcp add harness -- npx -y @autonomous-ai/harness-mcp`, or the plugin:
  `claude plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins`, then
  `claude plugin install harness@openharness`.
  Codex: `codex plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin --sparse plugins`, then
  `codex plugin add harness@openharness`.

- **What it runs and fetches** (for forms that ask): the plugin, the npm package and the bundle run the `harness`
  command (`harness mcp`) and nothing else. The installer (`cli/scripts/install.sh`) downloads, checksum-verified,
  a Node runtime, the CLI, its terminal client `hn` and the `grid` tool from Harness's release storage into
  `~/.harness`, links `harness` into `~/.local/bin`, and gets tmux where it is missing (Homebrew, apt, or a managed
  build on a Mac). On a computer with no coding agent, run by a person at a terminal, it also downloads OpenCode.
  Harnesses, their files and transcripts stay on the person's computers; only what reaches the person's other
  machines and phone, after `harness login`, goes through Harness's relay.

## 1. Official MCP Registry (registry.modelcontextprotocol.io) — **Owner**

Publishes `server.json`: the npm package and the `.mcpb`, both run over stdio. Clients and directories that read the
registry (PulseMCP among them) pick it up from there.

Order matters: the registry fetches `https://registry.npmjs.org/@autonomous-ai/harness-mcp/<version>` and refuses the
entry unless its `mcpName` is `io.github.autonomous-ai/harness`, and it sends a HEAD request to the `.mcpb` URL. So
publish the npm package and upload the bundle first. A published version cannot be changed; the next one needs a new
`version`.

```
brew install mcp-publisher
mcp-publisher login github                 # as an Owner of the autonomous-ai organization
mcp-publisher validate cli/packages/harness-mcp/mcpb/dist/server.json
mcp-publisher publish cli/packages/harness-mcp/mcpb/dist/server.json
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.autonomous-ai/harness"
```

`login github` grants `io.github.autonomous-ai/*` only to an Owner of the organization; a member gets their own
`io.github.<user>/*`. A token used in CI needs `read:org` (or, fine-grained, Members: read) for the organization.

The alternative name, `ai.autonomous.harness/harness`, needs no organization role, only the website:

```
openssl genpkey -algorithm Ed25519 -out key.pem
echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
# serve that line at https://harness.autonomous.ai/.well-known/mcp-registry-auth, then:
mcp-publisher login http --domain harness.autonomous.ai \
  --private-key "$(openssl pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
```

Choosing it means changing `name` in `server.json`, `mcpName` in `cli/packages/harness-mcp/package.json` (and
republishing the npm package), and the name `website/scripts/listings.spec.ts` expects. Keep the key out of the
repository.

`mcp-publisher validate` (1.8.1) passed on 2026-10-11 for both the repository's `server.json` and one `make mcpb`
built for a sample version, 0.3.74. On that date the registry had nothing under `io.github.autonomous-ai` or
`ai.autonomous`.

## 2. Smithery (smithery.ai) — **Owner**

Smithery takes a local server only as an `.mcpb` bundle: its publish command and web form take a public HTTPS URL or a
bundle, and nothing installs from npm there. So Smithery gets the bundle.

```
npm install -g smithery@latest              # Node 20 or later
smithery auth login
smithery namespace list                     # or create one: smithery namespace create <name>
smithery mcp publish cli/packages/harness-mcp/mcpb/dist/harness-mcp.mcpb -n <namespace>/harness
```

`mcp publish` creates the server but not the namespace: a namespace (lowercase letters, digits and hyphens, unique
across Smithery) has to exist first. The name, description and links are set after publishing, on the server's
page or through Smithery's "Update a server" API: display name **Harness**, the short description, homepage
`https://harness.autonomous.ai/agents`, repository `https://github.com/autonomous-ai/openharness`, license MIT, an
icon of 1 MB at most. Then Settings → Verification for the vendor checklist.

## 3. PulseMCP (pulsemcp.com)

Nothing to submit: its form is paused, and it says it picks servers up from the Official MCP Registry (step 1).

## 4. Cursor — **Owner** for the marketplace

**Marketplace** (cursor.com/marketplace/publish, signed in to Cursor): it is an application to become a plugin
publisher. Fields:

| Field | Value |
|---|---|
| Organization name | Autonomous |
| Organization handle | `autonomous` (kebab-case, unique; the owner's choice) |
| Contact email | the owner's choice; not written here |
| Logotype URL | `https://raw.githubusercontent.com/autonomous-ai/openharness/main/plugins/harness/assets/logo.svg` (1:1 SVG or PNG on a background plate; check that this one reads on Cursor's background) |
| Description | Start Claude Code and Codex agents the person can watch, wait for them and read their answers. |
| GitHub repository | `https://github.com/autonomous-ai/openharness` |
| Website URL | `https://harness.autonomous.ai/agents` |

Cursor reads `.cursor-plugin/marketplace.json`, which lists one
plugin, `harness`, at `plugins/harness` (`.cursor-plugin/plugin.json`, the `harness` skill, `mcp.json`, the logo
`assets/logo.svg`). Every plugin and update is reviewed by hand. Before submitting, load it locally: copy
`plugins/harness` to `~/.cursor/plugins/local/harness`, run **Developer: Reload Window**, and check under
**Customize** that the skill and the MCP server load. Cursor must find `harness` on its PATH.

**Add to Cursor**, no submission (on `/agents`):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=harness&config=eyJjb21tYW5kIjoiaGFybmVzcyIsImFyZ3MiOlsibWNwIl19
```

## 5. Glama (glama.ai/mcp/servers) — **Owner** (GitHub, as a maintainer named in `glama.json`)

1. **Add MCP Server** → **Runs from source**: Name `harness` (100 characters at most); Description (400 at most):
   "Start Claude Code and Codex agents the person can watch, wait for them and read their answers. Runs the Harness
   CLI's MCP server (harness mcp) over stdio; macOS and Linux."; GitHub Repository URL
   `https://github.com/autonomous-ai/openharness`. **Submit for Review**. After approval Glama emails how to provide
   the Dockerfile; only servers that pass its checks are indexed.
2. **Claim** it: `glama.json` at the root names `deehw`. Sign in to Glama with that GitHub account and run the claim;
   run it again after any change to `glama.json`. An organization's repository can be claimed only this way.
3. **The Dockerfile** (as Glama's email says, or on the server's admin page once claimed): Glama builds the server,
   starts it and asks `initialize` and `tools/list`; the listing and its score badge depend on that. Use the image in `cli/docker/harness-mcp/Dockerfile`: Debian with tmux and `ps`,
   the official installer, then `harness mcp`. Checked on 2026-10-11: the image builds, and with the CLI from the
   sources in it (the released 0.3.73 has no `harness mcp`), it answers `initialize` and lists the five tools with
   no daemon and no tmux server running; a tool call answers "Harness is not running here".

   If the page asks for fields rather than a Dockerfile (one third-party note says it generates the Dockerfile from
   build steps and command arguments; **unverified**): build step `curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash`,
   command `$HOME/.local/bin/harness mcp`, no environment variables.

Why not the npm package here: Glama lists what `tools/list` returns. An image with only
`npx -y @autonomous-ai/harness-mcp` and no Harness would list one tool, `harness_setup`, not the five. The CLI has
to be in the image either way, and then `harness mcp` needs no wrapper.

## 6. Claude Desktop

No submission: Anthropic's directory no longer accepts bundles (its desktop extension listings are deprecated; a
local server is listed inside a plugin, step 8). The bundle is the install: download `harness-mcp.mcpb` from the
release and double-click it, drop it on the Claude Desktop window, or use **Settings → Extensions → Advanced settings
→ Install Extension…**. It runs on the Node that Claude Desktop ships on macOS; until the CLI is installed it offers
`harness_setup`. Source: claude.com/docs/connectors/building/mcpb.

## 7. Other editors' install links (on `/agents`)

No submission; each hands the server's config to the editor, which adds it (Cursor asks first, as its docs say).

| Editor | Link |
|---|---|
| VS Code | `vscode:mcp/install?%7B%22name%22%3A%22harness%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22harness%22%2C%22args%22%3A%5B%22mcp%22%5D%7D` |
| VS Code Insiders | the same with `vscode-insiders:` |
| LM Studio | `lmstudio://add_mcp?name=harness&config=eyJjb21tYW5kIjoiaGFybmVzcyIsImFyZ3MiOlsibWNwIl19` |
| goose | `goose://extension?cmd=npx&arg=-y&arg=%40autonomous-ai%2Fharness-mcp&timeout=660&id=harness&name=Harness&description=…` (goose runs only commands such as `npx`, so it uses the npm package) |

Use them from web pages such as `/agents`. Whether a README on github.com keeps these schemes as links is
**unverified**; some projects wrap VS Code's in `https://insiders.vscode.dev/redirect?url=` for that reason.

## 8. Anthropic's plugin directory (claude.ai/directory) — **Owner**

Needs a plan and role that can submit, and on claude.ai a connected GitHub account that can push to
`autonomous-ai/openharness`. Nothing to paste for the listing: its name and descriptions come from
`plugins/harness/.claude-plugin/plugin.json` and the plugin's README.

1. `claude plugin validate ./plugins/harness` from the repository root (passes; the one warning is the `version` left
   out on purpose).
2. claude.ai/directory/manage → **Submit new** → **Plugin bundle**.
3. **Source**: Repository `autonomous-ai/openharness`; Plugin path `plugins/harness`; Branch or tag empty (follows
   `main`). **Validate**.
4. **Data handling**, suggested answers for the owner to confirm: reads or stores personal data: it runs agents on
   the person's own files and keeps their transcripts on the person's computer; sends data to other services: no,
   except Harness's own relay when the person has signed in to reach their other machines; retention: on the
   person's computer until they delete it; intended for people under 18: no.
5. **Compliance**: a contact address for the submission (the owner's choice; not written here), the four
   acknowledgements.
6. **Review and submit**: keep **GitHub push webhook** (setting it up needs admin access to the repository).

Expect it to be held for a reviewer: the plugin's MCP server runs `harness` from the PATH rather than a file inside
the plugin, and the README says that the CLI is installed with curl.

## 9. OpenAI's plugin directory (ChatGPT and Codex) — **Owner**, skills only

The portal does not take a local MCP server or an `.mcpb` (it asks for a public HTTPS server), so Harness goes as
the skill alone. Needs the Owner role or Apps Management Write on the OpenAI organization, and individual or business
verification. platform.openai.com/plugins → **Create plugin** → **Skills only**, then upload:

```
rm -rf /tmp/harness-skills && mkdir -p /tmp/harness-skills/harness
cp -R plugins/harness/.claude-plugin plugins/harness/skills /tmp/harness-skills/harness/
(cd /tmp/harness-skills && zip -r harness-skills.zip harness)
```

One top-level folder with `.claude-plugin/plugin.json` (the portal converts it to `.codex-plugin/plugin.json`) and
`skills/harness/SKILL.md`; no `.mcp.json` or `mcp.json`. Safety scans can take two hours.

| Field | Limit | Value |
|---|---|---|
| Display name | 30 | Harness |
| Short description | 30 | Run coding agents in parallel |
| Long description | 4,000 | the long text above |
| Category | list | Developer Tools |
| Capabilities | 20, 120 each | Start Claude Code or Codex on a task in a folder of its own · Wait for one or several agents and read their answers · Run an agent on another of your machines · Close agents once done; the person can resume them |
| Starter prompts | 3, 128 each | Have Codex review this branch and give me the findings · Fix the api and ui tests in parallel, one agent each · Start an agent on the docs and tell me when it is done |
| Logo | square, 48 px or more | `desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_512.png` |

The skill runs the `harness` CLI from a shell, so it is useful where the agent has one (Codex), not in ChatGPT's
chat alone.

## 10. Lists

Open these as a person, from a personal GitHub account; none needs the owner's login unless noted.

**punkpeye/awesome-mcp-servers** (pull request to README.md; after Glama lists the server, because its check wants
the Glama score badge on every new line). Section **🤖 Coding Agents**, in alphabetical order. Use the badge URL
Glama shows on the listing; the slug below is a guess. Title: `Add autonomous-ai/openharness`, without the
fast-track marker its CONTRIBUTING offers automated agents.

```
- [autonomous-ai/openharness](https://github.com/autonomous-ai/openharness) [![autonomous-ai/openharness MCP server](https://glama.ai/mcp/servers/autonomous-ai/openharness/badges/score.svg)](https://glama.ai/mcp/servers/autonomous-ai/openharness) 📇 🏠 🍎 🐧 - Run Claude Code and Codex agents in tmux sessions the person can watch: start, wait for, read and close them over MCP or the CLI.
```

**wong2/awesome-mcp-servers** (no pull requests; the form at mcpservers.org/submit):

| Field | Value |
|---|---|
| Server Name | Harness |
| Category | Development |
| Short Description | Start Claude Code and Codex agents the person can watch, wait for them and read their answers. |
| Repository, Website or Documentation | `https://github.com/autonomous-ai/openharness` |
| Official MCP Registry Name | `io.github.autonomous-ai/harness` (after step 1) |
| Supports remote connections | unchecked |
| Contact Email | the submitter's; not written here |
| Plan | Free (review within two weeks) |

**hesreallyhim/awesome-claude-code** (the web issue form only, filed by a person: not with `gh`, not by an agent).
It takes a repository with 14 days of active development since its first commit, or 100 stars; this one qualifies
on the first. One line, no emoji, one resource at a time.

| Field | Value |
|---|---|
| Title | `[Resource]: Harness` |
| Display Name | Harness |
| Category | Agent Orchestration |
| Link | `https://github.com/autonomous-ai/openharness` |
| Author Name | Autonomous |
| Author Link | `https://github.com/autonomous-ai` |
| Description (10–500 characters, 1–3 sentences, not addressed to the reader) | Runs Claude Code and Codex in tmux sessions, called harnesses, that the person can watch and join from a desktop, web or phone app. Its Claude Code plugin adds a skill and an MCP server with which Claude starts harnesses, waits for them, reads their answers and closes them. |
| Checklist | the five required boxes; leave the last box unchecked, as it says |

**VoltAgent/awesome-agent-skills** (pull request). It turns away skills that are days old, so wait some weeks.
Append at the end of **Development and Testing**; the description is 10 words at most. Title:
`Add skill: autonomous-ai/harness`.

```
- **[autonomous-ai/harness](https://github.com/autonomous-ai/openharness/tree/main/plugins/harness/skills/harness)** - Runs Claude Code and Codex agents the person can watch
```

**davila7/claude-code-templates** (aitmpl.com; pull request touching only `cli-tool/components/`; its CI runs
`claude plugin validate` and security scans). Add `cli-tool/components/mcps/devtools/harness.json`:

```json
{
  "mcpServers": {
    "harness": {
      "description": "Start Claude Code and Codex agents the person can watch, wait for them and read their answers. Runs the Harness CLI's MCP server; install the CLI with: curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash",
      "command": "npx",
      "args": ["-y", "@autonomous-ai/harness-mcp"]
    }
  }
}
```

The npx form, as every example there uses a command a template can name; it answers with `harness_setup` until the
CLI is installed. Skills there are copies (`cli-tool/components/skills/<category>/<name>/SKILL.md`) that would go
stale, so the skill is left out.

**davepoon/buildwithclaude** (pull request adding one entry to its `.claude-plugin/marketplace.json`; external
plugins are referenced, not copied). Branch `add-harness`, title `Add harness plugin`, body sections Summary /
Component Details (Name harness, Type plugin, Category orchestration) / Testing / Examples. Pin `sha` to a commit on
`main`:

```json
{
  "name": "harness",
  "description": "Start, wait for, read and close Claude Code and Codex agents the person can watch, through Harness: the harness skill and its MCP server.",
  "category": "orchestration",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/autonomous-ai/openharness.git",
    "path": "plugins/harness",
    "sha": "<commit on main>"
  }
}
```

**RoggeOhta/awesome-codex-cli** (pull request, or an issue, which its maintainer works through in batches). Append
to **Cross-Agent Tools**, with the star badge it requires. Title: `Add openharness to Cross-Agent Tools`.

```
- [autonomous-ai/openharness](https://github.com/autonomous-ai/openharness) - Runs Codex and Claude Code in tmux sessions the person can watch; its Codex plugin and MCP server let Codex start, wait for and read other agents. ![GitHub stars](https://img.shields.io/github/stars/autonomous-ai/openharness?style=flat-square)
```

**appcypher/awesome-mcp-servers**: archived; it takes no submissions.

## 11. Listed without a submission

- **skills.sh** ranks skills by the `skills` CLI's anonymous installs; there is no form. The repository has 96
  `SKILL.md` files, so name the one: `npx skills add autonomous-ai/openharness --skill harness`. (It is found by the
  CLI's recursive search, as the marketplace declares no skill paths.) Badge: `https://skills.sh/b/autonomous-ai/openharness`.
- **PulseMCP**, and, by GitHub's announcement, **GitHub's MCP Registry**, from the Official MCP Registry (GitHub's:
  **unverified** that it is live). Where VS Code's MCP gallery comes from: **unverified**.
- **claudemarketplaces.com**: updated automatically (**unverified**).
- **cursor.directory**: answered 429 to every request; **unverified**.

## In order

1. Merge this branch. Monday: release the CLI; publish `@autonomous-ai/harness-mcp` (**Owner**); deploy
   `/agents` and `/llms.txt`.
2. Same day: `make mcpb`, upload the asset, check its sha256; publish to the Official MCP Registry (**Owner**).
3. Anthropic's directory, Cursor's marketplace, OpenAI's (skills only) and Smithery (**Owner**).
4. Glama: add, claim, Dockerfile; then punkpeye's list with the badge, and mcpservers.org.
5. The other lists: awesome-claude-code, awesome-codex-cli, claude-code-templates and buildwithclaude now;
   awesome-agent-skills in a few weeks.

Sources read on this date, beside the checklist's: github.com/modelcontextprotocol/mcpb (MANIFEST.md, schemas,
`src/cli/pack.ts`, `src/node/validate.ts`); github.com/modelcontextprotocol/registry (docs/reference, package
types, authentication, `internal/validators`); static.modelcontextprotocol.io/schemas/2025-12-11; cursor.com/docs
(plugins reference, MCP install links, deeplinks) and cursor.com/marketplace/publish;
code.visualstudio.com/docs/copilot (MCP developer guide, MCP configuration reference); lmstudio.ai/docs/app/mcp/deeplink;
goose's docs (getting-started/using-extensions); smithery.ai/docs (publish, CLI, namespaces, update a server);
glama.ai (add-server form, methodology, `glama.json` schema); claude.com/docs (plugins/submit, MCPB);
developers.openai.com/plugins (submission); skills.sh/docs and github.com/vercel-labs/skills; and the README,
contributing rules and checks of each list above.
