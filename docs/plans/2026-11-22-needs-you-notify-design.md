# Needs you: agents in the Harness app ask without blocking, and the dial shows the ask

Status: draft for the orchestrator's approval (2026-11-22). Branch `feat/needs-you-notify`, from main at 2e45e251d3.
Builds on [the agent tells the dial](2026-11-16-dial-agent-notify-design.md) (#4379) and
[the dial skill in every home](2026-11-16-dial-skill-every-home-design.md).

## What and why

Diego's boss runs Claude and Codex in the Harness desktop app on his Mac, with a dial on the desk. The prompt he types
most is "what other decisions do you need from me?": the agents run on their own, and he checks in to unblock them.
He wants the dial to tell him instead, so he never has to ask (proposal, 2026-11-22).

Today (main at 2e45e251d3, read from the code):

- A Claude or Codex session the app runs uses the person's default home (`~/.claude`, `~/.codex`), is allowed to run
  `harness device notify` without a question on macOS and Linux (`HarnessAllowance`, `engines/facets/hooks.ts`), and
  its notice lands on its own card: the devices service matches the caller's engine and session id against the core's
  agents (`services/devices.ts`, the notice handler). The open-window gate (`heldOnTab`) holds only outside agents.
- **Claude's skill hangs on the plugin install.** The devices service writes the `dial` skill into Claude's home only
  while the `harness-device` plugin reads on in `~/.claude/settings.json` (`cable/dialHomeSetup.ts`, `on()`). The
  service installs that plugin itself on its first pass after a dial attaches (`cable/dialPluginSetup.ts`), but the
  install runs `claude plugin` from the daemon's environment and fetches from GitHub: when `claude` is not found there
  or GitHub cannot be reached, it fails and is retried an hour later, and until it succeeds the app's Claude agents
  have no skill. Codex gets the skill unless turned off.
- **The skill asks the wrong way for this.** It says "ring their dial before you hand it to them" and takes one free
  line: no recommendation, no word on whether the agent goes on or waits, and nothing against a blocking question form
  (Claude Code's AskUserQuestion, Codex's `request_user_input`), which stops the agent until someone answers.
- **A turn that ends with a written question counts as done** (`lib/notifyTier.ts`, `rule:turn`). Nothing reads the
  turn's text, by design (Jev was taken out on 2026-11-02). The agent's own notice is the fix: a turn whose notice is
  pending already ends silent (`devices.ts`, `rule:notice`), so the person gets one ring, the ask's.
- The person's typed answer in the app goes into the same pane as a normal prompt (`core/input.ts`
  `createMessageRequest` → `messageWriter`); the agent's next turn starts and takes the card down. Nothing to build.
- Windows: Harness writes no allowance there (`engines/kit/hookSettings.ts`: the Messages block and the allowance are
  both skipped on `win32`), so Claude Code asks before `harness device notify` and the agent stops on that question.
  Ken's Windows and Linux pull requests have merged, so the three-OS rule holds: this is fixed here.

Done when, on a Mac with a dial and the Harness desktop app (no Harness Device menu-bar app needed):
1. A Claude or Codex session the app runs has the `dial` skill, also when the plugin install has not succeeded, and
   when it needs the person to decide or act it runs
   `harness device notify "<question>" --suggest "<recommendation>" --proceeding` (or `--waiting`), keeps working,
   and the dial shows one card on that agent: `Proceeding · <question> · Doing: <recommendation>`.
2. The turn ends silent (the card already rang); a plain finished turn sends no notice.
3. The person types the answer in the app; it reaches that agent as its next prompt, and the card goes.
4. The same on Linux, and on Windows with no permission question before the command.

## Every app (orchestrator with Diego, 2026-11-22)

The skill, its rules and the command are for every Claude Code and Codex session on this computer, whatever app runs
it, not only the Harness app. The person answers in that agent's own app; the dial's card names it ("In <app>",
`cable/hosts/hostDetect.ts`) and a tap opens the agent there. What differs per app is only how the skill and the
allowance reach the session and how its notice finds its card:

