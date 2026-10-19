# Super Tab MVP interaction spec

18 October 2026, review revision 09. Implementation authorized 18 October 2026. This replaces earlier UI proposals in this research folder and incorporates the subsequent corrections: a new tab type, no migration flow, and Invite in the sidebar footer.

**A Super Tab is a Harness tab where people work with a lead and member agents. Open it, talk to the lead, and watch delegated work become shared group conversations.** All conversations appear in one flat sidebar. Questions, decisions and results stay with the conversation that produced them.

## Create it with a hidden shortcut, reusing the Cmd+T page

**ST-008 — Creation.** For this initial iteration, **Cmd+Option+Shift+T** opens a new Super Tab creation page. This is a hidden shortcut: no visible entry in the tab bar, ordinary creation page, menus, command search or shortcut help. It reuses the existing Cmd+T page, its composer, recent harnesses, controls and controller, with its primary action set to New Super Tab. Ordinary Cmd+T keeps its current page and New Harness action. Cmd+Shift+T remains New Terminal, and Cmd+Option+T retains its existing daemon action. The proposed Super Tab chord is unused in the repository's current default bindings; register it through the existing keymap rather than a separate raw key handler, and respect explicit user remaps.

Choose the agent engine, computer and repository, enter the initial request, and adjust the existing model/provider, approval, account, attachment, worktree and branch settings as needed. Remembered settings prefill the form and remain editable. A person can choose Claude Code for one lead and Codex for another.

The primary action for this flow is **New Super Tab**. Submission creates the configured agent as the lead in that tab and opens its conversation. Opening the form starts nothing. An empty prompt is allowed, as in the current composer. The project supplies the initial tab name; the tab's existing rename action remains available.

The recent-harness list keeps its existing open behavior. Existing work is brought into a Super Tab deliberately, through Add agent. Opening a recent harness does not silently publish its history or restart it as a lead.

A failed start stays with the composer and preserves the chosen settings. A pending or uncertain start reuses its receipt, so retry cannot create another lead. Only the requested lead starts at creation.

## The workspace

The Super Tab initially contains the Lead conversation. This illustration shows the same workspace after the lead has begun delegating. Names and activity are illustrative.

```text
+---------------------------------------------------------------------------+
| [Pilot] [Website] [New Tab]                 [+] [Search] [Account]        |
+---------------------------------------------------------------------------+
|                      | Offline editing                              [...] |
|                      | [3 agents · 20 people]                             |
+----------------------+----------------------------------------------------+
| Lead                 | Lead                                               |
| > Offline editing    | Storage is done. Reconnect is ready to test.       |
| Onboarding           |                                                    |
|                      | Reconnect                                          |
|                      | Can someone check reconnecting on the test device? |
|                      | [Firmware + device test steps, revision abc123]    |
|                      |                                                    |
|                      | Maya                                               |
|                      | I'll try it now.                                   |
|                      |                                                    |
|                      | Lead                                               |
|                      | Thanks. The device check is the remaining step.    |
|                      |                                                    |
|                      +----------------------------------------------------+
| [New group] [Invite] | Message...                                [Send]   |
+----------------------+----------------------------------------------------+
```

The top row is the existing **global app bar**, which already displays the Super Tab's name. Do not repeat that name above the sidebar. **New group and Invite belong together in the sidebar footer, inside the Super Tab.** The adjacent **conversation header belongs to the selected conversation**: its title, a compact participant count and its menu. Results appear in messages.

The participant count shows the agents assigned to this conversation and the people with access to the Super Tab. All of those people can read every conversation; there is no second invitation or group-access list. Twenty people still take one count in the header. Selecting the count opens a searchable, scrollable list with names and roles. Agent rows identify the engine and machine and offer **Open terminal**. **Add agent** appears with the agents in this list. Human membership is managed through the tab's Invite/People control.

The sketch describes placement. Implementation uses the existing Harness typography, colors, controls and native terminal styling.

**ST-001 — Flat navigation.** The sidebar has no heading or sections for leads, people or tasks. It starts with one **Lead** conversation; work groups appear at the same level. The name and an ordinary unread indicator are enough. The lead conversation appears first because it is the first conversation. New groups appear without changing the person's selection, scroll position or draft. Agent chatter does not continually reorder the list. Navigation is personal; another collaborator opening a conversation does not move anyone else's screen.

