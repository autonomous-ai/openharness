# Phone review panel, rounds 3 and 4

Four independent AI personas reviewed every phone render and the sample-mode simulator tour. The fourth round meets the requested 8/10 threshold for every persona.

| Persona | Lens | Round 3 | Round 4 | Daily use after round 4 |
|---|---|---:|---:|---|
| Maya | Consumer-app design lead | 7 | 8 | Yes |
| Priya | 6–10 harnesses across three computers | 7.5 | 8.2 | Yes |
| Sam | First-time user | 7 | 8 | Yes |
| Jordan | Apple Design Award and accessibility lens | 7 | 8 | Yes |
| **Mean** | | **7.125** | **8.05** | |

## Evidence

- Round 3: 25 screen renders and 17 simulator tour captures.
- Round 4: 25 refreshed renders, 19 simulator tour captures, and a new walkthrough video.
- The integration tour now launches `SampleApp` directly. It never loads a saved account, and the sample's terminal, voice and computer replies run in process.
- The render fixture remains 42 columns wide. Chooser tests cover short lists, long lists, keyboard clearance and drag dismissal; sample tests pin the attention dot's position.

These scores describe the visible experience in offline artifacts. VoiceOver behavior, real-device speech accuracy and production connection performance require separate verification. Dynamic Type and the other user-decision proposals remain deferred.

## Changes reviewed in round 4

- A fixed yellow attention dot, opaque backing and readable text aligned to the terminal gutter.
- Agent and Project sheets that fit their contents, with aligned titles, scrolling when needed and a native grabber.
- Stronger field-placeholder contrast, including a numerical contrast regression test.
- A visible sample entry on Welcome and near the top of setup; sample identity on pickup, Focus, Find and New; a shorter sample terminal hint.
- Unlock copy that identifies the Harness phone password, promotes scanning and uses the desktop's verified `Machines ▸ computer ▸ Set password` wording.
- A neutral Settings avatar and visibly disabled sign-in until the four-digit code is complete.
- Project-first context in New's compact keyboard summary.

All four reviewers considered the material round-3 findings resolved. No visible blocker to 8/10 remained within the authorized scope.

## Remaining observations

- Priya: asking rows in Find should retain computer/project identity alongside the question. This concerns Find rows; it does not implement the deferred Focus header.
- Maya and Sam: leave more space between long project values and the chooser chevron.
- Priya and Jordan: the compact New summary can still abbreviate the agent name; two short lines could preserve both values.
- Maya and Sam: Unlock recovery could better serve someone who has never set a password; an empty password could have a clearer inactive action.
- Sam and Priya: shorten the glossary and avoid promising that separate worktrees isolate shared services.

The early play-icon objection was withdrawn after checking that setup opens a distinct video page. The written glossary is a separate destination.

The user's decisions on voice auto-send, microphone placement, the word “harness”, the asking label and the absence of a scroll indicator remain in place. The decision list in the [handoff](2026-09-28-phone-overnight.md) is unchanged.
