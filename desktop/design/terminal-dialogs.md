# Desktop dialog behavior

Use the [desktop design system](desktop-design-system.md) for presentation.
This file retains the interaction and data-integrity contracts from the former
terminal-dialog specification. Fixed cells, one-line-only selection, mandatory
monospace, bracket buttons, ASCII checkboxes, and terminal-colored modal frames
are retired for app UI. Older screenshots are historical evidence only.

## Shared ownership

Reuse the existing controllers, launch paths, and receipt recovery. Cmd-N and the
full-page welcome use the same form. Cmd-P scopes use the same query editor,
result selection, and resource preview. Styling must not fork their behavior.
The detailed creation contract is [new-harness-entry-rules.md](new-harness-entry-rules.md).

Fresh creation combines the last successful setup with the last focused real
project and its machine. Explicit Store/split requests and pending launch receipts
retain their destination and reviewed values. Closing cancels an ordinary form. Never substitute another branch, folder, agent, or profile,
or disable Worktree after a failure. Browsing options does not commit them.
Searching and highlighting never creates a folder or launches a harness.
A held Return cannot accept a choice and launch in the same keypress.

The popup's main form closes through its explicit Close action. Child menus
may dismiss on outside click or Escape and return to the same draft. New Tab
has no Close button on its form. Successful creation uses its existing tab
placement. Preserve pending launch receipts and duplicate-start guards.

## Keyboard and focus

Resolve shortcuts from the live keymap. Normal text, including j and k, stays
text. Preserve paste, readline editing, input composition, and remapping.
Enter/Space activate the focused control; Enter in the task submits according
to the existing form rule. Composition confirmation is never submission.

Search keeps focus in its editor while navigating results. Tab traverses
controls and existing list/preview regions. Inline editors keep traversal in
fields until the final action, then return to the surrounding view. Escape
backs out of nested editing before dismissing a surface. Page navigation uses
the rendered row extents. Focus returns to the trigger on dismissal.

A stationary pointer does not steal keyboard selection. Live inventory updates
do not pick a result or switch the resource being edited. Opening, previewing,
or cancelling UI cannot send input to an agent or recreate a terminal.

## Search and resources

The empty query searches harnesses. Editable prefixes and clickable scopes
remain: machines, projects, models, Store, and commands. Keep one editor and
stable geometry across scopes. Cmd-N creates; Cmd-P has no duplicate New Harness
result. Empty matches clear the preview. No row selected means Enter does nothing.
Unavailable sessions retain their saved preview and show the actual reason;
click/Enter cannot open them until available.

Commands use their real names and current shortcuts. Results remain virtualized;
query changes and highlights do not rebuild the whole catalog. Selection is
identified by stable resource identity through inventory changes.

Machines keep Connect/Password, Rename, and Delete in their existing management
preview. Inline changes do not cover search with a second dialog. Cancelling
returns to that machine's controls. Pending requests survive editor dismissal;
late responses cannot change a replacement editor. Destructive confirmations
start with Cancel focused. Show real resource readings and availability.

Before a machine search, prioritize online machines needing connection, this
computer, other connected machines, and offline machines. Preserve selected
identity across reorder. Add machine remains available after the list and
explains setup on the other computer. Copying an installation command does
not execute it here.

Model groups retain Subscriptions, APIs, Your local AI models, and Shared with
you. API model disclosure, matching within groups, compatible subscriptions,
and local catalogs retain their current behavior. Grid is an add-on: until it
is set up here, local and shared models are one Set up row (Sign in, when
signed out of Harness), and opening the picker never sets it up. Get downloads/prepares;
Use starts when necessary and selects for the original harness; Stop explicitly
stops an owned process. An unavailable row stays inspectable without activation.
Closing the picker cancels its pending model switch, not startup on the host.
Never transfer another machine's capabilities to an unknown/shared host.

Show real sizes, quantization, throughput, and request periods only when known.
Keys stay masked; provider credential editors never read stored secrets back
into a field. Resource errors and progress appear beside the affected controls.

## Sharing

Keep the selected agent, committed access, people, invitation expiry, comments,
and stop-sharing controls in the same flow. Browsing access options does not
change permissions. Opening or cancelling alone does not create a link.
Expiry applies to new invitations, not public links. Pending requests and
errors retain their existing scope and protections against stale completion.

## Verification

Review dark and light appearances, narrow windows, enlarged text, long labels,
loading/errors, missing resources, mouse and keyboard, composition, and live
updates. Use the relevant existing creation, placement, sharing, search,
resource, keymap, and lifecycle suites. Replace tests that enforce retired
presentation with checks of the new visible behavior while retaining safeguards.

After a native build, restart the app before judging it. Use synthetic data for
saved screenshots. Coverage gates measure executable lines, not every possible
interaction. Physical native IME and VoiceOver require their own verification.