**ST-002 — Conversations and agents.** Selecting a row opens that conversation in the same main area. A lead is an agent role; a task is the work discussed in a group. The Lead conversation is for planning and coordination; work groups contain the agents responsible for their outcome. All are shared with the Super Tab's collaborators. This MVP does not add separate conversations for individual workers. Adding ten agents creates no extra sidebar conversations. Address a particular worker with an @mention in its work group; inspect its session through Open terminal.

**ST-003 — The local controls.** The sidebar's **New group** action creates a named conversation with the lead and focuses its message composer for the brief. **Add agent** in a conversation's participant list adds an agent to that conversation. These are separate actions, each with one purpose. Add agent reuses the existing running-harness picker, including agents already shared with the tab, with New Harness available from that picker. Cmd+N opens the existing new-harness composer to create a member in the current Super Tab and selected conversation. Its destination is captured when opened and retained during a pending launch.

The existing tab context menu contains Rename and Pause new work. A conversation's menu contains Work details, Rename and Archive. Completed groups remain readable and can be archived; active assignments must be resolved before archiving. Conversation search reuses the app's search surface, includes archived groups, and identifies the Super Tab in each result.

## Discuss, build and intervene

**ST-009 — Plan with the lead.** The initial request appears as the person's first message to the chosen lead. Brainstorm, research and agree on the approach in that conversation. Saying build authorizes delegation within the agreed scope and existing execution permissions. A new tab starts with the Lead + members playbook; there is no template-selection step in this MVP.

**ST-010 — Delegate into work groups.** Reuse an existing group when it already owns the outcome. Create a new group when the agreed work can be handed to an independent harness with a named responsible agent and an acceptance check of its own. The lead posts that brief and check as the first message, names the group for the outcome, and adds the agents doing the work. For example, "Offline editing survives a reconnect" and "New users can complete onboarding" can progress independently. Writing a reconnect test belongs in Offline editing. A tool call, helper subagent or agent start does not create a group by itself. These are delegation rules for the lead, not a word-count or estimated-duration threshold.

The lead reports new groups in the Lead conversation. Engine-native subagents remain available inside each harness. Work that fits in one harness can stay there. The reason to use a Super Tab is shared coordination across independent sessions, engines, machines and people: for example, one person's Codex harness works alongside another person's Claude Code harness, and either person can answer the device-check question in the work group. A group is justified by that shared work, not by an assumption that every task benefits from more agents.

More leads can be added later using ordinary agent creation and the existing role action; that role change does not create another sidebar conversation. Each work group has one coordinating lead, and each active assignment has one recorded owner. This keeps several leads from dispatching the same work. A group carries durable work state, assignments, PRs and checks even though its primary presentation is a conversation.

**ST-004 — Message routing.** In the Lead conversation, the tab's coordinating lead handles an unaddressed human request. In a work group, its coordinating lead handles it. An explicit mention directs a message to the named agent in that conversation; a reply to an agent's question reaches that agent and the assignment waiting for its answer. Assigned agents receive relevant decisions, answers and work updates. Posting a message does not wake every agent in the tab. Instructions that affect a member's current assignment are recorded with that work and made available to its coordinating lead.

The shared conversation shows human messages, agent explanations, decisions, questions, useful progress and results. Detailed tool output and terminal traffic stay in the native harness. The author is always identified. New human-relevant messages use ordinary unread indicators; routine agent coordination does not generate a stream of notifications. People choose the existing notification preferences.

**ST-007 — Human help stays in the conversation.** An agent asks where the work is happening: in the lead conversation or the relevant group. Include enough context to answer, a recommendation when useful, and a result to try when applicable. Any collaborator can reply there. The answer reaches the waiting agents and remains attached to the work. A dependency can wait while unrelated work continues. There is no global human-request list, bottom strip or separate human-approval room.

**ST-006 — Native terminals.** Choose Open terminal on an agent's row in the participant list. Its existing native terminal opens **to the right of the conversation, inside this Super Tab's content area**. The sidebar stays in place, and the conversation keeps its own composer. The terminal header identifies the agent and machine and retains the existing engine controls and keyboard behavior. The shared conversation and terminal use the same running harness. Inputs are ordered, attributed and reflected in the shared record when they affect the work. Closing the terminal pane returns that space to the conversation and does not stop the harness.

