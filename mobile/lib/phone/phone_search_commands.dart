import 'dart:async';

import 'phone_destination.dart';

/// Something the app does, offered by name under `>`.
///
/// The action travels WITH the row, unlike the desktop, where the screen owns a
/// keymap and resolves a command id back to a handler. The phone has no keymap
/// to resolve against, and an id matched back to a handler by hand at the call
/// site is how a renamed command becomes a row that quietly does nothing.
class PhoneCommand {
  const PhoneCommand({
    required this.id,
    required this.title,
    required this.detail,
    required this.run,
  });

  /// Stable across releases: it is what [PhoneSearchHistory] remembers, so a
  /// renamed title keeps its place in the list and a renamed id loses it.
  final String id;

  final String title, detail;
  final FutureOr<void> Function() run;

  PhoneDestination get destination => PhoneDestination(
    id: 'command:$id',
    kind: PhoneDestinationKind.command,
    title: title,
    detail: detail,
    commandId: id,
    searchFields: [id, detail],
  );
}

/// The `?` rows: what this one box can do, each with the character that goes
/// there directly.
///
/// The desktop's `_searchModes`, minus the keyboard. Its point survives the
/// translation intact: five shortcuts that open five things read as five
/// features until something lists them in one place, and then they read as one.
/// A phone has no key to discover them by, so `?` is the only teacher there is.
List<PhoneDestination> phoneSearchModes(List<PhoneCommand> commands) => [
  _mode('commands', '>  Commands', 'Run anything by name', '> '),
  _mode('projects', '#  Projects', 'Choose a project, then one of its harnesses', '# '),
  _mode('machines', '@  Machines', 'Choose a machine, then one of its harnesses', '@ '),
  for (final command in commands) command.destination,
];

PhoneDestination _mode(
  String id,
  String title,
  String detail,
  String query,
) => PhoneDestination(
  id: 'picker:$id',
  kind: PhoneDestinationKind.mode,
  title: title,
  detail: detail,
  pickerQuery: query,
  searchFields: [detail],
);
