# Product measurement and the daily improvement review

We use aggregated product signals to decide what to reproduce, fix and measure next. We do not
inspect people's work to explain a count, and a daily review does not imply a daily release or an
automatically proven improvement. Changes still need review, tests and a deliberate release.

## Measurements and their limits

| Question | Signal | Interpretation |
| --- | --- | --- |
| Does first measured use lead to work? | First-launch installation cohorts; work and first text response within 24 hours; the first launch's engine (`first_launch_engine_opencode`, `_claude`, `_codex`, `_other`) and, for Claude Code and Codex, whether that engine had a credential here (`first_launch_<engine>_signed_in`, `_signed_out`, `_unknown`) | Same participating installation, not signup conversion, same-task success or unique people. Existing users enter when updated; mature only after the full follow-up day ends. The credential is one presence check per installation, in the gateway (`cli/src/lib/engineAccount.ts`: a file stat'ed or parsed for a token, a Keychain item looked up without its secret); it reads the gateway's own environment and starts no login shell, so a key only a shell profile exports reads as signed out on a daemon launchd or systemd started. `unknown` is a Codex that keeps its tokens in the OS keyring, or a check that failed. An answer lost to a stop or a choice change leaves the engine count without one. |
| Where does a launch stall or fail? | Pending install/model/native waits; observed launch created/failed/cancelled/unconfirmed; fixed failure categories and duration buckets; an `other` failure's code (`launch_failed_code_<code>`); a created launch whose engine then did not start (`launch_late_failed`, by code in `launch_late_failed_code_<code>`) | Polls are not attempts. Missing outcomes, daemon restarts and the 15-minute observation bound reduce coverage. Inspect unknowns alongside failures. Codes are the daemon's own fixed names, lower-cased (`LAUNCH_ERROR_CODES`); `unlisted` is a code not in the list and `none` a failure that named none, so the codes add up to `launch_failed_other`. A late failure (the new-pane watcher's ENGINE_DID_NOT_START, ENGINE_NOT_INSTALLED or START_TIMEOUT, set after the reply said created) is one of the `launch_created`, never a `launch_failed`; the gateway reads it from the agent's own announcement for 15 minutes after the launch was created, and earlier CLI releases counted these only as created (compare releases separately). |
| Which actions break? | Create, resume, restart, model-change, history, fork, close, delete, search, history paging, Store list/install/update/remove, model list/download/start/stop and browser-open requests, fixed outcomes/errors and latency buckets; the code of an `other` create or resume refusal (`create_error_code_<code>`, `resume_error_code_<code>`), and of every delete or restart refusal (`delete_error_code_<code>`, `restart_error_code_<code>`; the phone's again apart, `phone_delete_error_code_<code>`, `phone_restart_error_code_<code>`) | Request acceptance is not task success. Pending/unknown requests are separate from completed replies. A person's message (`request_<source>_message_*`), which nothing answers, is `ok` once its engine took it (its turn began, or it left the composer), `failed` by what the person was told (`not_found`, `unavailable`, `conflict` for a pane busy with a dialog or a full queue, `timeout`, `invalid`, `other`), `unknown` when typed and never confirmed, `cancelled` when stopped; from the CLI release that carries it (an older one counts only `started`), and not yet for cloud agents. Requests are also counted by source: `app`, `tool`, `automatic` (fixed polls, whichever app makes them), `unknown` and `phone` — the phone marks the requests the daemon measures (`usageSurface: 'phone'`, inside the E2EE payload); older phones still count as `app`. Each code family adds up to its `create_error_other` or `resume_error_other`; the delete and restart families add up to `delete_failed` and `restart_failed`, whatever the kind (the phone's 2026-10-19 refusals were `other` and `setup`). |
| Does work get a response promptly? | First text response buckets; over-one-minute waits; error events; matched ends without text; interruptions | Includes automation. Tool-only turns, interruptions and missing lifecycle events can explain missing text. No message is inspected. |
| Do installations return to work? | D1/D7/D28 working-day cohorts, consecutive complete-week and calendar-month returns, return after a seven-day gap | Any working day can be a cohort; not new-signup retention. Local date flags produce unlinked totals. Opt-outs, reinstallations, resets and missing uploads affect results. |
| Was the task useful? | Optional Completed / Partly completed / Not completed plus five fixed reason choices from clients that offer feedback; current Desktop Settings no longer exposes feedback controls | Voluntary and self-selected; not representative success or satisfaction. There is no free-text input. |
| Is there usage at all? | Active and working computer counts; app opens; older-client relay totals, the phone's also by release and with debug/simulator builds apart | Background windows can count as active. An open is a surface going from no attached window to one, not each connection (the desktop holds one per machine and redials). Relay events are not distinct people; the populations must not be added together. `relay_mobile_opens` still counts every phone socket open, a reconnect included (on 2026-10-19/20 one simulator left open made 15,104 against 344 the day before). The first phone release after 1.0.8 (71) says its release and whether it is a debug or simulator build on the socket (`release`, `debug`), and each open is counted a second time: `relay_mobile_debug_opens` for a debug or simulator build, otherwise `breakdown:release:phone:<x.y.z>:relay_mobile_opens`, so the two never overlap and together equal the total for those apps. An older app, or any release that is not a plain x.y.z, counts under release `unknown`. A release's margin is shown only where the day has 20 phone collector observations, like the phone's other release margins; an Android emulator running a release build is not told apart. |
| Why are Desktop frames long, and on how many computers? | One in 60 rendered frames by duration; a sample of 50 ms or more also by its longest phase (`frame_slow_wait`, `frame_slow_build`, `frame_slow_raster`); once per collector day, the first sample over 250 ms (`frame_long_collector`) | Wait is the UI thread busy before the frame could start (on macOS and Linux the platform's main thread: timers, channel and native callbacks, synchronous IO, AppKit or GTK); build is the framework's build, layout and paint; raster is drawing. The phases add up to the samples of 50 ms or more counted beside them. `frame_long_collector` over `collector_days` is the share of collector days with a long sample: many long samples on few such days are a few computers, not a broad problem. Counted only once the computer's CLI has announced them (below), so not before a run's first report answer or behind an older CLI; compare releases separately. |

| Which features get tried and used again? | First measured installations and daily first/repeat feature reach | Locally deduplicated installation-days, not unique accounts. Reads the apps make on their own (history, history paging, Store list, model list; `PRODUCT_USAGE_AUTOMATIC_ACTIONS`) count reliability only. The Store and model lists get reach only from the request an app marks `userAction` when a person opens them (`<action>_user_*`, `PRODUCT_USAGE_USER_OPENED_ACTIONS`); history has none. |
| Where do app flows break? | Setup, Harness/tmux/clipboard steps, sign-in, workspace/remote connections, computer linking, viewer-pane opening and manual update checking/staging; a setup step whose tool was missing at a check (`setup_desktop_setup_<step>_missing`); the agents a new computer downloads beside setup (`setup_desktop_agent_download_<opencode\|codex\|claude>_started`, `_ok`, `_failed`, with under 1 min, 1–5 min and over 5 min) | Fixed started/ok/failed/cancelled/unknown counts and coarse duration buckets. Opening a viewer pane is not rendering its content; staging an update is not a successful relaunch. A setup step stays open from the first check until its tool is in place, so a tool that was missing and then installed is one ok step and one `_missing` mark; only a setup that ends failed fails its step. Earlier Desktop releases counted every check that found a tool missing as a failed step (on 2026-10-16 the Harness step read 72 failed of 221 while 0 setups failed): compare releases separately. `_missing` is any tool a check found absent or out of date (a Harness CLI older than this Desktop needs, on a computer already in use, counts too), not only new computers. A step left waiting (the review, a Linux Terminal handoff, manual mode, someone who walks away) now ends `unknown` at the 15-minute observation bound instead of `failed`, so expect `setup_*_unknown` to rise, mostly on Linux. `_missing` and the download counts are anonymous setup counts only. A download whose prerequisite (curl, Harness's Node) never arrived counts as started and failed; `ok` means the agent's program is in place, judged per engine. |
| Where does the phone's onboarding stall? | After sign-in: waiting for the first computer, opening its session, the first message, the notification prompt. A sign-in that went through, by button, counted again under the account's sharing. Waits past a minute split into 1–5 min, 5–15 min, 15 min–1 h and over 1 h for the computer and the first message. Once per step per sign-in: `resumed` (reopened in a run that did not sign in), "Not you? Sign out", the address sent from the share sheet, a joining computer that wants its password or is offline, `joined_after_leaving` (the computer turned up after the app left the wait), `new_account` (a sign-in that created the account). Once per install: `first_open` (signed out `setup_phone_first_open`, signed in `ui_phone_first_open`) | Stage totals per day, not a linked funnel. A wait's `ok` is a computer that turned up while its screen was open: add `joined_after_leaving` for the computers that came while the app was away (16–19 October 2026: 5 `ok` in 49 fresh waits, while 91% of the phone's people had a computer on the same account). `new_account` is an account minutes old at sign-in, its first Harness sign-in anywhere. `first_open` is set once per install by a local flag that is never sent: the step between a store's download and a sign-in. Subtract `resumed` from starts for fresh starts; an unmatched start is a closed app or a step still waiting. A resumed step's duration starts at the reopening. Signed-in sign-in counts are successes only; failures and cancels before an account remain the signed-out counts', but a success is marked `retried` (a failed or cancelled try came first in that app run) or `switched` (another button was tried first). Phone reports carry release and iOS/Android, so every phone count also splits by those two margins (above 20 collector days); debug builds are not kept. A chosen sign-out sends what is queued first (up to 2 s), so "Not you? Sign out" reaches the totals. The first message is the first line sent after the hand-over in any session, or a task typed into New Harness; before 2026-10-20 only the session the hand-over opened counted and leaving it cancelled the step (compare releases separately). Each step of a sign-in that created its account is marked `new_account` when counted and `new_account_ok` when it ends ok, so new people's funnel reads apart. The phone sends what it queued as it leaves the screen, since iOS can end a suspended app with its counts still in RAM. |
| How fast does the phone get back to work? | A launch that came back signed in, to its first computer answering (`app_start`); a dial the person asked for ("Try again", `connect_user`) apart from the app's own (`connect_auto`), beside the unchanged `remote_connect`; a stopped harness resumed from the phone, to its first live turn (`resume_recovery`) | A launch that signs in is the onboarding's and is not counted; one that leaves the screen before a computer answers (the app hidden, at the latest sent to the background) is `unknown`, one whose computers never answer stays started. What a launch waited on is counted beside it, once each, until a computer answers or the app leaves the screen (`ui_phone_app_start_<why>`): `no_computer` and `list_failed` (the account's list had none, or could not be read), `offline` (it said every computer was offline), `locked` (a computer wanted the phone's password), `connect_failed` (a dial to a computer said to be online failed) and `waited_1m` (a minute on screen); a launch can name several. An asked-for dial fails at 12 s, as Desktop Connect does. A phone dial is `failed` only when the phone knows why (locked or offline), `unknown` otherwise; the reasons (`connect_error_*`) are Desktop health counters. The phone's `remote_connect` is one computer's socket dialling, from connecting or reconnecting until it connects (`ok`) or drops (`failed`). `cancelled` is a dial still going when the app went to the background (the pause, not the app switcher or a system sheet): a suspended app never hears the socket's answer, so the dial ends there rather than staying without an outcome, and a dial after the app is back is a new count. The two dials beside it end the same way: a `connect_auto` or `connect_user` dial still going at the pause is `cancelled`, an asked-for dial's 12 s deadline goes with it, and the socket's answer after the pause counts nothing more. From build 72, the release after 1.0.8 (71), a `remote_connect`, `connect_auto` or `connect_user` dial still in progress when the app goes to the background ends `cancelled`; earlier builds, 1.0.8 (71) included, left it without an outcome (79 of the 252 `remote_connect` dials on 2026-10-20): compare releases separately. |
| Are the phone's side pages used? | Find and Computers opens, by a sideways swipe on the terminal or by a button (Computers' row in Settings, its link on a long wait at home) | Which page and which way, nothing more. Find's key and screen-reader actions are not counted; a swipe that lets Find go back opened nothing. |
| Does Desktop's Add Phone card get used, why is it skipped, and which opening leads to a new phone? | Each card has its own flow: `ui_desktop_phone_offer_*`, `phone_offer_returning_*`, `phone_offer_after_work_*`, `phone_offer_away_waited_*`, `phone_offer_away_finished_*` (all have the `ui_desktop_` prefix). `started` is on screen, `ok` its Add Phone, `cancelled` its ×, `unknown` another dismissal. Openings: `ui_desktop_add_phone_<offer\|titlebar\|menu\|account\|machines\|command>`. New phones: `ui_desktop_add_phone_paired_<same opening>`. Skips: `ui_desktop_phone_offer_skipped_<reason>` (below). | From 2026-10-26, a signed-in returning account gets the existing card once per account on this computer, only with no phone or browser and no prior × or Add Phone opening. It waits for first arrival; the local account record is written only on screen, so an unanswered card does not return at launch. An unreadable device list records nothing and retries next launch. Showing it spends the after-work offer and one slot of the away-card cap. All card flows are unbounded. The returning flow, skips and pairing counts wait in RAM for CLI vocabulary 6; older names keep their existing vocabulary. The browser counts none. See the [design](design/2026-10-20-desktop-phone-conversion.md). |

The daily product review shows `addPhonePaired` and `phoneOfferSkipped` beside `addPhoneOpenings` on its
`ui`/`desktop` `phone_offer` flow, with zero for missing opening or reason counters.

Add Phone skip reasons are a fixed list: `has_phone` (including a cached answer), `no_device_list`,
`already_shown` (a stored showing or the completed after-work decision), `stopped` (× or Add Phone opened),
`cap_reached` (the away card's combined show count is three), `not_signed_in` (including a missing account
identity or a workspace not ready), `viewer` (web or viewer window), `card_showing`, `no_storage` (missing or
unreadable local state), `account_changed` (the original account/work is no longer current), and `read_limit`
(after-work's three unanswered reads in this run). Count each path/reason pair at most once per app run.
Account-work invalidation clears the counted pairs, so another account can count again and old revisions do
not accumulate. A counter means a launch where that reason blocked that path, rather than a number of turns
or returns to the window; the same reason can count once for each distinct path. Fixed reason names and
vocabulary 6 are unchanged. No account or device identifiers, names, card text, or error content are reported.
The first sign-in path keeps
its existing fallback of offering a card when its device list cannot be read; that is an offer, not a skip.

A pairing counter uses the existing live account-join signal, only while the Add Phone dialog is open and
signed in. The dialog opens immediately while a known-key snapshot is read alongside it. Joins received
before the snapshot are held until it arrives; keys in that snapshot never count. It excludes computers and counts
each new device key once even if its notice repeats or the dialog rebuilds. A handshake alone may be an
existing phone and does not count. A second new phone can count in the same dialog. Attribution is omitted
when the opening snapshot fails or is null, the account identity is unavailable, or the account changes.
A join received while open can be attributed after closing once its snapshot arrives; notices received after
closing do not count. The snapshot never delays opening the dialog.
The snapshot and deduplication keys stay in RAM, outside the report. Returning cards use the `offer` opening;
their separate flow identifies the card. Openings measure dialogs, pairing counters measure new account keys,
and neither proves that the phone subsequently used a harness.

| Is measurement losing coverage? | Updated collector installation-days, pruned queues, full observation maps, unmatched app starts | Loss signals warrant caution. No signal does not prove complete collection. |
| How many people use Harness, and do they come back? | People active / working / new per day and per app, and D1/D2/D3/D7 returns (backend rollup of 10-day pseudonymous marks) | Sharing accounts only, staff excluded; an app open across midnight counts on both days, so prefer working returns. Not available before `PRODUCT_USAGE_SUBJECT_KEY` is set. |
| What do people do on the Hub? | Page views by page and signed-out/signed-in reader, the first page of a tab's visit by where it came from (direct, search, social, internal, other; classified in the browser, the referrer is never sent), clicks and submits (search, sort, like, comment, share, fork, follow, report, sign-in prompt, publish), and how long a harness page stayed visible (under 10 s, 10 s–1 min, over 1 min). A shared link (`/s/:id`, the web app) counts the same way: the page drawn by reader, what it showed (live, owner offline, private, no access, failed), how long a live harness stayed visible, and its clicks (comments, comment posted, sign-in, retry, Download app, product page), plus once when its live viewer draws | Unlinked daily totals of views, entries, clicks and dwell buckets: not people, not a funnel. Public counts that can be fabricated; directional only. Browsers sending Global Privacy Control or Do Not Track, and signed-in readers who turned sharing off, are not counted. The website's server strips cookies and auth before forwarding. |

Desktop setup and sign-in counts are enabled by default, with no onboarding checkbox. Desktop has
one “Share product usage data” switch in Experimental, with no separate Privacy page or feedback
controls. The browser keeps its existing Privacy page. Users can
turn them off in **Settings → Experimental → Share product usage data**, including before sign-in through
the app menu. Local booleans remember the preference and a pending opt-out across launches; reporting waits for
that preference to load and stays off if it cannot be read. The confirmed account preference takes
over after sign-in and is remembered for the next signed-out launch. An explicit Settings opt-out
before sign-in is applied to the account before Desktop sharing can resume; failures keep it pending
and reporting off. An account's default-on response cannot erase that pending choice. Turning sharing off discards
queued counts and open observations. It does not retract a request already sent.
The phone's **Share setup and sign-in counts** line, under its signed-out screens, is on by default too
and follows the same rules: unticking it is kept on the phone as a pending opt-out, applied to the
account at the next sign-in before phone sharing resumes; an unreadable choice is off; the confirmed
account preference is remembered for the next signed-out launch. With nowhere to keep the opt-out
(tests, the sample) it starts off. Neither native setup transport sends credentials/cookies or replays earlier actions.
Setup state already visible when sharing becomes enabled can start an observation; duration then
begins at that observation, not necessarily at installation start. The web app's pre-sign-in setup
collection stays disabled because a browser request to the backend cannot guarantee omitted cookies.
The Hub's counters, shared links' included, are the one web exception: the browser sends them to the website's own server,
which forwards them to the backend without cookies or auth, so the backend never sees a browser
credential (see the Hub endpoint below). These untrusted setup counts are
a separate population from signed-in app/daemon reports; older clients and opt-outs affect coverage. They
show observed friction at each step, **not** unique signup conversion or a linked user funnel.
Reproduce those paths with test accounts and synthetic inputs. No screen recordings,
click trails, stable analytics identifiers, locations, content or arbitrary properties are added.
The exact counter vocabulary is in [productUsage.ts](../backend/src/types/productUsage.ts); the Hub's is in
[hubMetricsContract.ts](../backend/src/lib/hubMetricsContract.ts).

From the first backend release after v1.2.93, the totals everyone reads leave out the team and the testers: a signed-in report from an
`@autonomous.ai` account is kept under `staff:<metric>`, and one from a tester's build (the phone from TestFlight,
`context.channel: 'testing'`) under `testing:<metric>`, margins included. `usage:daily` reads neither. On 16–19 October
2026 the team was 8–30% of the phone's people each day. Compare across this change separately: totals drop by what
the team and the testers sent. Signed-out setup counts have no account and still include them.

## The phone's counts, apart from the other apps

The phone app's own counts say they are the phone's, and a computer's daemon counts what the phone asks
it for under names of their own. Nothing else in a report is the phone's:

| Where | Names | What they are |
| --- | --- | --- |
| The phone's own reports (`context.surface: 'phone'`, `platform: 'ios' \| 'android'`) | `ui_phone_*` signed in, `setup_phone_*` signed out, `health_phone_collector_days`, `health_phone_report_*` | Its flows and marks in the rows above: sign-in by button, the onboarding steps, `first_open`, `app_start` and what it waited on, its dials, `resume_recovery`, the side pages |
| A computer's daemon (that computer's CLI report, `context.surface: 'cli'`) | `request_phone_<action>_<result>`, `request_phone_<action>_error_<kind>`, `request_phone_automatic_<poll>_<result>`, `phone_delete_error_code_<code>`, `phone_restart_error_code_<code>` | The requests the phone sent that computer (create, resume, restart, delete and the rest, and a typed `message`), and apart its own fixed polls, all of which it marks `usageSurface: 'phone'` inside the E2EE payload |
| Margins | `breakdown:release:phone:<release>:<metric>`, `breakdown:platform:phone:<ios\|android>:<metric>` | The phone's own counts by its release and OS, shown above 20 collector days |

Reading the phone apart:

- In a daemon's report `request_app_*` is the Desktop's and the browser's, `request_tool_*` scripts' and
  agents', `request_unknown_*` any other session's, and `request_automatic_*` every app's fixed polls (reads
  of history, history pages and the Store and model lists), the Desktop's and the phone's together. The
  phone's are counted again, apart, as `request_phone_automatic_<action>_<result>`, so the Desktop's and the
  browser's are `request_automatic_*` less those; a CLI before that counts only the total. The families with
  no source in their name (`<action>_ok`,
  `<action>_failed`, `delete_error_code_*`, `restart_error_code_*`, `create_error_code_*`, `turns_*`,
  `launch_*`) are every client's together, the phone's included: never add the phone's names to them.
- The other apps have their own prefixes: the Desktop `ui_desktop_*`, `setup_desktop_*` and
  `health_desktop_*`, hn `ui_tui_*` and `health_tui_*`, the browser `ui_web_*`.
- A phone older than 1.0.6 (68) marks none of its requests, and they count as `app`.
- Testers and the team: the phone's own reports from TestFlight (`channel: 'testing'`) are kept under
  `testing:`, an `@autonomous.ai` account's under `staff:`, and debug builds are not kept. A daemon's report
  is its computer's: the phone's requests in it go under `staff:` when that computer's account is the
  team's, but never under `testing:`, even from a TestFlight phone. On Android a Play test track installs as the store release does
  and cannot be told apart.
- The counts are UTC-day totals in `product_usage_totals` (`dayUtc`, `metric`, `value`): none names a
  person, a device or a computer (the 10-day people marks below are kept apart).

Daemon reports combine participating signed-in installations, both environments.
App reports are surface-specific operation totals; never add them to daemon or relay counts.
They are not all-user counts and are not directly comparable with earlier account-cohort reports
or industry retention benchmarks. Apart from the 10-day people marks below (a keyed pseudonym, deleted on opt-out), no per-person analytics
history or joining key is stored.
Authenticated requests still reach the service; infrastructure request logs and backups have their
own retention, which the release owner must verify separately. The account preference remains
linked to the account so the switch works everywhere.

## Runtime and storage budget

Desktop/CLI health adds separate marginal totals for the numeric public release and broad OS
(`macos`, `linux`, `windows`, `other`). The two dimensions are never stored together or joined to
the optional people records. The daily report suppresses margin labels and counts below 20
collector observations; these are not 20 distinct people and this is not a claim of anonymity.
Source/dev builds send a development context that ingestion drops without writing totals or receipts.
Legacy clients without context remain separately unattributed. Mixed-release queued days use
`unknown`; immutable in-flight receipts preserve their original context. Backdated returns are
excluded from release/platform margins so a return's release cannot be mistaken for its cohort's.

`health` in `usage:daily` reports consented setup/workspace/first-work/first-response milestones,
coarse waits, request-source reconciliation, explicit composer-work D1/D7/D28 cohorts, weekly work-day
bins, process health, and collector loss/rejection/late-report signals. `hub` reports the Hub's
daily views by page and reader, entries, clicks and dwell buckets, shared links' outcomes and dwell, with fork clicks per harness view
and sign-in prompt clicks per prompt shown as numerator, denominator and ratio; a day without Hub
reports is null, not zero. These are visits and clicks, not people. Milestones describe local
app episodes, can cross UTC days, and do not establish a joined signup conversion rate. First-work
cohorts use explicit composer messages; terminal keystrokes and automatic work remain unclassified.
Weekly bins cover completed weeks from installations that report again, so non-returners can be missing.

Desktop's focused first arrival has its own population, separate from those routine app sessions.
`health_desktop_first_run_started` enrolls one consented first-arrival episode in the current app
run. `first_run_ready`, `first_run_work` and `first_run_response` count opening its harness, a live
turn on that harness and a live text response after that turn. Other harnesses, replayed history
and repeated retry clicks cannot advance it. The response also has `under_1m`, `1m_to_5m` and
`over_5m` buckets, measured from first arrival after sign-in. All stages are attributed to the
episode's start UTC day, for at most 24 hours and only while the same app run and sharing choice
remain active. The machine/agent pair stays in RAM and never enters a report.
If the account preference is still loading, enrollment waits for its initial confirmation;
work and responses before that confirmation are not collected. An opt-out discards the
pending eligibility, and preference loading never cancels the user's harness.

The daily report's `health.daily[].firstRun.responsePercent` is
`100 × first_run_response / first_run_started`. Show the numerator and denominator alongside it,
and treat an incomplete follow-up day as provisional. This is first-session activation, not
unique people, install-to-signup conversion, completed tasks or a cross-restart 24-hour cohort.
There is no historical baseline for these new counters. The existing `firstLaunchCohorts`
24-hour response rate remains a separate, comparable historical measure: its first measured
launches also include existing users who updated. Do not compare the two percentages directly.
Version comparisons are descriptive; small samples, rollout mix and report loss can change them.

The setup milestone now comes from a rendered setup screen or tour, rather than every readiness
probe. It still counts observed setup episodes, not deduplicated installations. Signed-out setup
totals and signed-in totals cannot be joined or subtracted to infer individual sign-in conversion.

Shared-tab invitation actions have `ui_desktop_share_invite_*` and `ui_desktop_share_accept_*`
outcomes and wait buckets. A batch invitation also counts the acknowledged `shared_invites_sent`
and `shared_invites_refused` under `health_desktop_`, by list length only. An acceptance waiting for
trust confirmation is unknown until a later confirmed action; an acknowledgement alone does not
prove the invited person worked. These are action/result counts, not unique recipients or a joined
referral funnel. No addresses, invitation ids or tab ids are reported.

These first-arrival and invitation counters wait in the bounded RAM queue until the local CLI
advertises usage vocabulary 5. Publish backend vocabulary support before the CLI and Desktop;
an older proxy must never receive names it would reject. Turning sharing off or changing accounts
discards the episode and its queued counts. A close or crash can still lose unsent counters.

Native Desktop observes main-frame/first-frame viewer loading, updater apply acknowledgements and
the next observed version, explicit versus automatic connections, and resume-to-observed-work.
Known-unlinked native Desktop retry probes do not start additional automatic connection
observations: the initial refusal remains one outcome, and an explicit Connect is measured
separately. Older releases counted every probe in the health totals. A drop across this
measurement change is not evidence that fewer people encountered linking trouble; these
counters do not count affected people. Retry suppression adds no identifiers or stored history.
The startup bucket measures launch to the first consented observation of a connected workspace,
including preference/sign-in delay. One in 60 rendered frames supplies a coarse duration bucket;
it cannot reliably detect an idle freeze. Frames of a hidden, minimised or occluded window, and the
first frame after it is shown again, are not sampled (the OS throttles them), nor is each launch's
first frame, which `app_start` already times; earlier releases sampled both. A sample of 50 ms or more
also counts its longest phase: `frame_slow_wait` (vsync to build start, the UI thread busy with
something else first), `frame_slow_build` or `frame_slow_raster`, a tie going to the earlier one; the
wait for a raster thread still busy with an earlier frame is no phase of its own. The first sample over
250 ms of each collector day also counts `frame_long_collector`, so long frames can be told broad or
concentrated against `collector_days`. These four are counted only while the latest report answer
from the local CLI named counter vocabulary 2 or later (`x-harness-usage-vocabulary`), because an
older proxy refused a whole report for one name it did not know; samples before a run's first answer
count only their duration. Error hooks pass only framework/async categories.
Desktop RSS samples once per minute and gateway RSS/CPU once per report tick (45 to 75 seconds, a
minute on average); they describe those processes, not the whole machine or agents. Sampling adds
no core timer, process enumeration, or subprocess.

Desktop keeps its setup-sharing preference and pending opt-out booleans, plus the last sharing-enabled run's version, clean-exit/update flags, choice
revision and a local-only account-scope hash. One serialized asynchronous write plus one latest
pending value bounds disk work. It is cleared on sign-out/off and never enters a report. An unclean
run can mean a force quit or power loss, and only becomes observable if the app returns. Update
flags are best effort; the existing expected-version flag starts during download so its disk write
does not begin only at exit, and failed downloads clear it. Analytics never delays exit. Gateway work-day flags expire after 35 days;
a local yes/no marker prevents an old installation from being counted as newly activated again.
All new fields are allowlisted; no URLs, raw error strings, stack traces, device specifications,
task/session IDs or content are accepted. Feedback is voluntary and shown/answered/dismissed
counts are unlinked to the task and to the separate fixed-choice answer totals.

The daemon collector belongs to the gateway service, ordinarily a separate process. The core
forwards fixed counters with a 64 KiB optional-traffic backpressure limit, never waits for reporting,
and never wakes a service just to send measurement. Existing lifecycle broadcasts supply scalar
facts; no extra per-token observer, content reader, thread or database dependency enters the core.
Unmeasured RPCs return a shared no-op immediately. The `HARNESSD_SERVICES=none` development mode
runs services inline; it does not provide process isolation.

The gateway coalesces asynchronous disk writes, caps its local queue at 256 KiB / 35 UTC days,
and bounds in-memory turn/launch observations at 1,000 each (and the created launches' agents it
watches for a late failure, for 15 minutes each). Reports contain at most 64 counters and stay below
8 KiB. One sync runs at a time, with five-second network deadlines. The gateway reads the sharing
choice as it starts, so collection starts with it, and sends its first report a random 10 to 60
seconds later; each later tick comes a random 45 to 75 seconds after the last. Every daemon of a
release updated at the same second, and a report at start then one each minute made the fleet report
together: backend write conflicts and `USAGE_BUSY` refusals (41 and 48 on 2026-10-16). A report the
backend refuses as busy or failing (429, 5xx, a timeout) waits for a full-jitter backoff whose ceiling
doubles from two minutes to half an hour with each such refusal in a row, and never less than the
answer's Retry-After (held to the same half hour); any other answer resets it. Ticks still read the
choice meanwhile. Unknown or failed preference checks stop collection. Slow or failed reporting can
lose counts and cannot become a product dependency. A failed disk write also disables collection.

Stopping the gateway writes the collector's final, clean state synchronously before it returns
(a temporary file and a rename, at most the 256 KiB queue), and its process stops the gateway before
it closes the core's link and exits. A write still on its way cannot put an older state over it.
Earlier releases wrote the clean exit asynchronously and their process exited first, so `harness
stop`, updates, sign-in and sign-out restarts, service installs and OS logouts all counted as
`health_cli_unclean_restart` (69, then 170 on 2026-10-16, production counters). Compare that counter
by release across this change; now it counts a process that ended without stopping (a crash, a kill,
power loss, a stop that outlasted its five-second grace).

`health_cli_report_rejected` counts unsuccessful delivery attempts, including retries; it is not
a count of lost reports. A report that names a counter this backend does not know yet (a client a
release ahead of it) is kept without that name, never stored or echoed, and counted once as
`health_<cli|desktop|phone>_report_unknown_metric`; before, the whole report was refused and retried.
A report with no known counter left is still refused. New `health_cli_report_failure_*` counters split those attempts into fixed
invalid, too-large, authentication, rate-limit, timeout, unreachable, write-conflict, transaction,
server and other categories. A transaction failure does not by itself prove a timeout. No raw error
message, database detail, URL or unknown error code is collected. These diagnostics share the same
privacy choice and bounded queue, so a delivery outage can delay its own diagnostic counters.
Desktop now splits failed delivery attempts into the same fixed categories. A permanently invalid
or oversized packet is discarded so it cannot block newer reports; transient errors retry the
same receipt. Delayed errors after a choice or account change are discarded.
The local app proxy accepts only bounded UI counts, or Desktop health/UI counts with the exact
public release, OS and channel context. It does not accept daemon counters or arbitrary context.
Like the backend, it keeps a report whose only problem is a counter name this CLI does not know yet:
the name is dropped, never forwarded or logged, and a Desktop report counts
`health_desktop_report_unknown_metric` once. Earlier CLIs refused the whole report, and the Desktop
discards a refused packet. A known name an app may not send, a bad value, or a report with no known
counter left is still refused. Every answer of that route carries `x-harness-usage-vocabulary`, the
revision of the names it forwards (2: the frame phases; 3: the Add Phone card and openings; 4: the card offered after work and after time away); a Desktop sends newer names only after reading it. The frame phases are not counted until then; the Add Phone counts wait in the queue for it, because the card shows once per computer, often before the first answer.

Desktop and phone collectors keep only fixed counters in RAM, at most 64 in-flight observations,
with at most 32 counters per report, one pending report per channel and one flush at a time.
Callbacks from product actions never await measurement I/O. Reports retry no faster than once per
minute with the same random receipt. Send/receive deadlines are five seconds; the authenticated
app transport retains its existing 15-second connect timeout. Signed-out transport uses five seconds
for all three phases. Counts expire after
yesterday; app exit loses RAM counts. Update-stage outcomes may be lost during immediate exit;
never delay an update to flush analytics. There is no persistent app identifier or local event log.

hn reports as the `tui` surface: fixed `ui_tui_*` flow and `health_tui_*` milestone counters only,
sent as one-way `product_observe` frames to this computer's daemon, which accepts them only from hn
over the owner's socket, never relays them, and adds them to its own queue under the account's
choice; those arriving before its first choice read wait in RAM (64 at most) until it is known.
hn records only while signed in: nothing observed before sign-in is kept or sent, and a sign-in,
sign-out or account change discards what is waiting, so its own sign-in is not observed. Flows are
workspace and remote connections, computer linking, viewer opening (in a browser, or its link shown
over SSH), app start, workspace ready and resume recovery, each started when it begins as on the
Desktop; milestones are workspace ready, first work and first response, once per app session, with
the Desktop's definitions. Milestones are not reset when the sharing choice changes within a session.
At most 64 observations wait in hn's RAM (a full queue drops the rest and says so once per session,
`health_tui_observation_overflow`); nothing is written to disk. Its counters travel in reports of
their own. A backend that predates `tui` refuses only those, and the daemon then drops hn's counts
until the next UTC day or its own restart, without counting a failed delivery.

