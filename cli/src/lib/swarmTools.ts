/** The mechanics of the Swarm commands every agent uses, with no workflow and no role names: what to do, and who does it, is
 *  the project's instructions (swarmInstructionsSkill.ts). Built in, so it needs no backend read, and written at launch
 *  beside today's role file. Every command and flag here is checked against superTabs/command.ts and service.ts HELP. */
import { CHEAP_FIRST_HELP, ROUTE_KIND_HELP } from '../superTabs/routeCheapFirst.js'

export const SWARM_TOOLS_SKILL = `---
name: swarm-tools
description: Use whenever you work in a Harness Swarm project and need the mechanics of harness super-tab: reading status and messages, posting, reacting, commands, starting agents, routing, instructions, decisions, costs and terminals.
---
# Harness tools

How to use \`harness super-tab\`. It says nothing about who does what or in which order: your project's instructions say that (run \`instructions\` below). Run \`harness super-tab help --tab TAB\` for the full, current list. The Swarm refuses only what cannot happen or what you may not reach (another project, a machine that is offline, a setting that is not yours), and a refusal says why.

Every command starts \`harness super-tab --tab TAB\` (your tab id is in your launch line). Every command that changes something takes an OPERATION_ID: a new unique id of letters, digits, - or _. Reuse the same id and the same JSON only to repeat an interrupted request.

## Read
- \`status [--archived [PAGE]]\`: the shared roster and work: people, projects, agents (id, name, machine, state), conversations, tasks. Agent ids for \`--to\` come from here.
- \`messages GROUP [--before SEQUENCE MESSAGE_ID]\`: recent messages of a conversation, thread replies included; each names the thread (the root message) it answers in. \`--before\` pages back from the cursor the last page named.
- \`message GROUP MESSAGE_ID\`: one exact message, such as an earlier question or result a reply refers to.
- \`instructions [PROJECT]\`: your project's instructions and the coordinator's notes, printed whole. Read them when you start and when told they changed. Without PROJECT, the project you work in. INSTRUCTIONS_UNAVAILABLE saying the Swarm has no project instructions yet is an older Swarm: work by the swarm skill Harness gave you at start (your role file) then. The same code saying to try again is a passing failure: run \`instructions\` again in a moment.
- \`decisions [--answered]\`: decisions asked of people, still open, or with \`--answered\` those answered, each with its choice and note.
- \`costs [--days N]\`: what attempts routed in the last N days (7 unless set, at most 90) cost and how they went, per engine, model, effort and kind of job.
- \`screen AGENT [--scrollback N]\`: another agent's terminal in your project as plain text, up to 200 lines of scrollback.
- \`type AGENT [TEXT] [--key K]...\`: type text, then keys (Enter, Esc, Tab, Up, Down, Left, Right, Ctrl-C, 0-9), into another agent's terminal in your project. Answer prompts within its task; ask the owner before approving anything risky. Codex's "Update available" screen is dismissed with Esc alone, never a number and Enter.

## Post
\`post GROUP TEXT OPERATION_ID [--to AGENT]... [--reply-to MESSAGE_ID] [--attach PATH]... [--mention PERSON]...\`
- Answer a message once, inside its thread: \`--reply-to MESSAGE_ID\` puts your reply in that message's thread. Post at the top level only to start a new topic.
- \`--attach PATH\` sends a file (a screenshot, a log; up to 10 files of 10 MB each); TEXT may then be empty.
- \`--mention PERSON\` tags a person by the id or email shown in status (up to 5), when you need them to act or decide; an @username or @email in TEXT tags too, outside code and links. Nobody is tagged in the Leads conversation, nor a person who cannot read the conversation.
- Quote TEXT so the shell keeps it one argument.

### Who a post reaches
- \`--to AGENT\` names the agents it reaches: any agent of this project, by id from status, up to 16. Named agents are told and join the conversation if they are not in it. A post reaches exactly the agents you name, no others.
- With no \`--to\`, an agent's post reaches the project's coordinator; the coordinator's post in a task reaches the task's assigned agent. Name the agent whenever you answer one.
- Nothing is dropped: a post that names no one still goes to its default addressee.
- A post stays inside your project. Private chats and Buddy chats keep their own members.

## Reactions
- \`react GROUP MESSAGE_ID EMOJI OPERATION_ID [--off]\` acknowledges without a post, as Slack bots do. EMOJI: eyes (👀) when you start on a message addressed to you, check (✅) when you have done what it asked, rocket (🚀) when its work merged; also thumbs_up, tada, heart, laugh. \`--off\` takes yours back (take the 👀 back, then react ✅).
- A reaction tells the people in the chat and wakes nobody; your work status still tells the Swarm.
- Post only substance: a plan, a question, a ruling, a finding, a verdict, a handoff, a blocker or a result with its evidence. Never post an acknowledgement alone ("on it", "took it", "thanks", "done").

## Commands (JSON)
\`command OPERATION_ID JSON\` sends one command. The JSON is one argument; when it holds quotes, put - in its place and send it on stdin:
\`\`\`
harness super-tab --tab TAB command OPERATION_ID - <<'JSON'
{"type":"work.status","conversationId":"GROUP","assignmentId":"current","status":"working","result":null}
JSON
\`\`\`
Put OPERATION_ID before the JSON, on the same command line. A refusal says what to fix; change something before you resend.

Task and group commands:
- \`{"type":"conversation.create","title":"Outcome","task":{"goal":"...","changes":"...","constraints":"...","owns":["paths or code areas"]},"checks":[{"description":"observable acceptance evidence","independent":false}]}\` opens a group. Optional: \`"reviewOf":"GROUP"\` (a group that reviews another), \`"requesterId":"PERSON"\` (who asked; records only that they asked), \`"requires":{"machines":["MACHINE"],"devices":["/dev/..."]}\` inside \`task\` (the route notes it; a start asks its machine to check the devices). Task sections take up to 8,000 characters; \`owns\` up to 40 paths; checks may be empty. A task is taken as written: one with every part (goal, changes, constraints, owns) goes as the task; one without them all goes as a brief of the parts you gave.
- \`{"type":"work.define","conversationId":"GROUP","task":{...},"checks":[...]}\` sets or replaces the task of a group already open (same shape).
- \`{"type":"conversation.agent","conversationId":"GROUP","agentId":"AGENT","present":true,"lead":false}\` adds an agent to a group (\`present\` false removes it).
- \`{"type":"conversation.requester","conversationId":"GROUP","personId":"PERSON"}\` names who asked for a group already open (null clears).
- \`{"type":"work.assign","conversationId":"GROUP","agentId":"AGENT","routeDecisionId":"DECISION"}\` assigns a group's task. \`routeDecisionId\` names the route's decision when you assign one of its candidates, so it records what ran.
- \`{"type":"work.status","conversationId":"GROUP","assignmentId":"current","status":"working","result":null}\` is your status for the Swarm. status: \`working\` (add a one-line note in result of what is done and next), \`review\` (ready for review: result holds the revision and the pull request link; send it once per new head), \`done\` (result: exact revision, evidence, deliverable links), \`blocked\` (result: why, and what would unblock you), \`needs_human\` (result: one short question), \`stopped\`. Set working again once it moves. A work.status \`done\` or \`stopped\` carries the session's token totals by itself.
- \`needs_human\` may carry \`"ask":{"personId":"PERSON","options":["A","B"],"recommended":0,"unblocks":"what the answer unblocks"}\`: 2 to 5 options, opened as a decision for that person. Keep working on your recommendation, marked provisional, until a notice says it was answered; then read the answer with \`decisions --answered\`. The notice carries none of it.
- \`{"type":"work.check","conversationId":"GROUP","assignmentId":"current","checkId":"CHECK","passed":true,"evidence":"exact command, revision and observed result"}\` records one acceptance check.
- \`{"type":"work.cancel","conversationId":"GROUP","assignmentId":"current","reason":"one short sentence"}\` cancels a task.
- \`{"type":"agent.release","agentId":"AGENT","decision":"keep|stop"}\` records keep or requests stop of an agent whose work is finished; wait for its machine to confirm a stop.
- \`{"type":"conversation.merged","conversationId":"GROUP","pullRequestUrl":"https://github.com/OWNER/REPOSITORY/pull/NUMBER","mergedAt":"optional ISO time"}\` records that a group's pull request merged; the requester's request counts as shipped from that record.
- \`{"type":"decision.ask","conversationId":"GROUP","personId":"PERSON","questions":[{"question":"...","options":["A","B"],"recommended":0,"unblocks":"..."}]}\` puts up to 10 questions to one person at once, each with 2 to 5 options.
- \`{"type":"person.tell","personId":"PERSON","text":"..."}\` lands in that person's Buddy chat, which you cannot read. It is not private: members watching your terminal see what you send.
- \`{"type":"project.report","projectId":"PROJECT","through":{"GROUP":214031},"text":"..."}\` answers a scheduled project update request through the revisions it names; text null when nothing changed. An unanswered request blocks the later ones and keeps finished groups from archiving.
- \`{"type":"project.digest","projectId":"PROJECT","time":"08:00","timeZone":"Asia/Ho_Chi_Minh"}\` sets the morning digest at a person's local time (time null turns it off).

Swarm and machine settings (each refused unless you may change that setting; a person's words come with \`"askedIn":{"conversationId":"GROUP","messageId":"MESSAGE"}\` naming the message that asked). How the project routes work, and any rule its owner gives, goes in its instructions (below):
- \`{"type":"tab.tidy","enabled":false,"askedIn":{...}}\`: the Swarm's tidying (finished groups archive once their pull requests are merged or closed).
- \`{"type":"machine.engineResume","machineId":"MACHINE","engine":"codex","askedIn":{...}}\` offers an engine again on a machine after two failed starts in a row suspended it (up to 6 hours).

### The project's instructions and notes
- Save: \`{"type":"instructions.save","projectId":"PROJECT","baseRevision":N,"text":"the whole new document","summary":"one line, up to 200 characters","askedBy":"PERSON"}\`. \`baseRevision\` is the revision you read with \`instructions\`. \`text\` is the whole document, not a patch. A person who reads the project saves it; of the agents, only the project's coordinator does, and always with \`askedBy\` naming the member whose words the change carries. Any other agent asks the coordinator or a person. A save of unchanged text changes nothing.
- A stale base is refused with INSTRUCTIONS_STALE, which names the current revision: read \`instructions\` again, merge your change into that text and save on the new revision. Never overwrite another writer's text.
- A save posts one line in the project's chat, with your summary. Do not post another about it.
- Add a note: \`{"type":"note.add","projectId":"PROJECT","text":"up to 300 characters","askedBy":"PERSON","expiresAt":"optional ISO time"}\`. Only the project's coordinator adds one; anyone else tells the coordinator what to note. A note is a small thing a member told the coordinator, kept beside the instructions until it ends. A project keeps at most 100; remove one (or write what lasts into the instructions) when it is full.
- Remove a note: \`{"type":"note.remove","projectId":"PROJECT","noteId":"NOTE"}\` (each note's id is in the \`instructions\` output): the coordinator, or a person who reads the project. An expired note is already gone.

## Route and start
- \`route GROUP JSON\` ranks who could do a group's work, before you start an agent or assign it. Work you do yourself is not routed. JSON: \`{"difficulty":"low|medium|high","risk":"low|medium|high","size":"small|medium|large","why":"one sentence","kind":"${ROUTE_KIND_HELP}","local":true,"model":"optional","needs":{"tools":[],"devices":[],"cwd":"/absolute/repo"}}\`.
  - size is how long the work runs: small about 20 minutes, medium about an hour, large about three hours.
  - \`local\` only when a person asked for a local model. When a person names a model, set \`model\` to their words ("deepseek 4.1 flash"): the route then offers that model alone, unrated when the catalog does not list it.
  - It leaves out what cannot run (a machine offline, paused or full, an engine signed out or suspended, tools or devices the work needs, a machine that cannot take a teammate's project), and says why.
  - ${CHEAP_FIRST_HELP}
  - It ranks the rest by strength, then price and quota fit, then an idle agent before a new one. What else it knows is a note on the candidate: a used-up quota, a lost task, a machine whose last starts failed, a task requirement naming another machine, a model not offered by default. Your instructions say how to choose; where they say nothing, choose by strength, quota and price.
  - A pick on a model served on the Swarm's grid starts with the \`gridModel\` and \`gridName\` the route gives, in place of model and effort.
- Start or assign any candidate with the decision's \`routeDecisionId\`; a reason for choosing another (\`overrideReason\`) is optional.
- \`plan [JSON]\` places all open groups at once on machines and models (needs Python 3 and OR-Tools; without them it says how to install). JSON optional: \`{"groups":{"GROUP":{"difficulty":"...","risk":"...","size":"...","kind":"optional","after":["GROUP"]}}}\`. It records nothing: route each group, then start the plan's pick with the route's \`routeDecisionId\`.
- \`capacity MACHINE_ID JSON\` inspects a machine's, engine's and quota headroom (JSON: the start fields). Unknown allowances are not reported as free tokens.
- \`start OPERATION_ID JSON\` creates one agent in a conversation on a machine in the Swarm's Machines list; it does not assign work. JSON:
  \`{"conversationId":"GROUP","machineId":"MACHINE","engine":"codex","name":"AGENT NAME","cwd":"/absolute/repo/on/that/machine","worktree":true,"branchRef":"refs/remotes/origin/BASE_BRANCH","model":"opus","effort":"high","routeDecisionId":"DECISION","roleName":"optional"}\`
  - \`worktree: true\` starts from the repository's default branch, fetched first; \`branchRef\` (refs/heads/BRANCH, or refs/remotes/origin/BRANCH to fetch it first) starts from another branch, such as the one the work builds on.
  - \`roleName\` is optional: the role the agent starts in, free text taken from the project's instructions, up to 40 characters. An older Swarm refuses the key: start again without it.
  - Start only on the Swarm's listed machines; to use another, a person adds it first. \`resume START_ID\` finishes a pending start without creating another agent; repeat \`start\` with the same id after an interruption. Two failed starts in a row suspend the engine on that machine; the route says so.
  - A start that fails is reported (\`START_FAILED\`, with why) and moved nowhere: you decide what next, and the project's coordinator is told too.
  - Starts can be refused when too many starts are pending.
- A review group is a group created with \`reviewOf\` naming the group it reviews. A \`review\` status tells only the reviewed group's coordinator: when the work is ready for review, name the reviewing agent with \`--to\` in your post.

## Requests, tasks and cards
- A group opened for a person's request, asked in the chat or proposed by their Buddy, names them as requester (\`requesterId\`, or \`conversation.requester\` later). It records only that they asked, never what they wrote.
- A merged pull request is recorded with \`conversation.merged\`; the group is Done only after that.
- Each task and each pull request linked in a chat is one card there that updates itself: status, checks passed, CI, review verdict and merge. Post a pull request's link once, in the main chat, and never a line that only repeats what a card shows (opened, CI running or green, reviewed, merged).
- A lost or stalled task is handed on with its pushed branch and last progress note, not restarted from the old goal.
- A task lost to a usage limit resumes by itself in the same session when the limit resets (its wake-up says when).
- After a restart, read the recovery notice and the last recorded checkpoint, then check the agent's actual session and saved work. Never replay old input or commands: they may already have taken effect.

## Threads
Many people talk at once; answers in the main chat bury each other. Answer a message in its thread with \`--reply-to\`; summarize a long thread once and record an important decision once.

## Shared machines and secrets
- Stop only processes and databases you started yourself, by the process id you recorded when you started them. Never stop anything by name or pattern (pkill -f, killall): on a shared machine that kills other agents' work.
- Never print or paste a secret into chat, logs, pull requests or commits. Secrets reach you only through a private file or an environment variable, loaded in the same command that uses them.
- Never remove a worktree that a live process still uses. A fresh worktree on the default branch may belong to an agent that is just starting.
- Install nothing system-wide on a shared machine; put the tools you need in your session folder.
- A machine's own account and its Team account are different: the Team account has none of the owner's tools, devices or sign-ins.
- Print little to save quota. Keep progress and blockers in the chat.
`
