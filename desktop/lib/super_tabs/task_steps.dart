import 'linked_tasks.dart';
import 'model.dart';

// Kept byte-identical on Desktop (lib/super_tabs/task_steps.dart) and the
// phone (lib/swarm/task_steps.dart): mobile/test/swarm/desktop_parity_test.dart.

/// [task]'s steps, by number (task steps design): each keeps its own
/// conversation, shown inside its task. An open task shows those not archived;
/// an archived one keeps the steps archived with it, and their rows.
List<SuperTabConversation> superTabStepsOf(
  SuperTabSnapshot snapshot,
  SuperTabConversation task,
) {
  final steps = [
    for (final g in snapshot.conversations)
      if (superTabIsStep(g) &&
          g.reviewOf == task.id &&
          g.projectId == task.projectId &&
          (task.archived || !g.archived))
        g,
  ];
  int order(SuperTabConversation g) => g.number ?? 1 << 30;
  steps.sort((a, b) {
    final byNumber = order(a).compareTo(order(b));
    return byNumber != 0 ? byNumber : a.id.compareTo(b.id);
  });
  return steps;
}

/// [task]'s rows with its steps' rows ([steps], by step conversation id)
/// merged in by when they were written, then by id. Each conversation numbers
/// its own messages, so sequences do not compare across them.
List<SuperTabMessage> superTabMergeSteps(
  List<SuperTabMessage> task,
  Map<String, List<SuperTabMessage>> steps,
) {
  final all = [...task, for (final rows in steps.values) ...rows];
  if (steps.isEmpty) return all;
  final zero = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
  all.sort((a, b) {
    final byTime = (a.createdAt ?? zero).compareTo(b.createdAt ?? zero);
    return byTime != 0 ? byTime : a.id.compareTo(b.id);
  });
  return all;
}

/// The last merge of a task's chat, kept while its rows are the same lists:
/// a chat drawn again with nothing new is not sorted again (final review,
/// minor 8).
class SuperTabStepsMerge {
  List<SuperTabMessage>? _task;
  Map<String, List<SuperTabMessage>> _steps = const {};
  List<SuperTabMessage> _rows = const [];

  List<SuperTabMessage> of(
    List<SuperTabMessage> task,
    Map<String, List<SuperTabMessage>> steps,
  ) {
    final same =
        identical(task, _task) &&
        steps.length == _steps.length &&
        steps.entries.every((e) => identical(_steps[e.key], e.value));
    if (!same) {
      _task = task;
      _steps = Map.of(steps);
      _rows = List.unmodifiable(superTabMergeSteps(task, steps));
    }
    return _rows;
  }
}