The signed-out endpoint permits only setup counters. Older native clients send `consent: true`;
default-on Desktop and phone send `sharing: "default"`, accepted only when every counter is one
surface's (Desktop or phone) and never recorded as an explicit opt-in. The two request forms are mutually exclusive. The endpoint rejects auth/cookie
headers, limits bodies to 4 KiB and values to 1,000, and admits at most 120 writes/minute and four
concurrent writes per server process. No IP-based analytics or new rate-limit identity is stored.
Exhaustion drops measurement rather than affecting sign-in. Public counts remain susceptible to
fabrication; they are directional diagnostics, not trusted account acquisition metrics.

`POST /api/product-usage/hub` takes only the Hub vocabulary: no setup, app or daemon counter, and
no Hub counter through those routes. It carries a random receipt, the UTC day (today or yesterday)
and at most one of each Hub counter, 1–1,000 each, nothing else: no URL, page id, referrer, harness, creator,
search text, shared link, its key or identifier. The website's server forwards it with cookies and auth stripped; the
backend rejects auth/cookie headers, limits bodies to 4 KiB and admits at most 240 writes/minute and
four concurrent writes per server process, a budget of its own so Hub traffic cannot starve setup
or sign-in measurement. The browser skips counting under Global Privacy Control or Do Not Track; the
website's server drops a signed-in reader's counts when that account's sharing is off. A view is a
page drawn, once per navigation; an entry is the first Hub page of a tab's visit; dwell is counted
once per harness view. A shared link counts each outcome at most once per page, so an offline owner's
automatic reconnects add nothing, and its dwell runs from the first live answer until the page goes;
it counts no entry. The web app (`desktop/lib/measurement/hub_usage.dart`) sends through the same
website route, without cookies, only in a release browser build and never for a staging link or
account. The same totals can come from one visitor or many.