Direct terminal prompts and their answers are recorded in the conversation from which the terminal was opened. The record identifies the observing agent and the authenticated person who opened the session; it does not claim that the machine owner authored the text. A visible interruption replaces content whose conversation cannot be established. Tool output, private history from before opening, and unknown input are not imported. A viewer can inspect the shared terminal but cannot type through it. Loss of recording authority closes this terminal view with an explanation while the harness continues running.

The conversation's lead is informed of recorded work from its member agents. The observed input is never replayed into the agent that already received it. Agents still post questions and results for ordinary delivered group instructions through the shared conversation command, as instructed when they receive that work.

```text
Same Super Tab, after Open terminal:
+----------------------+----------------------------+--------------------------+
|                      | Offline editing            | Reconnect · Lab Mac  [x] |
|                      | [3 agents · 20 people]     |                          |
| Lead                 | Shared messages            | Existing native terminal |
| > Offline editing    |                            |                          |
| Onboarding           |                            |                          |
|                      |                            |                          |
| [New group] [Invite] | Message...          [Send] | Native agent input       |
+----------------------+----------------------------+--------------------------+
```

There is one optional terminal pane, initially closed. Opening another agent's terminal replaces the one shown in that pane without stopping either agent. It belongs to the selected conversation. Switching conversations preserves each one's draft, scroll position and terminal selection. The illustration labels existing input areas; it does not add a second wrapper composer over the native terminal. On a narrow window, the terminal uses the main area with **Back to conversation**; the app does not squeeze both into unusable columns.

## People and contributions

**ST-013 — Invite and manage people inside the Super Tab.** Invite is in the sidebar footer, next to New group. It opens a compact panel showing current people, pending invitations and an email field. The list scrolls and supports name/email search as it grows; it does not expand the workspace header. The owner can invite, cancel a pending invitation, or choose Remove from a person's menu. Default invitations allow collaboration; the existing viewer option remains read-only. For collaborators who cannot manage membership, the same location offers People and their own Leave action.

```text
+-----------------------------------------+
| People in Pilot                         |
|                                         |
| You                         Owner       |
| Maya                        [...]       |
| Sam                         [...]       |
|                                         |
| Email address...              [Invite]  |
+-----------------------------------------+
```

Membership covers this entire Super Tab, including the Lead conversation and work groups. People can read and reply in any group without joining it separately. Invite makes the scope clear: collaborators can read these conversations and prompt the agents deliberately shared into this tab.

The invitation remembers the conversation it came from. After acceptance, the teammate lands there and can read the brief and recent decisions immediately; a lead can provide a short catch-up in that conversation. A person can contribute ideas, test a result or answer questions without adding a machine or an agent.

Removal ends subsequent access, posting and control through this tab's grant; prior messages retain attribution. Leaving or being removed withdraws agents contributed solely through that membership from this tab. Their processes are not silently killed. Active work is reconciled before reassignment. Independently granted team machine/model access is managed separately and is not widened by membership changes.

**ST-011 — Add or start agents.** A collaborator opens the selected conversation's participant list and chooses Add agent to select a running harness, or starts a member through the existing Cmd+N form. The picker shows the session's engine, machine and project so the correct one is shared. An existing tab agent is added to this conversation without restarting or sharing it again. Attaching an outside session preserves its context and working state and explicitly shows that access is shared with the entire Super Tab. Adding it to the Lead conversation makes it available for the lead to assign; adding it to a work group supplies that group's context without claiming an assignment already held by someone else. Additional leads are roles on these agents, not another workspace level.

The lead can reuse eligible agents or start workers on already authorized machines within the permitted capacity. Agent messaging is part of Super Tab coordination; opening this mode should not require discovering an unrelated experimental UI switch. Starting agents still respects the applicable execution and spawning grants. If capacity or permission is missing, the lead explains what is missing in the conversation and uses the existing setup controls to resolve it. Sharing a tab does not itself grant access to another person's machine or account.

**ST-014 — Contribute capacity once.** Machines and model connections use the existing machine, account and model management surfaces. Their owners explicitly choose the people or team allowed to use them and the supported limits. Those grants are reusable across eligible Super Tabs. Adding a running agent contributes its context and capability; it does not create additional machine or model allowance. Credentials remain on authorized execution hosts.

The contribution flow reuses **Machines → select a machine → Share**. A person names specific teammates or enables their team’s email domain. For a new computer, install Harness there and sign in with that person’s own account first; it appears in their Machines list. This grant is reusable across Super Tabs. Joining a Super Tab does not require contributing a machine. Sharing a whole machine grants broader access than contributing one selected running agent; the sharing surface must keep that distinction clear.

