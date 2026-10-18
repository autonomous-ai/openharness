import 'shared_tab_placement.dart' show plainSharedText;
import 'shared_tabs.dart' show SharedTabsFailure;

/// What to tell a person when a `share_*` action was refused: what happened
/// and what to do. [machine] is the name of the computer the action needed,
/// when it is one of the person's own; another account's computer, or none
/// known, reads "That computer". Any code not listed shows the daemon's own
/// sentence as plain text, or a general one.
String sharedTabErrorText(SharedTabsFailure f, {String? machine}) {
  final name = machine == null ? '' : plainSharedText(machine);
  final away = name.isEmpty ? 'That computer' : name;
  return switch (f.code) {
    'MACHINE_AWAY' => '$away is away. Try again when it\'s on.',
    'TAB_FULL' => 'A shared tab holds 32 harnesses and 8 people.',
    'RATE_LIMITED' =>
      'This tab sent 120 messages in 10 minutes. Try again in a few minutes.',
    'TOO_LARGE' => 'That message is too long for a shared tab.',
    'SHARED_TABS_UNSUPPORTED' =>
      'Shared tabs aren\'t available on the Harness service yet.',
    'DAEMON_TOO_OLD' ||
    'UNKNOWN_ACTION' ||
    'UNSUPPORTED' => 'Update Harness on this computer to share tabs.',
    'NOT_OWNER' => 'Only the computer that shares this tab can change it.',
    'SHARED_ELSEWHERE' => 'This tab is already shared from another of your computers. Change it there.',
    'RELAY_TAKEN' =>
      'This tab is connected from another place; messages wait here.',
    _ => () {
      final text = plainSharedText(f.message);
      return text.isEmpty || text == f.code
          ? 'Something went wrong. Try again in a moment.'
          : text;
    }(),
  };
}
