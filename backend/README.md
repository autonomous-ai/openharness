# autonomous-harness-backend — central product API + single-port reverse proxy

The **central, public-facing** backend for the distributed deployment. It is the **one port** the
web connects to. It:

1. **Manages users + auth** — `POST /api/auth/login {email,password}` issues a JWT. An unknown email
   is **created on the spot** (login doubles as signup). Admin-only user CRUD under `/api/users`.
2. **Provisions agent-nodes** — `POST /api/agents` generates a per-agent api-key, **picks a
   manager by capacity** (reads `maxNodes`/`nodeCount` from the shared `managers` collection;
   best-fit = the live manager with the least free room, 503 if all full), calls that manager's
   control API to create the node, and stores the `user → agentId/apiKey/managerUrl` binding.
   `DELETE /api/agents/:agentId` tears it down. The data-plane proxy then targets the binding's
   manager.
3. **Reverse-proxies the data plane** — every other `/api/*` request and the `/api/ws` WebSocket are
   authenticated by the **agent api key** (NOT the JWT): the client sends it (`x-api-key` for HTTP,
   the WS subprotocol) on a **`/proxy/...`** path, the backend derives `agentId = sha256(key)[:32]`,
   looks up the owning manager, and forwards the path verbatim to it (the manager mounts its data
   plane under `/proxy` and strips it before the node). So any client (a CLI, another app, the web
   chat page) can reach an agent with **only its api key**. The owner obtains that key from the
   control plane (#2); possessing it is the auth (128-bit preimage).

```
control:  web ──(JWT)──────────────────────▶ backend :8085 /api/auth|users|agents ──(x-api-key: MANAGER_API_KEY)──▶ manager :8090/api
data:     client ──(agent api key: x-api-key / WS subprotocol)──▶ backend :8085 /proxy/api/* ──▶ manager :8090/proxy/api/* ──▶ agent-node/api/*
```

## One port, two planes

A single `http.Server` (`server.ts` `serverFactory`) splits traffic by an explicit path prefix:

- **Data plane (reverse-proxied):** everything under **`/proxy/*`** (incl. the `/proxy/api/ws`
  upgrade) → `lib/proxy.ts`.
- **Local (Fastify control API):** everything else — `/api/health`, `/api/auth/*`, `/api/users/*`,
  `/api/agents*`. A stray `/api/*` that isn't a control route now 404s here instead of being proxied.

## Run

```bash
npm install            # runs `prisma generate`

# Needs MongoDB (shared with the agent-manager) + a running agent-manager:
#   cd ../autonomous-code/apps/mongodb && docker compose up -d
#   cd ../autonomous-code/apps/machine-manager && npm run dev
npm run dev            # tsx watch, :8085 by default
```

Copy `.env.example` → `.env` and set at least `MANAGER_API_KEY` (to match the manager) and a
`DATABASE_URL` pointing at the **same** MongoDB the manager uses. Production SSO/profile URLs are
the defaults; override `SSO_ISSUER`, `SSO_PROFILE_URL` and `SSO_IDENTITY_URL` with the staging hosts for local testing
(the identity URL is asked first — leave it on production and staging tokens are refused there).

| dev | build | other |
|-----|-------|-------|
| `npm run dev` (tsx watch) | `npm run build` (esbuild via `build.mjs`) | `npm run typecheck`; `npm run test` (vitest) |

### CLI terminal P2P canary

Remote CLI-to-CLI terminals can use an ordered WebRTC DataChannel while authentication, encrypted
signaling, chat/RPC, and fallback remain on the existing WebSocket path. This mode is STUN-only and
does not require or use TURN. Configure `TERMINAL_P2P_ROLLOUT_PERCENT` (default `100`; set `0` as the kill switch),
`TERMINAL_P2P_STUN_URLS` (default Cloudflare STUN), and `TERMINAL_P2P_OPEN_WAIT_MS` (default `1500`).
When direct ICE fails, the terminal opens on WebSocket relay automatically.

## Deploy

`../.github/workflows/production-be-build.yaml` builds and pushes the production Docker image on
tag push. Backend releases are tagged **`vX.Y.Z_backend`** — the `_backend` suffix is what routes the push
to this workflow instead of the CLI's `../.github/workflows/release.yml` (which only reacts to
`vX.Y.Z_cli`), now that both live in this one repo. Cut one with:

```bash
make release-backend                      # patch bump
make release-backend ARGS=minor           # or major
make release-backend ARGS="1.4.1"         # exact version
make release-backend ARGS=--dry-run       # preview, tags/pushes nothing
```

(equivalent to `bash backend/scripts/release-be.sh`, see that script for details).

### Memory sizing and Redis limits

The `backend` app runs as a pm2 cluster: every worker has its own V8 heap. `ecosystem.config.cjs`
pins the heap with `--max-old-space-size` (`BACKEND_HEAP_MB`, default 1024) and recycles a worker at
`BACKEND_MAX_MEMORY` (default `1536M`), so size the container roughly as
`instances × BACKEND_MAX_MEMORY × 1.25`. `Dockerfile.k8s` runs one plain `node` per container — pass
`NODE_OPTIONS=--max-old-space-size=…` there and set the pod limit ~1.5× that.

Per-process ceilings that bound WebSocket memory (all in `src/lib`): `wsServer.ts` `WS_LIMITS`
(inbound frame size per endpoint), `wsSend.ts` `SEND_HIGH_WATER` / `SEND_KILL_WATER` (outbound
backpressure: droppable frames skipped, slow consumers closed 1013), `orderedInbox.ts`
`DEFAULT_MAX_INFLIGHT` (queued frames per socket), `VOICE_INFLIGHT_MAX_BYTES` (PCM held for STT across
all device sockets) and `APP_PROXY_MAX_RELAY_FRAME_BYTES` (largest app-proxy frame relayed cross-instance).

App-proxy bodies can cross instances through Redis pub/sub in multi-MiB messages. Redis' default
`client-output-buffer-limit pubsub 32mb 8mb 60` disconnects a subscriber that falls behind, so on the
Redis side set it to at least `64mb 16mb 60` and alert on `client_recent_max_output_buffer`. The
app-proxy channels ride their own subscriber connection (`appSub` in `bus.ts`), so a disconnect there
cannot take the chat / presence subscriptions down with it.

## Persistence

Prisma over the **same MongoDB** as the agent-manager (no migration files — `prisma db push` at
startup). The backend owns the `users` + `agent_bindings` collections; it never manages the
manager-owned `agent_nodes`/`managers` (read those via raw queries when status enrichment is needed).

### Client country (Cloudflare)

Production DNS is proxied through Cloudflare, so every request and WebSocket upgrade arrives with a
`CF-IPCountry` header. `src/lib/clientGeo.ts` is the only reader; it feeds:

- `users.lastCountryCode` / `lastCountryAt` — from the owner's own control-plane calls
  (`middlewares/authMiddleware.ts`), rate-floored to one write per user per hour unless the country
  changes. This is the "where is the user" answer.
- `machines.countryCode` — the computer's country on its last `/api/adapter-ws` connect.
- `machine_daily_presence.countryCode` / `user_daily_device_presence.countryCode` — same header on the
  daily presence rows. `user_daily_presence` deliberately has none: it is keyed by
  (user, machine, day) and its socket is the daemon's, so the machine's country is the one on
  `machine_daily_presence` for that `machineId`.

Off Cloudflare (local dev, direct origin hits) the header is absent and nothing is written; a value
is only ever set, never cleared.

Historical architecture notes still live in `autonomous-code/docs`.
