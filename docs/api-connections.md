# Saved APIs

Models opens on **All**, with subscriptions, local models, shared models, and saved
APIs grouped in one searchable view. The source tabs narrow the list.

![All models](images/models-all.png)

Open **Models → APIs**, choose a provider, paste its key, and select **Save**.
The clipboard icon pastes the key directly; it remains hidden until you reveal it.
OpenRouter, Requesty, fal.ai, and Replicate have presets. **Custom API**
accepts a name, base URL, and key; **Advanced** controls the key environment
variable, authentication header, and optional prefix.

![API connections in Models](images/models-apis.png)

Connections are available to every local harness's tools. Saving one does not change
the harness's selected model or subscription; to run a harness on an API's model, see
[Running a harness on an API model](#running-a-harness-on-an-api-model). Saving stores the connection;
it does not call the provider, validate account credit, or make a paid request.

To edit a connection, select its pencil icon. Leave the key blank to keep the
saved key, or paste a replacement. The trash icon removes the saved connection
after confirmation; revoke the key at the provider if it should stop working
outside Harness too. Multiple named connections to one provider are supported.

![Custom API setup](images/models-api-custom.png)

## Using a connection

Harness adds a short **Saved APIs** instruction section when starting, restarting,
or forking a local harness while connections exist. It preserves existing project
instructions and appends the section only once, in `AGENTS.md` (`CLAUDE.md` for
Claude, `GEMINI.md` for Gemini). The section contains commands, never credentials.
Already running harnesses can use those commands immediately:

```sh
# Discover connection IDs and public settings. Keys are never listed.
harness api list --json

# Authenticated JSON API request; the path is relative to the saved base URL.
harness api request openrouter /models
harness api request my-images /render --method POST --data @request.json

# Give a provider SDK or tool its saved key environment variable.
harness api run fal-ai -- node generate-image.mjs
```

Use the ID returned by `list`; renaming an existing connection preserves its ID.
`request` attaches the configured authentication header, returns the response
body, and exits nonzero on network/HTTP failure. It does not follow redirects.
`run` passes the selected key variable and `HARNESS_API_BASE_URL` to the child
process only; an SDK may need its base URL configured explicitly. Its arguments,
standard input/output, and exit code pass through normally.

Header-based JSON APIs work with `request`. Other protocols and authentication
schemes can use their own SDK/tool through `run`; Harness does not provide OAuth
sign-in or provider-specific polling and file-upload interfaces.

## Running a harness on an API model

An API that takes a Bearer key — OpenRouter, or a Custom API with an
OpenAI-compatible `/models` list (DeepSeek, Groq, Together, …) — is also a place
to run a harness. In the model picker (Cmd-I, or Cmd-P then `:`), its chat
models are folded under the API's row: **Enter** on the row shows or hides
them, and a search matches them without unfolding. Where the API describes its
models, only those a coding agent can run are listed: they take tools, answer
in text, and have at least a 64K context window. **Use** moves the focused
harness onto the model, restarting its engine in the same pane and resuming the
conversation, exactly like moving it onto a local model.

The app sends only the API's ID and the model. The daemon on this computer reads
the endpoint and key from its store and launches the engine the way the
provider documents: Claude Code gets `ANTHROPIC_BASE_URL` (`https://openrouter.ai/api`)
and `ANTHROPIC_AUTH_TOKEN`; Codex gets a `responses` provider at `…/api/v1`;
OpenCode and Pi get a provider block that references the key through an
environment variable. The key goes only into that engine's environment, never
into argv or files. Each engine is told the model's context window, so it
compacts before the API refuses a request. A restart, a restore, or a resume
reads the key again, so a pasted replacement takes effect then. Once the API is
removed, the harness cannot relaunch on it.

Listing models is a free read of the API's `/models`, kept for ten minutes, or
re-read at once after a key change or **Refresh models**. Only harnesses on this
computer can use its APIs; fal.ai and Replicate stay tools-only. Claude Code
is built for Anthropic models; others may not work fully through it
([OpenRouter's note](https://openrouter.ai/docs/guides/guides/claude-code-integration)).

## Storage and scope

The local CLI stores keys in `api-connections/connections.json` inside its data
directory (`~/.harness/cli/data` by default), with owner-only directory/file permissions
(`0700`/`0600`). This is a local credential file, not an OS keychain. Writes are
atomic, and unreadable/corrupt storage is never silently replaced.

Management requests use the local daemon connection; remote requests are refused.
Keys are not returned to the UI, included in connection lists, or copied into project
instructions. An explicitly invoked tool receives the selected credential, and so does
the one engine a person moved onto that API's model — no other engine's environment
gets a key. Connections do not sync between machines.

Preset defaults come from the providers' documentation:
[OpenRouter](https://openrouter.ai/docs/api/reference/authentication),
[Requesty](https://docs.requesty.ai/api-reference/introduction),
[fal.ai](https://fal.ai/models/fal-ai/flux/dev/api), and
[Replicate](https://replicate.com/docs/reference/http).

## Validation

```sh
cd cli
npm run typecheck
npx vitest run src/lib/apiConnections.spec.ts src/lib/apiCommand.spec.ts src/lib/apiConnectionsRpc.spec.ts src/lib/apiModels.spec.ts

cd ../desktop
flutter test --coverage test/api_connections_test.dart test/api_model_picker_test.dart test/models_panel_test.dart test/model_mark_test.dart test/model_manager_controller_test.dart
node tool/check_models_coverage.mjs
```

Backend tests use synthetic credentials and a local HTTP server. They cover
storage/rotation/removal, all preset defaults, custom authentication, child-process
isolation, HTTP success/failure/redirect handling, local-only RPCs, and instruction
preservation. UI tests cover forms, key masking, validation, search, repeated
providers, editing/removal, reconnects, stale responses, and small windows.
