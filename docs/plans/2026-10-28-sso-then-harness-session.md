# Sign in through SSO once, then hold a Harness session

Ken (GO 10-28). People still sign in through Autonomous SSO. After that, the CLI and Desktop hold a Harness-issued
session (`hna_`/`hnr_`, the kind the phone gets from the QR handoff), so an ordinary request no longer waits on
the account service, and SSO being slow or down no longer breaks signed-in people.

Code: `backend/src/lib/ssoSession.ts` (the rules below), `lib/harnessSession.ts`, `routes/auth.ts`, billing in
`routes/machines.ts`; `cli/src/lib/authSession.ts`, `cli/src/cli.ts`; `desktop/lib/viewer/direct_auth*.dart`.

## How it works

- **Getting one.** A client asks for `harnessSession: { kind, label }` on the sign-in exchange, or on an SSO renewal.
  The backend checks the SSO token once, as today, and answers with a Harness session in place of the SSO tokens.
  The CLI asks for a `computer` session, which may connect as a machine. A native Desktop build that signs in by
  itself asks for a `viewer` session. The browser build asks for nothing and keeps its SSO sign-in.
- **The SSO sign-in behind it.** The person's SSO refresh token, and the last access token it gave, are stored on the
  session, encrypted with the credential key (`lib/machineCredential.ts`). They are never returned to a client and
  never logged. They are deleted when the session ends.
- **Lifetimes.** Access token 1 hour. The refresh token is not rotated (the QR session's rule) and lasts 90 days idle.
- **Hourly re-check.** A renewal of the session re-checks the SSO sign-in at most once an hour:
  - SSO renews it: the rotated SSO refresh token is saved, and the session goes on.
  - SSO refuses the token it holds, with no earlier renewal left unfinished: the person signed out of Autonomous, or
    the account was disabled. The session ends, so access ends within about 2 hours (re-check plus access lifetime).
  - Anything else counts as SSO unavailable, never a sign-out: slow, down, 5xx, an answer for another account, an
    unreadable identity, or a refusal after an unfinished renewal. The session goes on for 7 days from its last good
    check. After that, renewals answer `SIGN_IN_AGAIN` (403), which the CLI and Desktop show as "Sign in again". The
    session is not ended, so SSO coming back renews it, but nobody is left retrying silently forever.
- **Rotation safety.** A renewal takes the session's lock in Redis (`SET NX`, released by compare-and-delete), and
  marks the session (`ssoRenewingAt`) before asking SSO. Only saving SSO's answer clears the mark. A mark left
  behind means a rotated token may have been lost on the way, so a refusal of the stored one proves nothing.
- **Only live sessions are written.** Every write a renewal makes is conditional on the session not being revoked.
  A session signed out while SSO was answering gets nothing written back, and its renewal answers 401.
- **Only confirmed access tokens are kept.** An SSO access token is stored only after SSO's profile service has
  confirmed whose it is. When that check cannot be made, the rotated refresh token is kept (losing it would lose the
  sign-in), but the access token is not, so billing can never forward an unconfirmed one.
- **Moving over.** Today's SSO sign-ins move on their next ordinary renewal, with no sign-in prompt. If the session
  cannot be made, the renewal answers with the SSO tokens as before, so a rotated SSO refresh token is never lost.
- **Signing out.** `harness logout`, and Desktop sign-out, end the Harness session on the server: best effort,
  bounded, and the CLI says so when the server cannot be reached. Device removal already ends it.
- **Billing.** Billing and machine deletion forward an SSO access token to the account service. For these sessions,
  the backend uses the confirmed one it keeps, renewed under the same lock. A second call that finds a renewal under
  way waits for it (up to the lock's 60 s) and reads its answer. Other Harness sessions are refused as before.
- **Replacing a sign-in.** `harness login --force` and `harness reset` also end the previous Harness session on the
  server, as `harness team on` does.
- **No new power.** These sessions name no computer, so they never count as "this computer's own sign-in" for
  turning a computer into a team machine; that still needs the machine-key proof, as an SSO sign-in does.

## Design (docs/feature-design-rules.md)

Reviewed revision: see the PR. Reviewer: two independent security reviews (Ken delegated sign-off to the Swarm).

1. **Growth.** One `harness_sessions` row per sign-in. Ending a session sets `expiresAt` to now, and a TTL index the
   worker creates (`harness_session_expiry`) deletes a row 30 days after `expiresAt`: ended, or idle past 90 days.
   Before this, nothing deleted these rows. Redis keys: the access token (1 hour TTL) and the renewal lock (60 s TTL).
2. **Concurrency.** The SSO renewal locks per session in Redis. Under the lock it reads the row again, writes the
   mark, calls SSO, and saves the answer and clears the mark in one update. Every one of those writes is guarded on
   the row still being live, so a sign-out that lands meanwhile wins (tested: a revoke while SSO answers). A second renewal finds the lock taken and
   goes on without asking SSO, within the grace. A lost reply or failed save leaves the mark, which turns a later
   refusal into "unavailable". Tested: two renewals at once ask SSO once; removing the lock fails that test.
3. **Read cost.** An ordinary request is unchanged for a Harness token: one Redis read and one session read by id.
   It no longer reads the SSO profile (or its cache). A renewal reads the session once; once an hour it adds one
   SSO token call, one profile read and one update. No list reads.
4. **Scale.** SSO calls drop from per-request (cached) to one per signed-in client per hour. At 10x clients that is
   still one SSO call per client-hour. Warns first: the `sso re-check unavailable` warning rate and 503s from
   `/api/auth/refresh`.
5. **Compatibility.** Old clients send no `harnessSession` and get exactly today's answers (tested). A new client
   on an old backend: the field is ignored and SSO tokens come back, which are kept. The new fields are read only by
   `lib/ssoSession.ts`. Existing readers of the session rows (revoke paths, device key log, team conversion, Grid
   profile, machine service) were found by searching and keep their meaning; the revoke paths now also clear the
   SSO fields.
6. **Migration and rollback.** No data migration: the fields are optional and new sessions write them. Deploy the
   backend first; clients ask on their next renewal. On rollback, the previous backend already accepts and renews
   `hna_`/`hnr_` sessions, so moved-over clients stay signed in. **But an older backend never re-checks SSO**: while it
   runs, a person who signs out of Autonomous or whose account is disabled keeps a moved-over session (up to its 90
   idle days) until this release is back, and billing for these sessions answers "needs your Autonomous sign-in".
   Keep a rollback short, or end these sessions by hand (`harness_sessions` rows with `ssoRefresh` set). Not checked
   on a production restore.
7. **Audience.** The stored SSO tokens leave the backend only toward the account service: for a renewal, or for
   billing for that session's own user (`ssoAccessTokenFor` checks the user and that the session is live).
   No route returns them.
8. **Identity.** Each session acts for the account SSO verified when it was made, and each re-check confirms SSO
   still answers for that account. An answer for another account is refused (counted as unavailable). Never the
   machine owner's login: the CLI's session is the person who signed in on it.
9. **Failure.** SSO down: people stay signed in, and the backend logs `sso re-check unavailable` per session. Past
   the grace, the CLI's status and the Desktop say "Sign in again"; the daemon retries at its longest backoff. Credential key missing or store failing: the sign-in
   falls back to SSO tokens and logs `harness session not made`. A server sign-out that cannot be reached: the CLI says
   so, and the Desktop logs it.
10. **Platforms.** Backend: Linux. CLI: macOS, Linux and Windows, with tokens in the same `~/.harness/auth/session.json`
    (0600). Desktop native builds keep tokens in the app's existing session store. The browser build is unchanged.