Both ingestion paths atomically add only UTC-day/metric totals plus an unlinked random retry receipt.
Fast database write conflicts retry that complete transaction up to three times with short jitter,
rechecking the sharing choice each time. No retry starts after the first second; existing transaction
deadlines still apply to each attempt. Slow or exhausted conflicts return to the client's normal
immutable-report retry. Receipts prevent both immediate and later retries from counting twice.
Reports update their counters and separate margins in one Mongo update command inside
that transaction. A partial write aborts the receipt and all counts; no per-report body is stored.
This shortens shared-row contention without adding a daemon timer or delaying product actions.
Each backend process admits one aggregate report transaction at a time, with at most 32 waiting
reports and a two-second queue deadline. Overflow returns a retryable busy response. Permission
is checked inside the transaction after admission, including every conflict retry. Other server
processes can still contend; this does not promise zero delivery failures.
The public `/api/health` response includes validated release tag/SHA coordinates so a successful
image build can be distinguished from the version actually serving requests.

Resume diagnostics add fixed conditions by request source: runtime unavailable, saved state missing,
project missing, harness missing, credentials missing, busy, changed, unconfirmed, preparation failed,
launch failed, invalid and other. These come only from known error codes, never error text or paths.
An engine of a resumed harness that did not start (ENGINE_DID_NOT_START, ENGINE_NOT_INSTALLED,
START_TIMEOUT) is a launch failure, a resume while the harness is being deleted is busy, and a request
that named no harness is invalid; earlier releases counted these as `other`.
From CLI 0.4.3, an unconfirmed runtime counts as unknown and a concurrently changed harness as
cancelled (legacy aggregate: unknown), rather than failed. Compare releases separately across this
definition change; a lower failure rate alone is not proof the product improved.
Receipts expire within 36 days and totals within 396 days through the existing Mongo TTL indexes.
No account deduplication markers or stable hashes enter these totals. People-based daily counts and
D1/D2/D3/D7 returns come from one mark per sharing person per day under an HMAC pseudonym (no time,
machine, agent, device, country or content), kept 10 days and then only as anonymous `people_*` totals;
turning sharing off deletes the person's marks at once. Weekly/monthly people counts and longer returns
are not collected.

