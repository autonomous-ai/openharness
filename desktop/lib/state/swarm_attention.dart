import 'app_state.dart';
import 'pending_question.dart';
import 'swarm_navigation.dart';

/// A real pending question and the view it would open at selection time.
/// Missing roster entries remain visible, but cannot create an unknown view.
class SwarmAttentionEntry {
  const SwarmAttentionEntry({
    required this.question,
    required this.destination,
    required this.available,
  });

  final PendingQuestion question;
  final SwarmDestination destination;
  final bool available;
  String get id => destination.id;
}

List<SwarmAttentionEntry> swarmAttentionEntries(
  AppNotifier app, {
  List<String> recent = const [],
}) {
  final questions = app.machineStates.values
      .expand((machine) => machine.blockedAgents.values)
      .toList();
  if (questions.isEmpty) return const [];
  final destinations = {
    for (final row in swarmDestinations(app, recent: recent)) row.id: row,
  };
  questions.sort((a, b) {
    final age = a.since.compareTo(b.since);
    return age != 0
        ? age
        : agentDestinationId(
            a.machineId,
            a.agentId,
          ).compareTo(agentDestinationId(b.machineId, b.agentId));
  });
  return [
    for (final question in questions) _entry(app, question, destinations),
  ];
}

SwarmAttentionEntry _entry(
  AppNotifier app,
  PendingQuestion question,
  Map<String, SwarmDestination> destinations,
) {
  final id = agentDestinationId(question.machineId, question.agentId);
  final view = destinations[id];
  final machine = app.stateOf(question.machineId);
  final agent = view == null
      ? machine?.agents.where((a) => a.id == question.agentId).firstOrNull
      : null;
  final project = agent == null ? null : machine?.projectOf(agent);
  return SwarmAttentionEntry(
    question: question,
    available: view != null,
    destination: SwarmDestination(
      id: id,
      title: view?.title ?? agent?.name ?? question.agentId,
      detail:
          view?.detail ??
          [
            machine?.machine.displayName ?? question.machineId,
            project?.label,
            project?.branch,
          ].whereType<String>().where((s) => s.isNotEmpty).join(' · '),
      swarmId: view?.swarmId,
      current: view?.current ?? false,
      machineId: question.machineId,
      agentId: question.agentId,
      engine: view?.engine ?? agent?.identityEngine,
      searchFields: [
        ...?view?.fields.skip(1),
        if (view == null) machine?.machine.displayName ?? question.machineId,
        project?.label,
        project?.name,
        project?.branch,
        project?.cwd,
        question.prompt,
      ],
    ),
  );
}

List<SwarmAttentionEntry> filterSwarmAttention(
  List<SwarmAttentionEntry> entries,
  String query,
) {
  // An empty search retains the time we first heard each question. No timers,
  // polling, or changing "age" labels are needed while someone chooses.
  if (query.trim().isEmpty) return entries;
  final byId = {for (final entry in entries) entry.id: entry};
  return [
    for (final destination in rankSwarmDestinations(
      entries.map((entry) => entry.destination).toList(),
      query,
    ))
      byId[destination.id]!,
  ];
}

Future<bool> activateSwarmAttention(
  AppNotifier app,
  SwarmAttentionEntry entry, {
  required String destinationSwarmId,
}) async {
  final question = entry.question;
  final current = app.questionFor(question.machineId, question.agentId);
  // A question answered elsewhere, or replaced during dismissal, must not
  // redirect focus or create a now-unneeded membership.
  if (!entry.available || current == null || !question.sameAs(current)) {
    return false;
  }
  return activateSwarmDestination(
    app,
    entry.destination,
    destinationSwarmId: destinationSwarmId,
  );
}
