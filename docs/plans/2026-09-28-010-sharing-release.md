# Sharing release — September 28, 2026

Release source: `78b5329e5d80ffc04e45f46866919ff8816c4095`, the merge of sharing PR #394 with readiness PR #395. The shipped backend, CLI, desktop and workflow trees exactly match the validated `d3ff6fee` tree. Main's later hardware documentation changes are also included.

## User flow

Open an agent's **Share** control in desktop or web. Choose **Private**, add invited emails and **Copy link**, or choose **Public** so anyone with the link can watch without signing in. Send the copied link yourself; adding an email does not send an invitation email.

Readers can sign in to comment. Authors can delete their own comments; the owner can moderate, change access, or stop sharing. Shared viewers cannot type into or control the agent. The owner machine must stay online for live viewing and comments.

Browser owners use the same Flutter UI as desktop. This release also includes linked-machine tools, phone setup, API connections, orchestration and interactive managed viewers. The machine picker opens automatically only when no machine connects; it remains available through Alt-M.

## Final validation

- Full native Flutter suite: **3,851 passed, 12 existing skips**.
- Chrome: **62 passed**, including workspace startup, machine controls, auth, persistent credentials, encrypted observers, terminal framing and trust-group sync.
- CLI: typecheck and release bundle pass; **45 sharing tests at 100% coverage**, plus **348 transport/owner/crypto tests**.
- Backend: typecheck passes; **28 sharing tests at 100% coverage**, full suite **573 passed, 11 skipped**. Backend source did not change during the subsequent main merges.
- Full-stack integration: real backend, disposable loopback MongoDB/Redis, three isolated owner daemons, synthetic accounts and real PTYs. Public/private admission, comments, moderation, denied controls, reconnect, immediate revocation, owner restart persistence and Stop sharing pass. The final rerun exercised the protocol fixture; earlier browser release-build checks also verified UI sign-in return, comments, responsive layout and reload.
- Production Flutter web archive builds with the production API, `/harness-web/` asset base and bundled CanvasKit. Analysis has no errors or warnings; 12 existing vendored xterm lint notices remain.

Local evidence logs use the `/private/tmp/harness-sharing-final-` prefix. The final full-stack run retained isolated logs in `harness-share-e2e-1qytBC` under the system temporary directory. No real Harness/Codex home or account credentials were used.

## Publication

| Component | Release | Publication |
| --- | --- | --- |
| Backend | `v1.2.41_backend` | [CI passed](https://github.com/autonomous-ai/openharness/actions/runs/36378090631); live health and new shared-agent admission response verified. |
| Owner daemon | `v0.3.19_cli` | [CI passed](https://github.com/autonomous-ai/openharness/actions/runs/36378447028); live CDN update manifest verified. |
| Desktop | `v1.2.13_desktop` | [CI passed](https://github.com/autonomous-ai/openharness/actions/runs/36378653145); all six macOS/Linux update entries and installer URLs verified. |
| Flutter web bundle | `v0.1.4_web` | [CI passed](https://github.com/autonomous-ai/openharness/actions/runs/36378116788); archive checksum and embedded source verified. |
| Website host | `v1.2.21_web` | [CI passed](https://github.com/autonomous-ai/autonomous-code/actions/runs/36379747617); live versioned assets, shared-link entry, callbacks, downloads and installer redirects verified. |

The Flutter archive SHA-256 is `75062b96e51dc920392bf7e47b43f1d8e45566bbdc582531aa61a1865fabafbb`. Hosting source is `719343b7240333d745917e8831d2c6b41ebb6d37` on `deploy/flutter-web`, including hosting PRs #5, #7 and #8. The backend and daemon were verified live before desktop/web publication.

## Returning-browser cache correction

The first website rollout served the new bundle, but an existing browser still ran old JavaScript: the production CDN extended stable app-file URLs to `max-age=432000` despite the origin's revalidation policy. That older app interpreted a shared-agent URL as a workspace and removed the identity fragment. This was caught by the live browser check after the HTTP hosting checks passed.

The host now puts runtime files under `/harness-web/releases/0.1.4-75062b96e51d/` and configures Flutter's JavaScript, assets/fonts and CanvasKit paths to use that archive-specific directory. Entry pages and public URLs stay stable and uncached. The host does not start Flutter's deprecated generated service worker. Legacy asset paths remain available for existing tabs.

Three regression tests verify runtime startup configuration, changing cache keys, and failure on unexpected bootstrap output. The production Next.js build, versioned-asset hosting checks and local browser render pass. The same returning production browser now loads the namespaced JavaScript on an ordinary reload without clearing storage. A complete synthetic share URL preserves its identity fragment and opens the shared-agent access screen; an uninvited account is denied. No real agent was made public during verification.

Final live checks also confirm the unchanged short installer redirect, `https://harness.autonomous.ai/install.sh`, and healthy production API. Refresh the web app or update desktop to **1.2.13** to use **Share → Public/Private → Copy link**. The owner daemon update is **0.3.19**.