## Each daily review

1. Run `cd backend && npm run usage:daily -- 14` with a read-only `DATABASE_URL` supplied through the
   environment. Keep output in ignored `.harness/usage/`; never commit credentials or production
   exports. The command reads only allowlisted aggregate rows, performs no writes, and uses UTC days.
2. Check collection coverage, missing days, unknown outcomes and participating-installation counts
   before interpreting a rate. Preserve the numerator and denominator. Today is partial; late
   reports can change earlier days. A 24-hour first check can catch friction; D7/D28 and calendar-month returns need their full follow-up windows. Missing metrics stay unknown during rollout, not evidence of zero use.
3. Pick one product problem together. Record a hypothesis, target metric, guardrails, observation
   window, release commit/time and expected result **before** implementing it. Keep fixed cohorts
   and equal-length periods; do not select a favorable window after seeing the outcome.
4. Reproduce with synthetic inputs. Profile or benchmark a fixed workload on the same machine and
   toolchain before and after. Add a regression test for the behavior and check failures recover.
   In production compare reliability and wait buckets, not captured user errors or work.
5. Review and release. Record rollout boundaries outside the analytics data; do not infer exposure
   from a global date alone. Allow enough time for adoption and the selected follow-up window.
6. Compare the report's complete seven-day windows and mature cohorts. Repeated work is not
   independent sampling. A change in client adoption or participation can change a rate without a
   product effect. With little data, record "inconclusive" and the next observation date. Keep, revise
   or revert together; do not claim causality from a before/after count.

