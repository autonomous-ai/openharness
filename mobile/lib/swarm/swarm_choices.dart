/// How Swarm looks and behaves on the phone, one choice per question asked of
/// the mobile app's owner (2026-10-27). Each is the recommended answer, taken
/// while the owner had not answered (Lead's call); a different answer is a
/// change here, and in the one place each names.
library;

/// 1. The way in. True: Find, and a Swarm mark on Home's title
/// (`swarm_mark.dart`). False: Find only.
const swarmHomeMark = true;

// 2. The first screen: Swarm Home — the projects as channels, the quiet ones
// folded (`swarm_page.dart`). Tony's answer, so no choice is left here.

// 3. A project: its channel filling the screen under its #name, and ⋮ for its
// Leaderboard, Sharing, Notifications and settings (`swarm_project_page.dart`).
// No choice is left here.

/// 4. Posting: text, @mentions and files — from the photo library, the camera
/// or Files, by Desktop's limits (Tony, 2026-10-28). False: files are opened,
/// not sent (`swarm_conversation_page.dart`).
const swarmSendsFiles = true;

/// 5. Notices: on the phone while Harness is open; push to a closed app is
/// backend work for later. False posts none (`swarm_session.dart`).
const swarmLocalNotices = true;