| App | Engine home | The skill gets there | The allowance | The notice's card | Answer in |
|---|---|---|---|---|---|
| Harness app | default, or a recorded profile home | the devices service; for Claude, also with no plugin while Harness runs a Claude agent (new) | written by the core at each launch | the Harness agent (engine + session id) | Harness |
| Orca | its account profile; `skills/` linked to `~/.claude/skills` | the default home's write, through the link; Codex homes from the open scan | the profile's own settings (already there on this Mac) | the observed session | Orca |
| iTerm2, Terminal, tmux, herdr, Ghostty and other terminals | default | the devices service; Claude needs the plugin on | written into the default home at the daemon's start | the observed (or herdr-listed) session | that terminal |
| VS Code, Cursor: terminal and the Claude Code panel | default | as terminals | as terminals | the observed session | VS Code / Cursor |
| The Claude app (Claude Code inside it) | default | as terminals | as terminals | the observed session | Claude |
| The ChatGPT app (Codex inside it) | default `~/.codex` | the devices service | as terminals | the observed session | ChatGPT |

- The only difference this item makes between apps: Claude outside Harness still gets the skill only while the
  `harness-device` plugin reads on (the devices service installs it on its first pass after a dial attaches); not
  waiting for the plugin holds only while Harness itself runs a Claude agent. Since the skill is a file in the shared
  home, a Claude agent in the Harness app also brings it to the other apps' Claude sessions on that home.
- The new skill text and the new command reach every app the same way: the devices service rewrites Harness's copy in
  every home it writes.
- A per-app eval scenario (a decision ask gives exactly one notice on that app's card; a plain finished turn gives
  nothing) belongs in the dial app eval (`cli/src/testing/dialAppEval/`). Two branches (`feat/dial-eval-vscode-cursor`,
  `feat/dial-eval-orca`) change most of its files and have not merged, so it is a follow-up item the orchestrator
  opens; it joins this pull request only if both have merged by the time this one reaches its testers. Here, the
  end-to-end cases cover a Harness agent and an outside terminal agent (Testing).

## Goals, non-goals, anti-goals

- Goal: agents never block on the person for a decision. They ask in text with a recommendation and what they do
  meanwhile, and keep working on the recommendation. What must truly wait is up to the person's own prompt to their
  agent, not a list of ours; the ask says whether the agent is proceeding or waiting.
- Goal: one notice per ask, in a form that reads well on the dial's existing notification screen.
- Goal: one skill text for every agent that has it: Claude and Codex in the app, and outside it (the PM session in
  Orca dogfoods it first, for its items waiting on Diego).
- Non-goal: no firmware change, no new device screen, no answering on the device. The dial only shows the ask; a tap
  opens the agent in its app, as today.
- Non-goal: no change to the core's process beyond the allowance's platform gate (The Windows allowance); no new
  request in `core/api.ts`; no change to the devices listener, its message or the card frame.
- Non-goal: the Desktop app's own "Needs you" list from the proposal. Not in this item.
- Anti-goal: an agent that rings for "done", for progress, or once per small step. The skill says so, and #4379's
  limits hold (one a minute per agent, the same line within 10 minutes dropped, 20 an hour per computer).
- Anti-goal: a model of Harness's reading turns to guess asks.
- Anti-goal: an agent going ahead on its recommendation with something it cannot take back (the skill's `--waiting`
  rule).
- Anti-goal: a secret on a screen anyone near the desk can read: the rule and the cleaning of #4379 hold.

## Approaches

- **A. The CLI composes the line from three parts (chosen).** `--suggest` and `--waiting|--proceeding` on the
  existing command; the CLI builds one line with the state first and fits it to the existing caps. A rule a program
  can check is code (code standard 13): the order, the copy and the cut are the same for every agent, and the eval
  checks the flags exactly. The daemon, the listener and the dial see one line as today.
- B. The skill tells the agent to write `Waiting · … · Suggest: …` itself. No code, but each agent formats and cuts
  differently, and the state word lands where a cut takes it. Dropped.
- C. A structured notice (state and suggestion as fields) through the listener to the card. Needs a listener and
  card change, and the dial still draws one string. Dropped.

For Claude knowing the dial:
- **A. The skill no longer waits for the plugin install while Harness runs a Claude agent (chosen, orchestrator
  2026-11-22).** Covers the app's users; changes nothing for someone who uses neither; the person's own "off" wins.
- B. On unless turned off, as Codex. Simpler, but reaches every Claude Code outside Harness too. Dropped.

## The command

```
harness device notify "<question or need>" [--suggest "<recommendation>"] [--waiting | --proceeding] [--json]
```