A review record can use this compact shape (no user or task identifiers):

```text
Question / hypothesis:
Synthetic reproduction and benchmark:
Primary metric / numerator / denominator:
Guardrails: launch failures, unknown outcomes, response waits, interruptions, privacy choice
Baseline dates / follow-up dates / cohort maturity:
Released commit / UTC rollout time / overlapping changes:
Observed coverage and uncertainty:
Decision: keep | revise | revert | inconclusive
Next review date:
```

The `review` output proposes investigations, not code changes or automatic deployments. Its unknown
launch refusals and its engines that did not start after a create each name their five most frequent
codes; a large `unlisted` share means a code is missing from `LAUNCH_ERROR_CODES`. Feedback
is one source of evidence; a missing response does not identify why a person stopped using Harness.

Launch codes include Windows launch and terminal-host refusals, and Git branch/worktree preparation
refusals. Older CLI releases reported these as `unlisted`; an old total cannot recover which code it
contained. Naming a refusal in a later release does not establish the cause of an earlier failure.

Setup refusals are also counted by their fixed code in separate families: `launch_failed_setup_code_<code>`
adds up to `launch_failed_setup`, `create_error_setup_code_<code>` to `create_error_setup`, and
`phone_create_error_setup_code_<code>` to `request_phone_create_error_setup`. This distinguishes missing
tmux/terminal hosts, native preparation, spawning and registration failures without sending their messages
or paths. Existing failure-kind totals and the `other`-by-code families keep their meaning. A launch's
status polls count its setup outcome once; request counters still count each create request. Older CLI
releases send no setup-by-code counts, so compare coverage by release. Deploy the backend vocabulary before
the CLI: an older backend refuses a whole report containing a new counter.