**Add agent targets the selected conversation.** In Lead, the agent becomes available for delegation. In a work group, it joins that group’s discussion. The same session can participate in other groups without restarting. Adding an agent does not itself assign work or create another conversation.

**ST-015 — Dispatch within capacity.** Match assignments to permissions, repository/tool availability, CPU, memory, disk, VM/device requirements and known account limits. Shared host and account limits apply across simultaneous work in all tabs. Missing or stale quota data is shown as unknown. Record the actual engine, model, effort, context and machine per attempt for later performance evaluation. Detailed resource information belongs in the existing resource/agent detail surfaces, not in every conversation row.

Autonomous starts reserve their declared memory and disk budgets on the execution host before native dispatch. All Super Tabs on that host share the reservation ledger. Interrupted or pending starts keep the same reservation until a native cancellation, failure or confirmed stop establishes that its capacity can be released. Disk admission checks the destination filesystem; a managed worktree may use a different volume from its source repository. These are conservative admission budgets, with live CPU/memory-pressure checks, rather than OS-enforced quotas or predictions of future token use.

## Results and completion

**ST-012 — Review the actual result.** The responsible agent posts the actual deliverable, how to inspect or test it, the build/revision and the evidence already collected in the conversation. Link labels describe their destinations. There is no universal Try build button and no promise that every project can run inside Harness.

| Result | What appears in the message | Where the person uses it |
| --- | --- | --- |
| Website | Preview URL and what to check | The existing browser |
| Mobile app | Test distribution link or build artifact, supported device and install/test steps | The appropriate device or simulator |
| Desktop app | Build artifact, supported operating system and launch/test steps | The appropriate computer |
| Hardware or firmware | Artifact, target hardware, setup procedure and physical checks | The actual device or existing authorized device tooling |
| CLI, library or research | Patch/package/document, commands or review instructions and expected results | The relevant terminal, editor or document reader |

Use existing link, file and viewer handling where it applies. The message identifies required access, equipment or setup; an unavailable result remains visibly unavailable. Hardware checks that need a person are requested in this same conversation. Feedback is a reply to the result message, retaining its build/revision. Opening a link is not evidence that a test passed. PRs, review findings, logs, screenshots and recordings remain linked from the work group.

A merged PR is not sufficient for completion when the brief calls for deployment, enablement or a real-world check. The team's playbook retains independent review and evidence requirements; an agent's own completion claim is not a substitute. A group remains waiting on the concrete outstanding check, visible in its messages and work details. Once the agreed acceptance checks pass, the lead posts the result and marks the work complete. The conversation stays available for follow-up or reopening.

## Interaction and recovery details

| Situation | What the person experiences |
| --- | --- |
| First creation | The selected lead opens with the initial prompt; only that conversation is present. |
| Switching conversations | Draft, scroll position and unread position are preserved per conversation. |
| Agent is busy | A sent message shows Queued until its recipient can take it. Urgent interruption uses the existing native agent controls. |
| Agent or host is offline | The affected conversation explains the issue. Pending delivery remains visibly pending; unrelated work continues. |
| Model limit reached | The lead records which work is waiting and uses another authorized eligible agent when permitted. Unknown reset times are not invented. |
| Human question | It is an ordinary message in its originating conversation; any collaborator can answer there. |
| Failed send or start | The same draft or operation can be retried with a visible receipt state; retry does not duplicate it. |
| Collaborators give conflicting directions | Both authors and their messages remain visible. The responsible agent asks for clarification in that conversation before taking incompatible actions. |
| Close the terminal pane | Hide that terminal for this person; the conversation expands. The agent keeps running on its execution machine. |
| Close the Super Tab | Remove it from this person's app tab bar. The shared conversations, collaborators and running agents remain; reopen it through the existing History surface. |
| Stop Harness | End the selected running agent session through the existing explicit Stop Harness action. Record its work as stopped after host confirmation, before reassignment. Closing a pane or tab never invokes this action. |
| Pause new work | The Super Tab's local menu stops new dispatch and agent starts. Current operations finish; stopping a running harness uses its existing Stop action. |
| Narrow window | The sidebar can collapse; an open terminal uses the main area with Back to conversation. Input remains usable. |
| Keyboard and accessibility | Existing Cmd+T/Cmd+N, app search, Enter/Shift+Enter, IME behavior, focus return and native controls retain their meanings. Navigation does not steal focus from typing. |

