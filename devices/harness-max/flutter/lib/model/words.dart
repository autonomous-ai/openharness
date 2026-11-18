// What the bar reads in a question's words (max_ui_ask.c, max_ui_card.c): a permission prompt's yes and no by the
// daemon's own patterns (cli/src/engines/kit/questionPane.ts APPROVE_RE, REJECT_RE), the command it asks to run, and
// the tail the daemon puts on a wait the bar only shows. Plain functions: the model and the Attention page share them.
import 'types.dart';

final RegExp _approve = RegExp(r'^(yes|allow|approve|accept|proceed|run|continue)\b', caseSensitive: false);
final RegExp _reject =
    RegExp(r"^(no|reject|deny|decline|cancel|skip|don'?t|stop)\b|^tell\b.*\bwhat to change\b", caseSensitive: false);

bool optionApproves(String option) => _approve.hasMatch(option);
bool optionRejects(String option) => _reject.hasMatch(option);

/// A permission prompt's Allow and Deny: its first option that approves and its first that rejects. Null when it lacks
/// either: its options are then the buttons, as they are.
({int allow, int deny})? allowDeny(AskItem item) {
  final allow = item.options.indexWhere(optionApproves), deny = item.options.indexWhere(optionRejects);
  return allow < 0 || deny < 0 ? null : (allow: allow, deny: deny);
}

/// What a permission prompt asks to run: the words after its first ": " ("Approve Bash command: make flash").
String commandOf(String prompt) {
  final at = prompt.indexOf(': ');
  return at >= 0 && at + 2 < prompt.length ? prompt.substring(at + 2) : prompt;
}

/// The daemon's line for a wait the bar only shows ends in " · answer in `<App>`" (devices.ts showWaits), which
/// Attention's hint under it says already: dropped, so one glass does not say it twice. The last such tail goes; a line
/// that is nothing but the tail keeps it.
String dropAnswerTail(String text) {
  final at = text.lastIndexOf(' · answer in ');
  return at > 0 ? text.substring(0, at) : text;
}
