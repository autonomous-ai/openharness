# Private project: add people from the People panel (Diego, 2026-11-04)

## What Diego asked

In a private project ("test private", 🔒), the roster's **This project ▸ People** has no way to bring someone in. Agents has
a "+", People has none. Diego wants one, for people already in the Swarm. Inviting someone from outside the Swarm by email
is not part of this. Mockup `desktop/mockup/private-project-invite.html`, option **B** (a picker made for adding).

## How it works today (main 2407b8f76)

- The backend already has `project.sharing { projectId, visibility, memberIds }` (commands.ts:172, :1647). It replaces the
  project's member list. Only the project owner may send it (`manageProject`, PROJECT_OWNER_REQUIRED).
- Desktop sends it only from the project menu ▸ **Sharing** dialog (project_options.dart `showProjectAction(…, 'sharing')`).
  That dialog lists every Swarm person with a checkbox, and only the project owner sees the menu item.
- The People heading's "+" is the Swarm invite (`onAdd: c.isOwner ? widget.onInvite : null`, roster.dart:623). Only the
  Swarm owner sees it, and accepting a Swarm invite does not put anyone in a private project.

## Behaviour

### The "+" on People

On the roster's People heading, the "+" is **Add people to this project** when all of these hold:

- the roster is on the **This project** scope, and that project is open and readable (`scoped != null`);
- the project is private (`isPrivate`);
- the reader is its owner (`ownerId == c.accountId`);
- the reader can write (`c.canWrite`).

Its tooltip is "Add people to this project". In every other case the heading is as today: the Swarm invite for the Swarm
owner, nothing for anyone else.

### The picker

The "+" opens a dialog titled **Add people to <project name>**, with:

- A search field, placeholder "Search people in this Swarm". It matches name, username or email as a case-insensitive
  substring, ignoring surrounding spaces.
- **Not in this project:** the Swarm's people who are neither the owner nor members, each with a checkbox, sorted by name
  (case-insensitive). Each row shows the person's name, else username, with the email under it.
- **Already in:** the owner (marked "Project owner") and the members, as text without checkboxes. The search narrows this
  list too.
- When no one is left to add, the "Not in this project" section reads "Everyone in this Swarm is in this project." When the
  search matches no one, it reads "No one matches".
- **Cancel**, and a filled button **Add N person** / **Add N people** that is disabled while nothing is ticked.

Add sends `project.sharing { projectId, visibility: 'private', memberIds }`. `memberIds` is the project's current members,
read from the live snapshot when Add is pressed, plus the ticked people, without duplicates and without the owner. Only
people in the Swarm now are sent. A member who left the Swarm and came back (another `generation` than the one stored with
the membership) is not in the project: they show under "Not in this project" and are sent only when ticked.
On success the dialog closes, and the people show under People once the snapshot answers. On failure the dialog stays open
with `c.operationError` shown under the lists, and the ticks are kept. While an action is pending, Add is disabled and
"Check pending action" retries it, as in Sharing. Add is also disabled once the project is gone, public, or owned by
someone else.

Removing people, and switching the project public, stay in the project menu ▸ Sharing, which is unchanged.

## Design

- **Growth:** no new stored data. The project's `members` list already exists, is capped at 200 by the command schema, and
  goes away with the project.
- **Concurrency:** `project.sharing` replaces the list in one Swarm write, and only the project owner can send it. The picker
  builds the list from the live snapshot at the moment Add is pressed, so a change the owner made elsewhere since the dialog
  opened is kept. Two Adds from the owner's two devices at the same instant: the last write wins, as Sharing does today.
- **Read cost:** none new. The dialog reads the snapshot the app already holds.
- **Scale:** a Swarm with 10x people gives a longer list, which the search narrows. The 200-member cap is the limit; Add past
  it fails with the server's error, shown in the dialog.
- **Compatibility:** no protocol change. Old Desktops keep the Sharing dialog. The phone and web are untouched.
- **Migration + rollback:** none.
- **Audience:** the server enforces it (`manageProject`). The "+" is hidden from anyone else only as a convenience.
- **Identity:** the signed-in person's own command, never the machine owner's.
- **Failure:** a refused or failed Add shows its error in the dialog, which stays open. Nothing is sent when nothing is
  ticked.
- **Platforms:** Desktop on macOS, Linux and Windows (desktop/lib). Phone and web: not in scope.