**ST-016 — Backend authority.** Our backend owns conversations, membership, work state and delivery records. Closing the owner's app does not remove coordination. Execution still needs its host online: work on a sleeping laptop waits, while agents on available team machines continue. Pane visibility is not membership and does not limit the number of agents the tab can coordinate.

**ST-017 — Reliable delivery and ownership.** Retries cannot duplicate a conversation, group, assignment or accepted instruction. Busy-agent delivery uses supported engine behavior. A disconnected worker's ownership is reconciled before replacement; elapsed time alone does not establish that it stopped. Lead replacement restores the brief, assignments, decisions and pending deliveries. Stop/pause, revocation and recovery are backend behaviors, not labels that depend on a lead remembering a prompt.

**ST-005 — Shared context.** Every conversation in a Super Tab is visible to its authorized people. The lead posts the brief and relevant context when delegating. Attaching a running agent shares only the selected session/work context deliberately. Unrelated sessions and account data are not imported because someone joined a tab.

**ST-018 — Permissions.** Viewing conversations, prompting agents, changing membership and executing on machines are checked at their respective boundaries. Revocation ends subsequent access through the revoked grant. Pending deliveries recheck authorization. Terminal access and restored sessions preserve the same scope. Viewer status cannot be bypassed by opening a terminal or calling an agent tool directly.

## Experimental settings

**ST-020 — Coordination belongs to Super Tab.** Remove the visible account switches for Agents can start other agents, Agents in the same tab can message each other, the one-line activity summary, and the pull-request attribution line. Preserve readable legacy settings for existing clients and sessions. A Super Tab enables its own coordination within its explicit session and machine grants; creating one does not enable account-wide execution. New launches should not be instructed to add Harness branding to pull-request descriptions. Focus-bar creature, Share button and product usage sharing remain. The hidden creation shortcut is the only new entry point for now.

## MVP delivery boundary

The first version includes this creation flow, the shared conversations, lead delegation, heterogeneous agents across authorized machines, people joining and contributing, results, review and verification, and recovery. Lead + members is the first template. The Peers template, template editor, full leaderboard and learned quota/performance optimization follow the MVP; basic capacity checks and attempt recording start now. This is the implementation scope.

**ST-019 — Additive adoption.** Super Tab is a new tab type. Existing tabs and sessions keep working. Create a fresh Super Tab and deliberately attach selected running agents through Add agent, preserving their session and working context. There is no separate migration or conversion flow. Validate the complete workflow in disposable sessions before making it available for daily use.

The implementation reuses the existing composer, machine sharing, harness picker and native terminals. It adds backend coordination, flat group conversations and lead roles. Membership and work are independent of visible panes and of the owner's app remaining open. Implementation and acceptance evidence are tracked in [the build record](../../plans/2026-10-18-super-tab-build.md); the presence of code does not establish rollout readiness.

Implementation references: [creation entry rules](../../../desktop/design/new-harness-entry-rules.md), [desktop design system](../../../desktop/design/desktop-design-system.md), [shared-tab flows](../../../desktop/lib/agent_messages/shared_tab_dialogs.dart), [tab leader state](../../../desktop/lib/state/app_state.dart), and [shared-tab model](../../../desktop/lib/agent_messages/shared_tabs_model.dart).

## Acceptance before rollout

| Check | Evidence required |
| --- | --- |
| Creation | Use the hidden Cmd+Option+Shift+T shortcut to create Codex and Claude Code leads through the reused page with different selected machines/repos/settings. Verify prompts and exact destinations, failure recovery and no duplicate launches. Verify ordinary Cmd+T, Cmd+Shift+T, Cmd+Option+T and explicit user remaps retain their existing behavior, and that the new command stays absent from normal menus/help. |
| Control scope | Global navigation remains global. Invite belongs to the Super Tab's sidebar footer beside New group; group members, results and messages remain scoped to their conversation. |
| Work loop | Plan with the lead, create a work group, delegate across two machines/engines, review, test and open the exact result. |
| Joining | Invite a second person into the originating conversation. They can participate without contributing resources, then attach a running agent without restarting it. |
| Sharing and removal | Exercise collaborator and viewer access, pending invite cancellation, removal, terminal control and revoked queued messages. |
| Human help | Ask and answer in a lead conversation and a work group; verify the answer reaches only the relevant agents and unblocks the intended work. |
| Scaling and focus | Exercise 20 people and more agents than visible panes. Participant names stay in the scrollable list; adding workers creates no sidebar chats. New groups, worker activity and another person's navigation do not move the current conversation or overwrite a draft. |
| Delegation boundaries | Keep helper subagents and reconnect tests inside the existing outcome. Create a separate group only for separately owned, independently verifiable delegated work; record its brief and check. |
| Terminal and close behavior | Open the named agent to the right, replace it with another, close the pane, close/reopen the Super Tab, and explicitly Stop Harness. Check exact session identity, personal navigation, team access and process lifetime at each step; exercise the narrow-window return path. |
| Recovery | Exercise busy delivery, lost replies, a model limit, a disconnected machine, backend recovery and lead replacement without duplicate dispatch. |
| Results and verification | Cover web, mobile, desktop, hardware and non-runnable results with real destinations and correct instructions. Tie feedback to its revision and group; keep unfinished device checks visible after merge. |
| Additive adoption | Existing tabs keep working; attaching a running agent preserves its identity and context and clearly grants access to its selected session. Exercise the full work loop in disposable sessions. |

