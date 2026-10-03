# Daemons: how to ship them without breaking anyone

2026-09-27. What has to deploy, in what order, how each step is switched off, how to roll back, and
the test evidence behind it. The feature itself is described in `daemons/README.md`,
`daemons/BRAIN.md` and `daemons/LEARNING.md`; the end-to-end run is in
`docs/research/2026-09-27-daemons-e2e.md`.

**2026-09-28 desktop preview:** the owner approved a desktop release with the
opt-in **Settings → Experimental → Focus-bar creature**. That window-only
preview works before the account-based rollout below and changes no server
flag or allowlist. The desktop prerequisite from #366 is included in #369;
#367 is already on main. See the handoff's latest continuation for validation.

## What ships where

| part | change | how it ships |
|---|---|---|
| backend | zoo routes (`/api/zoo`, `/api/zoo/ops`), `zoo_changed`, the draw, eggs, serials; Prisma models `Zoo` and `DaemonMint` (MongoDB) | `make release-backend` (tag `vX.Y.Z_backend`, CI image, ArgoCD). The worker runs `prisma db push` at boot, so collections and unique indexes appear without a migration step |
| harnessd (cli) | zoo passthrough, turn reporting, the pair brain, learning, `harness pair`, the question-id and answer-routing fixes | `make release-cli` |
| desktop | status-line daemon, reveal, panel, consent, the brain's keys | `make release-desktop` |
| phone | chip, sheet, reveal, consent | the mobile release |
| hn | status cell, `prefix Z` table, hatch popup, `hn zoo/card/talk/lessons` | with `hn` (#365) |

## Everything ships dark

Nothing changes for anyone until the server says so.

- **Server:** `HARNESS_DAEMONS` is off unless it is `true`. Off, the zoo routes are not registered:
  `/api/zoo` answers the normal 404, nothing publishes `zoo_changed`. `HARNESS_DAEMONS_USERS`
  (user ids or emails, comma-separated) limits it to those accounts; everyone else gets the same 404
  before anything is read.
- **harnessd:** one probe of `GET /api/zoo` at start or sign-in. 404: off, cached, asked again at most
  every 6 hours (plus jitter) or on `zoo_changed`. 5xx or no answer: idle, retried with backoff. While
  off nothing starts: no turn reporting, no sensor or journal, no brain, no learning, no pair harness,
  no timers. The only unconditional cost is one small directory and a stat every 30 s.
- **Local kill switch:** `HARNESS_DAEMONS=0` in the environment, or `"daemons": false` in
  `~/.config/harness/pair.jsonc`. It beats the server.
- **Clients:** a 404 from `/api/zoo` or `DAEMONS_OFF` on any daemon reply hides everything: no status
  slot or reserved space (the desktop's off bar is tested against the base layout at five widths), no
  keys, no habits, no frames. The desktop's separate Experimental switch selects
  a temporary local test collection; explicit off suppresses all creatures.

## Order

1. **Before anything:** merge `origin/main` into `daemons` (session search re-pinned the E2EE
   keystone in `core.ts`; daemons only touch `applicationFrames.ts`) and re-run every suite. Land #366
   and #367 first; #367 carries the question fixes on their own.
2. **Backend, dark.** Release with `HARNESS_DAEMONS` unset. Check: `/api/zoo` answers 404 for everyone,
   the new collections exist and are empty, request volume and error rates on existing routes are
   unchanged.
3. **CLI, dark.** Release harnessd. Check in backend logs: one `GET /api/zoo` per daemon start, no
   `zoo.turn`. Watch question answering from the desktop, `hn`, the phone, the dial and devices (the
   question-id rule changed; see "What changed for everyone").
4. **Clients, dark.** Desktop, phone and `hn` releases. Nothing visible changes.
5. **On for one account.** `HARNESS_DAEMONS=true`, `HARNESS_DAEMONS_USERS=<the founder's user id>`.
   Play for a week on real work: time to first hatch, eggs per week, whether the daily cap and 40 turns
   per egg feel right, whether lines are ever noise. Rules live in `daemons/roster.json`; changing them
   means regenerating and redeploying the backend (the server copy) and the clients (their copies).
6. **Widen** the allowlist to the team, then to beta users, then drop it.

## Rolling back

- Turn `HARNESS_DAEMONS` off (or narrow the allowlist). The routes disappear, clients hide on their
  next read, harnessd goes idle on its next zoo request or probe. Stored zoos stay in the database and
  come back when it is turned on again.
- A person can opt out alone with the local kill switch.
- A bad client build can be rolled back independently: an older client never calls the zoo.

## What changed for everyone, even with daemons off

These ship with the CLI regardless of the flag and deserve their own watch:

- **Answers to agent questions** are checked against the question on screen before any key is typed
  (#367). A late answer gets `STALE_QUESTION` instead of landing on the next dialog, and approvals match
  their question exactly (a prefix no longer names a different command). The question id ignores
  timers, spinners, cursor marks and checkbox state, so it holds still while a prompt is open (all 25
  fixtures, every engine).
- **The reply to an answer** goes only to the connection that answered, sealed.
- **Local connections:** `daemon_*` messages are accepted only over the Unix socket; everything that
  existed before is unchanged (reviewed line by line, and the existing suites pass).

## Evidence

- Full suites on the `daemons` branch: backend 735 passed, CLI 6,113+ passed (TMUX unset, stub tmux);
  phone 541 passed; desktop 3,848 passed with the same 24 failures as the base branch; `hn` cargo 112
  and 96 end-to-end checks against its mock.
- Coverage: pair brain and learning 99.6% statements / 98.6% branches; the question code 99.6 / 99.3;
  the zoo server 99.1 / 97.3.
- About 40,000 property cases on the shell tokenizer and the allow-list classifier (separators,
  substitutions, look-alike and zero-width characters, env prefixes, write forms); 200 KB inputs under a
  second.
- Draw statistics: 200,000 draws per egg kind pass chi-square at α = 0.001; the secret only from night
  and easter eggs; always by the 8th dark egg; shiny 1 in 256; tim's share of the first egg as designed.
- Reviews: collectibles and game design; terminal craft and daily use; security (two rounds); a
  regression hunt over every shared path. Their findings are fixed or listed as open below.

## Open

- The end-to-end run's results (see its report).
- `relayLink.spec.ts` interop tests (already on main) are timing-sensitive under heavy parallel load.
- Windows: the brain's keys need the Unix socket, so they are unavailable there.
- `zoo.turn` and presence are self-reported: a person can inflate only their own zoo. Serials are not
  proof of rarity until a verify endpoint exists.
- Decided for #366: closing a tab's last pane closes the tab, and the keyboard goes to the tab strip, not
  the neighbouring tab's terminal, so typing after a close never reaches another agent (⌘W follows the
  same rule).
