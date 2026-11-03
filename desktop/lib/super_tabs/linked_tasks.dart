import 'model.dart';

// Kept byte-identical on Desktop (lib/super_tabs/linked_tasks.dart) and the
// phone (lib/swarm/linked_tasks.dart): mobile/test/swarm/desktop_parity_test.dart.

/// The tasks linked to [group] (`reviewOf` it, in its project; never a Buddy
/// chat or the Leads conversation), lowest number first, each with its checks'
/// results: "#14 Review PR 12: passed · #15 Test PR 12: 1 check failed". Null
/// when it has none. Only recorded checks count: a verdict an agent posted in
/// chat shows nowhere here.
String? superTabLinkedLine(
  SuperTabSnapshot snapshot,
  SuperTabConversation group,
) {
  final linked = [
    for (final task in snapshot.conversations)
      if (task.reviewOf == group.id &&
          task.projectId == group.projectId &&
          task.kind == null)
        task,
  ];
  if (linked.isEmpty) return null;
  // Unnumbered last; the id keeps the order the same on every read.
  int order(SuperTabConversation task) => task.number ?? 1 << 30;
  linked.sort((a, b) {
    final byNumber = order(a).compareTo(order(b));
    return byNumber != 0 ? byNumber : a.id.compareTo(b.id);
  });
  return [
    for (final task in linked)
      superTabIsStep(task)
          ? '${_stepLabel(snapshot, task)}: ${_state(task)}'
          : '${task.label}: ${_state(task)}',
  ].join(' · ');
}

/// Whether [conversation] is a step of a task (task steps design): shown on
/// its task's row and inside its task, never as a task of its own. Every
/// linked task is one, named or not (Ken, 2026-11-02; backend steps.ts).
bool superTabIsStep(SuperTabConversation conversation) =>
    conversation.reviewOf != null;

/// A step's name: the one it was opened with, else its title.
String superTabStepName(SuperTabConversation step) => step.step ?? step.title;

/// [groups] as the project's list shows them: without steps, which sit on
/// their task's row (task steps design).
List<SuperTabConversation> superTabListedWork(
  Iterable<SuperTabConversation> groups,
) => [
  for (final g in groups)
    if (!superTabIsStep(g)) g,
];

/// A step by its own name and its agent: "Copy (Atlas)".
String _stepLabel(SuperTabSnapshot snapshot, SuperTabConversation step) {
  final agentId = step.assignment?['agentId'];
  final name = agentId is String && snapshot.agent(agentId) != null
      ? snapshot.agentName(agentId)
      : null;
  return name == null
      ? superTabStepName(step)
      : '${superTabStepName(step)} ($name)';
}

/// A linked task's state: its work's status while it has no checks; else a
/// failed check (its evidence kept, nobody passing it) first, then passed.
String _state(SuperTabConversation task) {
  final checks = task.checks;
  if (checks.isEmpty) {
    return switch (task.assignment?['status']) {
      final String status => superTabWorkStatusLabel(status),
      _ => 'not started',
    };
  }
  final failed = checks
      .where((c) => c['evidence'] is String && c['passedBy'] == null)
      .length;
  if (failed > 0) {
    return failed == 1 ? '1 check failed' : '$failed checks failed';
  }
  final passed = checks.where((c) => c['passedBy'] != null).length;
  return passed == checks.length
      ? 'passed'
      : '$passed of ${checks.length} checks passed';
}
