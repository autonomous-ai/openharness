import '../core/first_task.dart';

/// An agent's first message (Swarm v4, anh Dee 2026-11-08): its name, then what its person asked, as a person starting
/// Claude Code or Codex would type it. No Swarm manual: messages reach it as they arrive (cli superTabs/host.ts).
/// Native creation accepts at most [kFirstTaskMaxLength] UTF-16 code units, so a longer request is cut there; the whole
/// of it stays in the agent's chat. With no name given, the request alone.
String superTabLaunchPrompt({required String? name, required String task}) {
  final head = name == null ? '' : 'You are $name.';
  final body = task.trim();
  if (body.isEmpty) return head;
  final lead = head.isEmpty ? '' : '$head\n\n';
  final room = kFirstTaskMaxLength - lead.length;
  return '$lead${body.length > room ? body.substring(0, room) : body}';
}