Implementation is authorized. A review build and rollout still require the acceptance evidence above; a new Super Tab does not replace or convert an existing tab automatically.

## Conversation craft: Slack and Discord study, 18 October

The primary workflow is agents coordinating in shared groups. People read, direct,
review and answer in those same conversations. The useful benchmark is how quickly
someone can identify speakers, recover context and contribute without losing their
place. This study uses the products' published interaction and accessibility guides;
it does not establish user-count rankings or a comparative usability score.

| What the references get right | Super Tab decision |
| --- | --- |
| [Slack's message display](https://slack.com/help/articles/213893898-Change-how-messages-are-displayed) separates speaker identity from message content. [Discord's spacing](https://discord.com/blog/making-discord-on-desktop-look-just-right-display-settings-to-ease-the-eyes) groups consecutive posts from one speaker and separates speaker changes. | Give both people and agents a name and identity: account initials for people, existing engine marks for agents. At most three short, single-line updates by the same author can share a header within five minutes. Long or multiline posts, question-marked updates, replies, source changes and dates retain their own header. This only reduces repeated visual noise; messages keep their own IDs and actions. Keep system typography and the Harness palette. |
| [Discord replies](https://support.discord.com/hc/en-us/articles/360057382374-Replies-FAQ) retain the original message's context. | A person's “yes” must identify the agent's exact question; review feedback must identify the result being reviewed. Show an inline excerpt and author in the same flat group. A reply to an agent routes to that agent while it is still a participant; native delivery includes the original message reference and asks the agent to read it. The relationship survives sending and reopening. An unloaded original is labeled explicitly. |
| [Slack unread handling](https://slack.com/help/articles/226410907-View-all-your-unread-messages) supports catching up separately from incoming activity. | Reading history must not jump as agents post. Show a new-message control and retain the reading position. Following the latest messages remains automatic when already at the end. |
| [Slack notification controls](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications) distinguish ordinary traffic from directed attention. | Routine agent traffic stays quiet. A recorded human request is visible in its originating group and clears when its work state changes. No global queue or new notification settings in this pass. |
| [Discord keyboard navigation](https://support.discord.com/hc/en-us/articles/1500000056121-Keyboard-Navigation-FAQ) exposes message actions and clear focus without requiring a mouse. | Message actions appear on hover or focus. Keep a keyboard reply path, Escape back to the composer, existing app shortcuts, per-group drafts and IME-safe sending. |

Code, lists and linked evidence should be readable as part of a conversation.
Render Markdown with the existing type/color roles; retain selectable text and
copyable source. Shared message content must not automatically fetch images,
read local files or execute commands. Web links open only after a person clicks.
Full model, effort and machine information belongs in identity details rather than
being repeated as a dashboard on every message. Typing or working indicators must
come from recorded activity, never invented timers.

These are coordination decisions, not a social-chat feature checklist. Short
updates can share a name visually, but agents should post useful decisions,
questions and results rather than narrate every tool call. Replies are optional
when ordinary conversation is already clear. There are no nested reply rooms,
reaction systems or new global attention feeds in this pass.

Reply context must also work at agent speed: the original question may already
be outside the latest page of messages. Native delivery includes the exact
`message GROUP MESSAGE_ID` lookup command. It reads within the same tab and group
and rechecks the caller's current contribution; it does not depend on the
original being in the latest 100 messages.