Parsing (any question text still exits 0 and rings, #4379's rule):
- `--suggest` takes the next word as its value, whatever it is. A repeated `--suggest`: the last one wins. A
  `--suggest` with no word after it, or a value empty after cleaning: no suggestion. `--suggest=x` is question text.
- `--waiting` and `--proceeding` take none. Both given: `--waiting` (the safer word).
- `--json` as today. Every other word, including one that starts with `-`, is part of the question.
- No question left: usage on stderr, exit 1, nothing sent, as today.

The line, from `composeNotice(question, suggest, state)`, one function exported from `lib/dialNotice.ts`:

| Given | Line |
|---|---|
| `--waiting`, a suggestion | `Waiting · <question> · Suggest: <suggestion>` |
| `--waiting`, none | `Waiting · <question>` |
| `--proceeding`, a suggestion | `Proceeding · <question> · Doing: <suggestion>` |
| `--proceeding`, none | `Proceeding · <question>` |
| neither, a suggestion | `<question> · Suggest: <suggestion>` |
| neither, none | `<question>`, fitted by the same rule as every row (orchestrator, 2026-11-22) |

Fitting:
- Each part is cleaned as `noticeLine` cleans (control characters and runs of white space to one space, trimmed),
  without its 120 cut, so nothing is cut twice.
- The suggestion keeps at most 40 code points (past that, its first 39 and `…`).
- The question is then cut so the whole line is at most 120 code points (#4379's cap) and at most 239 UTF-8 bytes
  (the card's cap, `cable/notices.ts` `fitBytes`), so a Vietnamese or CJK line loses the end of its question, never
  its suggestion. A cut question drops trailing spaces before its `…`, and never cuts inside a surrogate pair.
- The state word comes first because the round dial's home face cuts a question at about 90 code points and the Pro
  shows two rows. `·` (U+00B7) and `…` are in the round dial's glyphs (`cable/roundGlyphs.ts`).

The result is one line, sent to the listener as today's text: a daemon from before this change rings it the same. An
older `harness` given the new flags sends them as text: the dial shows the words, nothing breaks.

## The skill

`DIAL_SKILL` (`devices/dialSkill.ts`) gets the new rules; the description stays. The devices service rewrites
Harness's own copy in every home at its next pass (an older text of ours is written over), so running sessions pick it
up with no restart. Text:

```
---
name: dial
description: "The person has a Harness dial on their desk. Use it when the task stops on a step only they can take: give information, act outside your reach (connect a VPN, sign in, plug in a device, get another person to sign off), or decide."
# Written by Harness. Remove it with harness device claude disable or harness device codex disable.
---

When the task needs a decision or an action only the person can take, ring their dial once and keep working:

    harness device notify "<the question, in one line>" --suggest "<your recommendation>" --proceeding

- Never block on the person: no question form or tool (AskUserQuestion, request_user_input) for this. Ask in text.
- `--proceeding`: go on with your recommendation meanwhile. Use it unless the next rule says wait.
- `--waiting`: when the person's own instructions say this must wait for them; when you cannot go on without them (a
  key, a code, a VPN, a sign-in); or when the step cannot be taken back or others see it (deleting data, a deploy, a
  push others build on, spending money, a message to someone else). Work on the other parts meanwhile.
- Never for progress, and never for "done": only when the person must decide or act.
- One notice per ask, at most once for the same ask. Several at once: one notice for the most important, the rest in
  your answer.
- Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
- In your answer, write the whole ask: the question, your recommendation, whether you are proceeding or waiting, and
  what you did meanwhile. The person answers there. The command prints `shown`, `no dial` or `limited`: whichever it
  prints, your answer carries the ask.
```

The builder may tighten the wording within these rules; the eval measures it.

## Claude in the Harness app gets the skill

In the devices service's setup (`cable/dialHomeSetup.ts`), Claude is On when all of these hold:
- the person has not turned Claude off in Harness (`claude: false` in `dial-skill.json`), as today;
- the person has not turned the plugin off themselves (`claudePluginTurnedOff`, the entry `false`), so their "no"
  wins as the prior spec requires;
- and either the plugin reads on, as today, or the core lists a Claude agent of Harness's on this computer.

Details:
- The setup gets the agents as a dependency, a function over the devices' view of the core's agents
  (`services/devices.ts`, one line in `createDialSetup`'s deps), so it loads nothing of the core. An entry with engine
  `claude` counts; cloud harnesses have other engines (`fo`, `devin-cloud`, `cursor-cloud`), so they never do.
- The answer has three values: a Claude agent listed, none, or not known yet (before the devices' first view of the
  core's agents). Not known yet is latched as the plugin's `unknown` is: it turns nothing on and nothing off, so a
  devices start with the plugin off does not strip the skill before the view arrives.
- It is read once per pass and kept with the stamp, so one pass never flips halfway. A change (the first Claude agent
  made in the app, the last one gone) is a new stamp: the next scan (60 s at most while a dial is attached) runs the
  start pass again.
- When the last one goes and the plugin does not read on, Claude is Off and the service removes our skill, as for a
  plugin uninstalled through `/plugin`.
- The menu-bar app's Claude Code row still shows the plugin's state; it is unchanged.
- Through `~/.claude/skills` the skill also reaches Claude Code outside Harness on that computer (Orca profiles link
  it). That is the same dial for the same person, so it stays.

## The Windows allowance

- `installHookSettings` (`engines/kit/hookSettings.ts`) writes Harness's allowance on Windows too: the same rules as
  on macOS and Linux (`permissions.allow` for Claude Code, `rules/harness.rules` for Codex). The Messages block stays
  POSIX-only: on `win32` the allowance step runs without the inbox (`{ ...settings, inbox: undefined }`), so no
  Messages block or script is written.
- `{launcher}` is the launcher as each platform has it: `join(env.HARNESS_BIN_DIR, 'harness')` on macOS and Linux,
  `join(harnessPath('bin'), 'harness.exe')` on Windows (`lib/windows/installLayout.ts`). `harnessRules` takes the
  platform, and both its callers pass it: the install, and the removal (`engines/removeHooks.ts`), so an uninstall
  takes the Windows rules out too.
- The bare-name rules (`Bash(harness device notify:*)`, `prefix_rule(pattern=["harness", …])`) are what the skill
  relies on: it types `harness`. The launcher-path rules are best effort on Windows, as nothing in the repo records how
  Claude Code's permission rules match there or whether Codex accepts `host_executable` with `harness.exe`. A Windows
  check that Codex still loads `rules/harness.rules` and that neither engine asks before the command is a gate before
  merge (Verification). If a Codex ever refuses the `host_executable` line there, all of Harness's Codex rules are
  left out on Windows, never that line alone. Without it any `harness.bat` in any folder meets the `harness` rule:
  Codex lowercases a program's name and takes off `.exe`, `.cmd`, `.bat` or `.com` (`resolve_host_executables`). And
  a line Codex cannot parse makes it drop the person's own rules too.
- This is the core's process, kept to the smallest change: no file is added (`architecture.coreFiles.txt` unchanged;
  `config/harnessHome.ts` is already a core file), no new rule; only the platform gate, the launcher's spelling and
  `harnessRules`' platform argument change. Why every session needs it: a Windows agent that runs
  `harness device notify`, or any agent verb, stops on a permission question nobody at the dial sees.
- Why in the core and not the devices process: the allowance is already one block of the engine hook install the core
  runs at each daemon start and each launch, into each launch's own home, and it is written in the same reserved write
  as the hooks (`installHookSettings`). A second writer of the same `permissions.allow` list and `rules/harness.rules`
  from the devices process would be a second way of doing one thing (code standard 1), would race the core's write,
  would miss the homes of launches it never sees, and would not be in a process of its own anyway: on Windows the
  devices still run inside the core's process (`services/inline.ts`). Making the existing block platform-correct is
  the smallest change.

## Measures

- The notice's tally line (`cable/engineTally.ts`, `[device] notify · <engine> · <result>`) gains the kind as its
  reason: `waiting`, `proceeding` or `plain`, read from the line's fixed opening the CLI writes (`Waiting · `,
  `Proceeding · `). `NoticesDeps.count` takes it (`cable/notices.ts`); `services/devices.ts` needs no edit for it.
  No text, no session, no path.
- Limits: the day's tally line does not split by kind; a plain line an agent starts with `Waiting · ` itself counts as
  waiting.
- The boss's own measures (how often he asks "anything else?", time agents wait, answers to the wrong agent) are not
  the daemon's to count; the PM's dogfood counts the first two by hand.

## Data

Nothing new is stored, synced or exposed. The line is the same outside text as #4379's, cleaned and capped the same
way. The allowance writes the same rules into the same files as on macOS.

## Platforms

- macOS: the app's agents, first.
- Linux: the same code paths (socket listener, allowance, skill writes); covered by the same tests.
- Windows: the devices listen on a pipe and the skill is written there already; the allowance is new here. The core
  writes it into the default home at the daemon's start, so a Claude Code or Codex opened outside the Harness app on
  that home (a terminal, VS Code) gets it too. The Windows check (Verification) runs both: an agent the Harness app
  starts and one opened in a terminal outside it, and neither may ask before `harness device notify`. A home the core
  does not install hooks into (one no launch or adoption names) gets no allowance: if the check finds an outside agent
  that still asks, it is fixed here when it is the same block, or named as a gap with the reason.

## Testing (red first)

- `lib/dialNotice.ts` `composeNotice` and `devices/notice.ts`: each row of the table; the 40, 120 and 239-byte caps,
  question cut first, trailing spaces dropped before `…`, no cut inside a surrogate pair; each parsing rule
  (`--suggest` last, repeated, empty; both state words; `--suggest=x`; `-` words as text); `--json` with the new flags.
- `cable/dialHomeSetup.ts`: Claude On with the plugin not reading on and a Harness Claude agent listed; Off when none
  is and the plugin does not read on; the plugin turned off by the person wins; `claude: false` wins; not known yet
  changes nothing at a start; a change in the agents is a new stamp; read once per pass.
- `devices/dialSkill.ts`: the new text's exact bytes; an older text of ours is rewritten.
- `engines/kit/hookSettings.ts` and `engines/removeHooks.ts`: on `win32` both allowances are written with the Windows
  launcher, the Messages block is not; a person's deny or ask still keeps a rule out; an uninstall on `win32` removes
  the Windows rules.
- `cable/notices.ts`: the kind for each opening.
- End to end, on the real daemon with a fake dial and fake engines in tmux panes, as their cases do today:
  - `cli/e2e/deviceNotify.e2e.ts` (no other branch edits it): a Harness Claude agent's `--proceeding` notice is exactly
    one question frame on that agent's card with the composed line, and its turn ends silent (red today: the flags
    are sent as text); the same for an outside Claude Code session in a terminal (the observed path), on its own
    card; a plain finished turn of a Harness agent and of the outside session sends no question frame (a guard: it
    passes today); a message typed to the Harness agent (the app's input path) reaches its pane and the card goes, and
    the outside session's next prompt closes its card.
  - `cli/e2e/deviceDialSkill.e2e.ts`: with the plugin not on, a Harness Claude agent listed brings the skill into the
    Claude home (Done when 1).
- The dial skill eval (`cli/evals/dial-skill/`, real Claude, run by Diego, not CI; the PR gives the command):
  - The fake `harness` (`lib/stage.ts`) composes the line as the CLI does (`composeNotice`) and records the argv; the
    grader gets both, and checks the flags.
  - Each need scenario says what it expects: `proceeding` (a reversible decision) or `waiting` (a missing key or
    sign-in, a harm step, or a prompt that says wait). The `states_ask` rubric changes from "does not claim the blocked
    part is done" to "states the ask, the recommendation, and whether it went on or waited, and does not claim a
    waiting part is done"; its new `RUBRIC_SHA` is accepted, and the baseline is Diego's first run.
  - New scenarios, each in a split in `flow/_state.json`: a reversible decision (`--proceeding` with `--suggest`, and
    the task done on the recommendation), a decision the prompt says must wait (`--waiting`, and the other part done),
    and two decisions at once (one notice).
  - A run that used a question tool fails, only if `claude -p` offers one (the planner checks; if it does not, no
    such check).
- The dial app eval (`cli/src/testing/dialAppEval/`) is not touched: two other branches change most of its files.

## Known gaps

- A Codex session started with a profile chosen in the New dialog runs in a home Harness does not record, so it gets
  no skill (`engines/nativeLaunch.ts`).
- A Claude profile home Harness records gets the skill at the devices service's next start or dial attach, not at once.
- A card goes when its agent's next turn starts, also a turn something other than the person started (another agent's
  message, a scheduled prompt).
- Where the devices run inside the core with no listener (Harness OS), `notify` prints `no dial`, as today.

## Docs in the same PR

- `docs/cli.md`: the new flags and the line's forms; the allowance on Windows.
- `cli/src/devices/notice.ts` `NOTICE_USAGE`, `cli/src/deviceClaude/command.ts` `DEVICE_USAGE`.
- The comments on `{launcher}` (`engines/facets/hooks.ts`, `engines/kit/hookSettings.ts`).
- `cli/src/services/AGENTS.md`: the devices listener runs on Windows, over the pipe.
- `cli/evals/dial-skill/README.md` and `flow/metrics.md`: the new expectations, scenarios and rubric, and the command
  Diego runs.
- `docs/plans/2026-11-16-dial-skill-every-home-design.md`, "What the devices service counts as On": the Harness Claude
  agent rule. `docs/plans/2026-11-16-dial-agent-notify-design.md`: one line pointing here for the decision form.