## Rollout and privacy controls

Deploy backend schema and the singleton worker first, including unique indexes and TTL indexes.
Use synthetic data to verify duplicate receipts, transaction rollback/retry, off/on revision fencing
and expiry. Then release CLI, desktop and phone together. An older backend refuses a whole report
carrying a counter it does not know (a phone page opening, a `request_phone_*` count, a phone
`sharing: "default"` setup report, a launch code, a first launch's engine, Desktop's Add Phone card or opening, a
phone's `testing` channel, which it refuses whole), so the backend always goes first. A backend
that keeps a report without the names it does not know yet drops the newer ones instead (the phone's
`first_open`, `new_account`, `joined_after_leaving` and `app_start` waits; the daemon's delete and restart
codes and message outcomes), counting `health_<surface>_report_unknown_metric` once per report: lost
counts, not lost reports, but still lost. Check that the switch saves and that reports
stop when it is off. Old clients stop contributing individual daily histories when the backend changes;
the historical reporting command will no longer be a current-usage source.

Hub counters roll out backend first, then website: an older backend has no `/api/product-usage/hub`
route and loses whatever the website sends it, and a backend that does not know a Hub counter
refuses the whole report, so a new Hub counter also ships backend first (shared-link counters: backend,
then the web app's release). Then check that a browser
with Global Privacy Control and a signed-in reader with sharing off send nothing.

People counts roll out in this order: deploy the backend without `PRODUCT_USAGE_SUBJECT_KEY` (no marks
are written); release desktop, phone and CLI with the updated "See what's shared" text; then set the key
(32+ random characters, in the Helm secret). The first D1 is available two days later, D7 eight days
later. Rotating the key: delete every `product_usage_activity` document first. Losing the key while
marks live prevents deleting a person's marks when they turn sharing off.

Suggested visible release note:

> Harness now shares limited product usage counts by default to help us find broken or slow flows.
> These counts do not include your prompts, responses, code, files or project details. Turn sharing
> off for your account in Settings → Experimental → Share product usage data, or use `harness privacy off`.
> Existing opt-outs stay off. Optional feedback sends only the answer you choose.
> With sharing on, Harness also keeps which days you used it and through which app, under an
> coded ID instead of your account, for 10 days, then only as combined totals.

Sharing off prevents subsequent admission of new reports and clears local queues at the next
successful preference check. An already admitted operation may finish. Combined totals cannot be
removed for one person because they have no identity link. The [backend guide](../backend/README.md#product-usage-with-an-account-wide-privacy-control)
documents queue bounds, retention, legacy deletion and the separate infrastructure checks.
