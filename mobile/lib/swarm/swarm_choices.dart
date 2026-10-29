/// How Swarm looks and behaves on the phone, one choice per question asked of
/// the mobile app's owner (2026-10-27). Each is the recommended answer, taken
/// while the owner had not answered (Lead's call); a different answer is a
/// change here, and in the one place each names.
library;

/// 1. The way in. True: Find, and a Swarm mark on Home's title with how many
/// things wait on the person (`swarm_mark.dart`). False: Find only.
const swarmHomeMark = true;

// 2. The first screen: Swarm Home, direction B (Tony, 2026-10-29) — what
// needs the person first, then the projects pinned, then the others by
// latest activity (`swarm_page.dart`). Tony's answer, so no choice is left
// here.

// 3. A project opens on its project chat: prototype B (Tony, 2026-10-28),
// with nothing under the header and a ⋮ menu at its end (Tony, 2026-10-29):
// Buddy chat (Chat with PM until #2090), and the team's status in words,
// which opens its work (by latest activity, quiet and archived work behind
// "Older") and its team in a sheet (`swarm_project_page.dart`). Tony's answer,
// so no choice is left here.

/// 4. Posting: text, @mentions and files — from the photo library, the camera
/// or Files, by Desktop's limits (Tony, 2026-10-28). False: files are opened,
/// not sent (`swarm_conversation_page.dart`).
const swarmSendsFiles = true;

/// 5. Notices: on the phone while Harness is open; push to a closed app is
/// backend work for later. False posts none (`swarm_session.dart`).
const swarmLocalNotices = true;

/// 6. A decision's answer cannot be changed once sent: one tap holds it this
/// long, with Undo, before it goes. Zero sends at once.
const swarmUndoWindow = Duration(seconds: 3);
