# Mobile team handoff

- **Product:** standalone Flutter phone client for agents running on linked computers. Focus is a full-screen terminal with voice; Find searches/resumes harnesses; New creates them. Offline sample, onboarding, pairing and settings are included.
- **Latest UI:** removed the scroll-position tag; Agent picker shows every engine with recent choices first; Project and Find search autofocus. New keeps advanced settings collapsed, with separate Branch/Worktree controls and subscription/local/shared Model choices matching desktop.
- **Reliability:** 41 documented bugs fixed across auth, encrypted connections, terminal lifecycle, pairing and logs; removed unused desktop/local-daemon code. Tests use disposable storage and offline transports.
- **Code:** `mobile/lib/phone/` owns screens and interactions; `state/` owns machine/agent/terminal lifecycle; `auth`, `api`, `viewer`, `e2ee`, `ws`, `p2p` own connectivity; `demo/` is the offline sample. Shared desktop code is copied and diverged—port deliberately.
- **Decisions:** keep voice auto-send, mic position, “harness,” and the asking label. Pending design proposals remain unapproved. Never automate the real phone/account/daemon; never commit local Xcode signing changes.

See the [full handoff](2026-09-28-phone-overnight.md) for validation, commands and open items, and the [UI change audit](2026-09-28-mobile-ui-change-audit.md) for the decision history.
