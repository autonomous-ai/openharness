import 'package:collection/collection.dart';

import 'linked_tasks.dart';
import 'model.dart';

/// A task's priority (task #3117): P0 goes first wherever work is ordered.
enum SuperTabTaskPriority {
  p0('P0', 'Hotfix: something shipped is broken'),
  p1('P1', 'Needed by users soon'),
  p2('P2', 'Planned goal'),
  p3('P3', 'Tools, docs or process');

  const SuperTabTaskPriority(this.badge, this.meaning);

  /// What its badge says, which is also its value on the wire: "P0".
  final String badge;
  final String meaning;

  /// The priority [value] names ("P0" to "P3"); null for anything else.
  static SuperTabTaskPriority? named(Object? value) =>
      values.where((p) => p.badge == value).firstOrNull;
}

/// [task]'s effective priority: its field, else its title's marker (a task
/// from before the field: URGENT is P0, high is P1), else P2.
SuperTabTaskPriority superTabTaskPriority(SuperTabConversation task) =>
    SuperTabTaskPriority.named(task.priority) ??
    superTabTitlePriority(task.title).priority ??
    SuperTabTaskPriority.p2;

/// Whether [group] carries a priority: a task, not a step or a private chat
/// (a Buddy chat is one). The project's chat is the caller's to leave out.
bool superTabCarriesPriority(SuperTabConversation group) =>
    !superTabIsStep(group) && group.audience == null && !group.isBuddyChat;

final _leading = RegExp(r'^\s*URGENT\b\s*:?\s*', caseSensitive: false);
final _trailing = RegExp(
  r'\s*\((?:[^()]*,\s*)?(urgent|high)(?:\s+priority)?\)\s*$',
  caseSensitive: false,
);

/// [title]'s priority and the title without its marker (Scholes's mockup,
/// task #2774). Before the priority field (task #3117) the PM wrote it into
/// the title, as a leading URGENT (P0) or a closing "(Name, high)" (P1); the
/// shown title drops the marker either way. Any other parenthetical stays.
({SuperTabTaskPriority? priority, String title}) superTabTitlePriority(
  String title,
) {
  if (_leading.firstMatch(title) case final match?) {
    final rest = title.substring(match.end);
    if (rest.isNotEmpty) {
      return (
        priority: SuperTabTaskPriority.p0,
        title: rest[0].toUpperCase() + rest.substring(1),
      );
    }
  }
  if (_trailing.firstMatch(title) case final match?) {
    final rest = title.substring(0, match.start);
    if (rest.isNotEmpty) {
      return (
        priority: match.group(1)!.toLowerCase() == 'urgent'
            ? SuperTabTaskPriority.p0
            : SuperTabTaskPriority.p1,
        title: rest,
      );
    }
  }
  return (priority: null, title: title);
}
