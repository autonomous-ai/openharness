# Releasing the mobile app

The App Store record is **Autonomous Harness** (`ai.autonomous.harness.ios`, team 54DJVWMJCC —
Autonomous Inc.). Everything up to [Android](#android--google-play) is the iOS side; the desktop app
ships from `desktop/RELEASE.md` on its own tags and shares nothing with this.

## The two numbers that decide whether an upload is visible at all

App Store Connect keys a build on the pair `(CFBundleShortVersionString, CFBundleVersion)` — in
`pubspec.yaml` that is `version: 1.0.0+2`, so `1.0.0` and `2`.

- **Bump the `+N` before every upload.** A pair ASC has already seen is refused, and the refusal
  arrives *by email* — the ASC UI shows nothing at all, which is exactly what "I uploaded it and
  nothing happened" looks like.
- **The short version must match the ASC version record.** A build uploaded as `1.0.0` never appears
  under a version record called `1.0`: the Build section stays empty and the version cannot be
  submitted. Rename one so the two strings are identical.

## Upload

One command. Credentials are already on the release Mac, so there is nothing to export:

```bash
bash mobile/scripts/release-ios.sh                 # build -> validate -> upload
bash mobile/scripts/release-ios.sh --validate-only # rehearse, upload nothing
bash mobile/scripts/release-ios.sh --skip-build    # upload what the last build left in build/ios
```

The build is `flutter build ios --config-only` followed by `xcodebuild archive` and
`-exportArchive`, not `flutter build ipa`: Flutter cannot hand xcodebuild an API key, so on a Mac with
no signing certificate and no Xcode account it failed at signing whatever key was configured.

The archive is **unsigned**; the export signs the app and its frameworks with the team's Apple
Distribution certificate. Signing the archive would need an Apple Development certificate on the Mac,
and the shared release account (`mobile.dev@autonomous.ai`) has used up its quota of those — Xcode
answers "Choose a certificate to revoke", and revoking one breaks whichever Mac holds it. Runner has
no entitlements file, so the export's own entitlements are all the app needs.

### Where the credentials live, and why not here

```
~/.appstoreconnect/harness-release.env          ASC_KEY_ID + ASC_ISSUER_ID   (chmod 600)
~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8   the private key    (chmod 600)
```

The script sources that `.env` whenever the environment does not already carry the values, so CI can
still pass them in. **They are deliberately not written into this file.** This repo is public, and a
Key ID plus an Issuer ID are precisely the two halves a leaked `.p8` would need to become a working
App Store Connect session — the repo's own `.gitignore` already refuses `*.p8` and `.env*`, and
putting the other halves in Markdown would walk straight around that.

Setting up a second machine: create a Team Key at App Store Connect ▸ Users and Access ▸ Integrations
▸ App Store Connect API (role **Admin**), drop the one-time `.p8` download into
`~/.appstoreconnect/private_keys/`, and write the two ids into the `.env` above. That is the whole
setup: the script hands the same key to the export, which signs with the team's cloud-managed
distribution certificate — nothing to sign into Xcode, nothing to import into the keychain. An App
Manager key uploads but cannot sign that way. An Apple ID plus an **app-specific** password
(`ASC_USERNAME` / `ASC_APP_PASSWORD`) uploads too, but then signing needs the account in Xcode (below).

The script validates before uploading, which is what catches a duplicate build number or a missing
icon size in thirty seconds instead of in an email twenty minutes later.

### Upload with an existing Xcode account

With neither credential set, the script signs **and** uploads with the Apple account signed into
Xcode ▸ Settings ▸ Accounts (a member of the Autonomous Inc. team): it archives as above, then runs
`xcodebuild -exportArchive -allowProvisioningUpdates` with `method = app-store-connect`,
`destination = upload`, `signingStyle = automatic`, `teamID = 54DJVWMJCC` and
`manageAppVersionAndBuildNumber = false` on `mobile/build/ios/archive/Runner.xcarchive`. Nothing is
validated first — altool cannot borrow Xcode's session — so `--validate-only` refuses this path, and
a duplicate build number shows up as the upload failing.

Build 49 used this path, by hand. Apple accepted the upload and started processing it. Xcode reported a
non-blocking missing dSYM for the vendored WebRTC framework; native crashes inside that framework
may lack symbolicated stacks until the matching symbols are supplied.

### Already uploaded

| Build | When | Where it went |
| --- | --- | --- |
| `1.0.0 (2)` | 2026-09-16 | TestFlight. Universal (iPhone + iPad) — superseded |
| `1.0.0 (3)` | 2026-09-16 | TestFlight. **iPhone only** |
| `1.0.0 (4)` | 2026-09-16 | TestFlight. Adds agent/machine search (`feat/mobile-search`) |
| `1.0.0 (5)` | 2026-09-16 | TestFlight. Agent creation flow; Machines tab pairs/unpairs |
| `1.0.0 (6)` | 2026-09-16 | TestFlight. Custom voice input on a terminal tap — misheard Vietnamese, removed for the keyboard's own dictation |
| `1.0.0 (7)` | 2026-09-17 | TestFlight. Voice input back, transcribed by the backend (`/api/voice/stt`); opens on the last agent's terminal |
| `1.0.0 (8)` | 2026-09-17 | TestFlight. Search grouped by folder, most recent first, one-bar field; keyboard only from a tap on the prompt; hold-to-talk mic; slimmer terminal chrome |
| `1.0.0 (9)` | 2026-09-17 | TestFlight. Terminal chrome rebuilt around a search bar, header folds away on scroll, ⋯ sheet grouped into Agent / Machines / App |
| `1.0.0 (10)` | 2026-09-17 | TestFlight. Smoother swipes and scrolling: parked and keyboard-sliding terminals keep painting; the header folds over the terminal instead of resizing it |
| `1.0.0 (11)` | 2026-09-17 | TestFlight. Agents either side of the one on screen open in advance, so a swipe lands on output instead of "Attaching…" |
| `1.0.0 (12)` | 2026-09-18 | TestFlight. Named OpenHarness on the home screen and in the app; Backspace on the phone erases text typed on the desktop; Machines moved into the ⋯ sheet; hold-to-talk hardened |
| `1.0.0 (13)` | 2026-09-18 | TestFlight. Search reads what agents said (the desktop's content index), recent first; Vietnamese Telex in the search field; terminal search has no Cancel, and the terminal holds still as it closes |
| `1.0.0 (14)` | 2026-09-18 | TestFlight. Voice sends on the second tap again — as a composer turn, not keystrokes Codex read as a paste and left unsent; the terminal scrolls again after New Agent → back |
| `1.0.0 (15)` | 2026-09-18 | TestFlight. The floating mic, Search and + are always there, on a see-through background |
| `1.0.0 (17)` | 2026-09-18 | TestFlight. The terminal holds still as the keyboard opens. (16 went to Play only) |
| `1.0.0 (18)` | 2026-09-18 | TestFlight. Tab, clear and `/` on the terminal's key bar; account-wide agents list in the terminal sheet; the phone sheet no longer cuts off its last rows |
| `1.0.0 (19)` | 2026-09-18 | TestFlight. The floating mic, Search and + sit on frosted glass, so they stand out from the output under them |
| `1.0.0 (20)` | 2026-09-21 | TestFlight. The phone holds only the agent on screen: the two beside it are no longer opened in advance, and the one swiped away from is closed — each hands its terminal back to the desktop. Voice keeps the audio at both ends of a take |
| `1.0.0 (21)` | 2026-09-21 | TestFlight. The account's tabs reach the phone: a swipe stays inside the tab you are in, the tabs themselves sit behind a mark beside `⋯`, and an agent started here joins that tab |
| `1.0.0 (22)` | 2026-09-21 | TestFlight. Named **Harness** on the home screen and in the app, with a new icon; the terminal runs to the bottom edge of the screen; only an explicit Take control press claims a terminal from the desktop |
| `1.0.0 (23)` | 2026-09-21 | TestFlight. The tabs mark unrolls the account's tabs as a rail of names under the header — the tab you are in wears a bar under its name — instead of opening a sheet; picking one switches and puts the rail away |
| `1.0.0 (24)` | 2026-09-21 | TestFlight. The tabs mark brings a panel up from the bottom: the account's tabs as a row of names, and the agents of the one picked as cards beside each other. A name changes the cards alone — another tab can be read into without leaving the terminal you are in — and a card is what opens an agent |
| `1.0.0 (25)` | 2026-09-22 | TestFlight. Opening an agent takes its terminal again: no read-only stream and no "Take control" band in front of an agent a desktop has open, including the one the app opens on. The band is left for the case it is about — a terminal taken back off this phone |
| `1.0.0 (26)` | 2026-09-22 | TestFlight. The tabs panel lists a tab's agents DOWN the page, as the rows the Agents tab draws, instead of as cards read sideways through a letterbox |
| `1.0.0 (27)` | 2026-09-22 | TestFlight. The tabs panel keeps one height — half the screen — whatever the tab holds, so reading a tab of one agent after a tab of six no longer moves the names along its top |
| `1.0.0 (28)` | 2026-09-22 | TestFlight. Search rebuilt on the desktop's own box: `>` commands, `#` projects, `@` machines and `?` help, and the desktop's ranking behind them, so a query that finds an agent on the laptop finds the same agent here. A result draws its identity as marks — engine, machine, folder, branch — instead of one run of text, and drops the square glyph and the age the desktop never had. Stopped harnesses are listed again, with `Stopped` on the row and a tap that brings one back; the field sits on the keyboard rather than above a strip of terminal |
| `1.0.0 (29)` | 2026-09-22 | TestFlight. The new logo reaches the phone — build 28 shipped the crop it superseded. `⋯` beside the tabs grid stands up as `⋮`, and the two marks move apart far enough to hold a whole touch target each: at the old spacing their 44pt reaches overlapped by 6pt and the row hit-tests backwards, so `⋯` answered for the right-hand sixth of the tabs mark and the tabs mark did not |
| `1.0.0 (33)` | 2026-09-23 | TestFlight. Opens on the agent it was left on, even while the machine is still verifying terminals; a Stopped row resumes its saved conversation (`agent_resume`, sealed as E2EE) instead of failing, and stopped work with no conversation reads `Resume unavailable`; other rows no longer read `No terminal` during a resume; the app wears Logo Harness_4 |
| `1.0.0 (34)` | 2026-09-23 | TestFlight. The search sheet opens on the desktop Harness Monitor's order (most recently active first) and names agents as the desktop does (`Untitled Pane` for a CLI-made name); rows show age, trouble, machine · folder · branch, and tokens / edits / PRs; New Harness asks the Git questions a window asks |
| `1.0.0 (35)` | 2026-09-23 | TestFlight. New Harness touch-ups (`bubu/mobile-new-harness-touch`); the confirm dialog sits on the app's dialog veil |
| `1.0.0 (36)` | 2026-09-23 | TestFlight. The mic becomes a morphing capsule: a live waveform and take timer while listening, and its own face for busy, sending, sent and retry; notices wrap to whole sentences and clear themselves |
| `1.0.0 (37)` | 2026-09-24 | TestFlight. When the agent left on has been paused, the app opens the most recently active one — the desktop monitor's order — instead of the oldest; the banner over a terminal another app drives names that machine ("MacBookPro2021.local is using this terminal") when its CLI says who holds it |
| `1.0.0 (38)` | 2026-09-24 | TestFlight. Tabs only: the "Other" group is gone, and a launch that cannot reopen the last agent opens the tab the phone was last in, on its first agent; search results follow the desktop's rules (every engine its machine can resume reads Paused and resumes, not "Resume unavailable"), and the terminal header reads like the desktop's pane header — the session's title, the repository rather than a worktree's folder, and no placeholder branch |
| `1.0.0 (39)` | 2026-09-24 | TestFlight. Notices, as the dial gives them: an agent that finishes a turn or asks a question while you are elsewhere chimes, wears an unread mark, and — with the app in the background — posts a system notification (local, so only while iOS keeps the app alive); opening the agent takes its notice down. Codex's queued questions get an Answer band, with Enter on the key bar and hints for keys a phone lacks. New Harness asks what the desktop's launcher asks, Approvals included. The terminal header names the machine. A launch whose desk answers after its machines no longer sits on "Opening your tabs…" until the next desk poll |
| `1.0.0 (40)` | 2026-09-24 | TestFlight. Each desk tab pill wears the unread dot of its agents — amber when one is waiting on you, blue when one finished — so the tab to open is visible before opening it; opening an agent now takes its mark (and its notice) down whichever way it was opened, including an agent with no terminal attached yet, which kept its dot beside the ✓ in 39 |
| `1.0.0 (42)` | 2026-09-24 | TestFlight. Sign-in stays in the app: the email, then the 4-digit code sent to it (the Autonomous account API, as the Autonomous companion app signs in) — no browser and no loopback callback, which is what Play's reviewer could not get past. The New tab sheet groups agents by machine; the key bar carries its own modifiers and answers the thumb; Search stays reachable, and reaches the bottom of the screen, with the keyboard up. (41 went to Play only) |
| `1.0.0 (43)` | 2026-09-25 | TestFlight. Relay frames to a machine are sealed under the connection's E2EE session whenever the machine asks for it (`strictDown`, security issues OH-1/OH-10, #344); key hints move into the key bar; the keyboard comes back with the app after switching away; an opt-in setting holds the connection while the app is off screen |
| `1.0.0 (45)` | 2026-09-25 | TestFlight. The unread mark goes red and moves to the end of its row; the search sheet opens at full height; the opt-in "hold the connection while off screen" setting from 43 is taken back out (its foreground service needed a permission-and-notification walkthrough that cost more than the reconnect it saved). 44 was bumped but not recorded, so it is skipped |
| `1.0.0 (46)` | 2026-09-25 | TestFlight. The search sheet lifts to full screen while a search is typed; a machine that locks out remote-password attempts says so (OH-5, #353); the browser setup links are gone (OH-2, #348) |
| `1.0.0 (47)` | 2026-09-25 | TestFlight. The tabs/search sheet closes the easy way: Close beside the field, a pull of 120pt instead of half the screen, and a pull from anywhere on a list already at its top. The terminal keeps a snapshot's colours as tmux carried them (a wrapped dim line no longer turns bright after a resize or reconnect) — the fix is in the CLI, so it shows once the machine runs it; a truncated 38/48 colour no longer fails the renderer, and palette slot 15 is bright white |
| `1.0.0 (48)` | 2026-09-26 | TestFlight. Paste in the terminal's ⋯ sheet: the clipboard's text as one paste, or, with no text, its image as an attachment (iOS and Android, #321 by jaylfc). The pager no longer counts an agent it is about to close against its cap of open streams, so the page ahead attaches after a swipe |
| `1.0.0 (49)` | 2026-09-28 | TestFlight upload accepted; processing started. Phone polish and cleanup, full recent-first Agent picker, Project/Find search autofocus, collapsed Options with separate Branch/Worktree controls and Model choices, and trusted-device group sync from main. 1,643 offline tests pass; analyzer clean outside existing third-party infos. |
| `1.0.0 (50)` | 2026-09-30 | TestFlight. Light mode, with Dark and Light terminal schemes (#248); an agent's question is answered by tapping its lines; Find gets a tab filter, recaps for the rows on screen, and machine status drawn like harness rows; a new project and its agent are named after the first task (#94). Terminals open over the relay without waiting for p2p, picking an agent redials a machine that had backed off, and the home agent stays while its machine is briefly offline. Camera access that is off links to Settings; analytics are gone. Built from `feat/mobile-ios-android` |
| `1.0.1 (51)` | 2026-10-01 | TestFlight. First build on the 1.0.1 train — 1.0.0 was approved and its train closed, so ASC refused 1.0.0 (51). Faster launch to the first session; tabs named as on the desktop; Find recaps fold behind a chevron; device key log (#518). First upload from an unsigned archive signed on export (`release-ios.sh`, Xcode account). Built from `feat/mobile-ios-android` |
| `1.0.1 (52)` | 2026-10-01 | TestFlight. The launch terminal opens before the agent list; the desktop app, web and CLI sign in by scanning a QR with the phone (#519). Built from `feat/mobile-ios-android` after merging `main` |
| `1.0.1 (55)` | 2026-10-02 | TestFlight. Sign in with Google or Apple (an in-app SFSafariViewController over the loopback, so no Sign in with Apple entitlement); faster launch for large accounts and a full skeleton while it loads; back button on the Computers and device pages; device key codes to compare. ASC refused 54 as already uploaded — someone uploaded a 54 that is not recorded here. Built from `feat/mobile-ios-android` at `f95db4a2` |
| `1.0.1 (56)` | 2026-10-05 | TestFlight. Copy and paste in the terminal (the key strip's `paste` asks iOS `hasImages`, which never brings up the paste prompt); computers and profiles can be renamed, removed and retried; Devices DSH frames sealed as the CLI requires. Built from `feat/mobile-ios-android` at `28e95521` |
| `1.0.1 (57)` | 2026-10-06 | TestFlight. Typing in the terminal no longer lags or drops keys: keys echo locally and go out before the IME resets. Remote scroll is smoother, with a native-like fling and a scroll mirror that follows the finger; the stray cursor is hidden; p2p holds when late relay frames arrive. Onboarding explains its sign-in steps and sign-outs, and scanning a computer's sign-in QR signs the phone in first. Uploaded with the Xcode account from the second Mac; Xcode again reported the non-blocking missing WebRTC dSYM. Built from `feat/mobile-ios-android` at `b896acd8` |
| `1.0.1 (58)` | 2026-10-06 | TestFlight. Remote scroll for Claude Code is faster and steadier: page keys and paced wheels fetch rows, each agent keeps its rows, and rows above are prefetched while idle. The key strip's hide-keyboard key is larger. Onboarding says where Add Phone is and which account to use, offers Scan again after a failed pairing, and shortens the scan page's sign-in hint. Uploaded with the Xcode account (`release-ios.sh`); Xcode again reported the non-blocking missing WebRTC dSYM. Built from `feat/mobile-ios-android` at `8b174045` after merging `main` |
| `1.0.1 (59)` | 2026-10-07 | TestFlight. Onboarding gets exits and shorter sign-in waits (`fix/mobile-onboarding-exits`), on top of 58. Built from `feat/mobile-ios-android` at `421c54d3` |
| `1.0.1 (60)` | 2026-10-07 | TestFlight. Onboarding hardened: one pairing at a time, Scan again and a way out of slow waits, sign-out clears the last account's computers; computer set-up in three steps; iOS local network usage description. Uploaded with the Xcode account (`release-ios.sh`); Xcode again reported the non-blocking missing WebRTC dSYM. Built from `feat/mobile-ios-android` at `1d58a94e` |
| `1.0.2 (61)` | 2026-10-08 | TestFlight. Shows when a computer is asleep instead of loading, polls faster while all are asleep and adds a refresh button; reopens the terminal before the agent list on reconnect; the key strip leads with a question's key hints, Codex glyph hints (`⇧←`) included. ASC refused it as `1.0.1 (61)`: 1.0.1 had been approved, which closes its train, so it went up as 1.0.2. Built from `feat/mobile-ios-android` at `99e17f3d` |

`pubspec.yaml` is now at `1.0.2+62`, the next build number. Build 61 (1.0.2) is the last iOS upload and 60
the last to both TestFlight and Play (54 went up outside this record, 53 went to Play only); do not upload any of them again. 1.0.1 is approved, so its train is closed: new builds go up as 1.0.2. Check App Store Connect before uploading if another release has happened meanwhile.

### Why the app is iPhone-only

`TARGETED_DEVICE_FAMILY = 1`. It was `"1,2"` — Flutter's default — and App Store Connect answers a
universal binary by requiring a 13-inch iPad screenshot set on top of the iPhone one, which is what
blocked *Add for Review*.

⚠️ The iPad LAYOUT still exists and is still reached by the shortest-side breakpoint in
`lib/phone/phone_layout.dart` ("an iPad keeps the rail beside its terminals"). Nothing about it was
deleted; it simply is not shipped to iPad any more. Putting iPad back is one line here plus a 13-inch
screenshot set — and a new build, since the requirement follows the BUILD selected on the version,
not the app record.

Uploading is not submitting. Processing takes 5–30 minutes, then the build becomes selectable in the
version's **Build** section.

## Metadata — what goes in each field

Fill these on *Distribution ▸ iOS App 1.0.0*. Apple will not accept the version while Description,
Privacy Policy URL, App Privacy, age rating or pricing are blank.

**Subtitle** (30 max)

```
Your coding agents, anywhere
```

**Promotional Text** (170 max — editable later without a new build)

```
Attach to the coding agents already running on your machines. Same panes, same scrollback, end-to-end encrypted — now from your phone.
```

**Description**

```
Harness puts the coding agents running on your own computers in your pocket.

Claude Code, Codex, Cursor and a dozen others already run on your Mac or Linux box. Harness keeps
each one in a live session on the machine it runs on, and this app attaches to those sessions from
your phone — the same panes, the same scrollback, exactly where you left them.

WHAT YOU CAN DO
• Read what an agent is doing right now, from anywhere
• Type back: answer a prompt, approve a step, send a new instruction
• Send a photo or screenshot straight into a session
• Switch between machines and between agents in one list
• Rename, restart or delete an agent without opening your laptop

HOW IT WORKS
Sessions live on your machine, not in this app and not on a server. Closing the app, losing signal or
switching devices changes nothing about what the agent is doing — you reattach and the work is where
it was.

Everything between your phone and your machine is end-to-end encrypted. Where the network allows it
the connection is peer-to-peer; where it does not, the relay carries ciphertext it cannot read.

WHAT YOU NEED
• An Autonomous account
• At least one Mac or Linux machine running the free Harness CLI, paired to that account

Harness for iPhone is a companion to that setup, not a standalone editor or a general-purpose SSH
client. Without a paired machine there is nothing for it to attach to.
```

**Keywords** (100 max, commas, no spaces)

```
terminal,tmux,ssh,claude,codex,cursor,coding,agent,developer,remote,shell,devops,pair,session
```

**URLs**

| Field | Value |
| --- | --- |
| Support URL | `https://www.autonomous.ai/harness` |
| Marketing URL | `https://www.autonomous.ai/harness` |
| Privacy Policy URL | **required — use the real Autonomous policy URL; there is none in this repo to copy** |

**What's New** — leave empty for 1.0.0; it is only shown for updates.

## App Privacy

Answer these from what the code actually does, not from habit. The app has **no third-party SDK**:
analytics go to Autonomous's own `event_tracking` endpoint (`lib/analytics/`), and crash records are
written to a local `errors.log` and never leave the device (`lib/core/crash_log.dart`).

| Data type | Collected | Linked to the user | Purpose |
| --- | --- | --- | --- |
| Contact Info ▸ Email Address | Yes | Yes | App Functionality, Analytics |
| Identifiers ▸ User ID | Yes | Yes | App Functionality, Analytics |
| Usage Data ▸ Product Interaction | Yes | Yes | Analytics |
| Diagnostics | No | — | crash log stays on device |

**Tracking: No.** Nothing here follows a person across other companies' apps or goes to a data
broker, so the app needs no App Tracking Transparency prompt.

Terminal contents are deliberately outside all of this: `Analytics.track`'s contract forbids message
text, prompts, terminal output, file contents and absolute paths, and the session bytes themselves
are end-to-end encrypted.

## App Review notes — the part that gets 1.0 rejected

A reviewer opens this app, signs in, and sees **no machines**, because they have none running the
CLI. That reads as a broken or incomplete app (Guideline 2.1) and it is the single most likely reason
this version comes back. So:

1. Create a demo account and put it in **App Review Information ▸ Sign-In Required**.
2. Leave a real machine online, paired to that account, for the length of the review — a reviewer who
   can attach to a live agent cannot mistake the app for an empty shell.
3. Paste notes along these lines:

```
Harness is a companion app for developer agents running on the user's own computers.

Demo account: <email> / <password>
A Mac paired to this account is kept online for the review, so the Agents tab will list live
sessions. Tap one to attach to its terminal, read the output and type into it.

The app does not run any agent itself: it attaches over an end-to-end encrypted channel to sessions
owned by the user's own machine, which is why an account with no paired machine shows an empty list.

The camera permission is used only when sending a photo into a session (Agents ▸ a session ▸ the
image button).

The microphone permission is used only for voice input: the mic button under a session's terminal
records what is said, and it is transcribed into the message sent to that session (a session ▸ the
mic at the bottom right).
```

## Submitting

1. **Build** section ▸ `+` ▸ pick the build you uploaded.
2. Fill everything above, plus age rating and *Pricing and Availability*.
3. **Add for Review** ▸ **Submit for Review**.
4. Watch for **Pending Developer Release** after approval — approved is not released; that state
   waits on a button of yours, forever if you let it.

## Open risk — export compliance

`ios/Runner/Info.plist` declares `ITSAppUsesNonExemptEncryption = false`, which auto-answers the
export question and is right only for an app whose encryption is the OS's own HTTPS. This app
terminates its own end-to-end encryption (X25519, ChaCha20-Poly1305, a CPace PAKE — `lib/e2ee/`), so
that answer is very likely wrong. Settle it with whoever owns export compliance before submitting: a
wrong answer is not a build failure, it is review asking a question and the version standing still
until someone answers it.

## Android — Google Play

The Play app is **OpenHarness**, package **`ai.autonomous.harness.android`**. ⚠️ That id is permanent
from the first upload on: Play keys the app on it and there is no renaming it afterwards.

### Build

```bash
bash mobile/scripts/release-android.sh   # -> build/app/outputs/bundle/release/app-release.aab
```

It builds and checks the bundle is signed with the upload key; it does not upload. Play takes the
`.aab` by hand: Play Console ▸ OpenHarness ▸ *Test and release* ▸ a track ▸ **Create new release**.

The versionCode is the same `+N` as the iOS build number. Each store keeps its own count, so one `+N`
can go to both — but Play refuses a versionCode it has seen, exactly as App Store Connect does, so the
`+N` is bumped after an upload to either store.

### The upload key

```
~/.android-release/harness-upload.jks          the upload key (PKCS12, alias `upload`)   (chmod 600)
~/.android-release/harness-upload.properties   its path and passwords                    (chmod 600)
```

Outside this public repo for the same reason the App Store Connect key is. `android/app/build.gradle.kts`
reads the `.properties` (or `HARNESS_ANDROID_SIGNING`, for CI); without it a release build signs with
the debug key so `flutter run --release` still works anywhere, and the script refuses to build.

**Play App Signing** holds the real app signing key — accept Google's generated key when the first
release asks. This one only proves an upload came from us, so a lost one is recoverable (Play Console
▸ *App integrity* ▸ request an upload key reset), but that takes days. **Back both files up to the
team's password manager.**

### First release — once

1. **Create app** (Play Console ▸ *Create app*): name `OpenHarness`, default language, *App*, *Free*.
2. **App content** — Play will not publish anything to production while one of these is open:
   - *Privacy policy*: required (the app asks for the camera and microphone). Same URL as iOS.
   - *App access*: sign-in is required → give the demo account from the iOS review notes, and keep a
     machine paired to it online, for the same reason as [App Review notes](#app-review-notes--the-part-that-gets-10-rejected).
   - *Ads*: no. *Content rating*: fill the questionnaire (a utility, no user-generated content shown
     to others). *Target audience*: 18+.
   - *Data safety*: the [App Privacy](#app-privacy) table above, restated — email address and user ID
     (app functionality, analytics), app interactions (analytics); all encrypted in transit; no data
     shared with third parties; crash logs stay on the device.
     ⚠️ **Plus Audio ▸ Voice or sound recordings (app functionality)**, which that table leaves out:
     voice input uploads the recording to the backend's `/api/voice/stt` to be transcribed. Declare it
     *processed ephemerally* only if the backend keeps nothing — TODO(BE): confirm. The same gap is on
     the iOS side (App Privacy ▸ Audio Data). Pictures sent to an agent are not collected: they go end
     to end to the user's own machine, where we cannot read them.
3. **Store listing**: the iOS subtitle and description fit the short (80) and full (4000) fields;
   plus a 512×512 icon, a 1024×500 feature graphic, and at least two phone screenshots.
4. **Internal testing** first: *Create new release* ▸ upload the `.aab` ▸ add testers by email ▸ share
   the opt-in link. Live for testers within minutes, no review.
5. **Production**: *Create new release* ▸ same `.aab` (or *Promote release*) ▸ **Send for review**.
   A new app's first review takes days, not hours.

⚠️ A **personal** developer account created after November 2023 must first run a *closed* test with
at least 12 opted-in testers for 14 days before it can even apply for production. An organization
account (Autonomous Inc.) is exempt — check which kind the account is before planning a date.

### Already built

| versionCode | When | Where it went |
| --- | --- | --- |
| `16` (1.0.0) | 2026-09-18 | Internal testing — the first Play upload |
| `41` (1.0.0) | 2026-09-24 | Built for resubmission after Play rejected the build under the broken-functionality policy (its browser sign-in redirected to `127.0.0.1`, which timed out on the reviewer's device). Signs in with an emailed code instead; also carries the notices and tab marks of iOS 39–40 |
| `53` (1.0.1) | 2026-10-01 | Internal testing. Same code as iOS 1.0.1 (52): faster launch, QR sign-in for desktop/web/CLI (#519), tab and Find polish. First Play build from the second Mac, with the upload key copied from the first (`storeFile` rewritten to this Mac's path) |
| `60` (1.0.1) | 2026-10-07 | Internal testing. Same code as iOS 1.0.1 (60): Google/Apple sign-in, faster launch, terminal typing, paste and scroll fixes, renaming computers and profiles, the hardened onboarding |
