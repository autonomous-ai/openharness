import '../state/harness_activity.dart';
import 'agent_details.dart';

/// An agent row's one line (Dee, 2026-10-27: "it's hard to monitor the team"): its state, where it runs, and on which
/// model and effort. Read from the Swarm the person already sees, so nobody sees an agent or a machine they could not
/// see before.

/// [label] is the agent's state in a word: "Waiting" is on a person (a question, needs-human work, an input prompt);
/// "Assigned" holds a task with no turn seen running: a task can outlive its turn or connection, so it never reads
/// as working.
/// One agent in one line: "Working · Mac Studio · Opus 5.5 · high".
class SuperTabAgentGlance {
  const SuperTabAgentGlance({
    required this.label,
    required this.machine,
    required this.model,
    required this.effort,
  });

  /// The state as shown: one word, or "Limited until 09:05".
  final String label;
  final String? machine, model;

  /// The effort to show: the recorded one, else its start's; null when neither names one. A row says only what is
  /// known: the PM's row read "opus unknown" (2026-10-28).
  final String? effort;

  /// "Opus 5.5 · high", or "Opus 5.5" when no effort is known; null when the model is not known (an agent read
  /// before it reported one).
  String? get modelEffort =>
      model == null ? null : [model, ?effort].join(' · ');

  String get line => [label, ?machine, ?modelEffort].join(' · ');
}

/// An effort that says which one runs. 'auto' is what Claude Code reports for an effort it was launched with, and
/// 'default' what a start asks when it leaves the engine's own: neither names one.
String? _concrete(Object? effort) =>
    effort is String &&
        effort.isNotEmpty &&
        effort != 'auto' &&
        effort != 'default'
    ? effort
    : null;

SuperTabAgentGlance superTabAgentGlance(
  SuperTabAgentInfo info, {
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  final agent = info.agent;
  final work = info.taskGroup?.assignment?['status'];
  final activity = info.activity;
  final until = agent.limitedUntil?.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  final label = switch (null) {
    _ when work == 'lost' => 'Lost',
    _
        when agent.downSince != null ||
            activity == HarnessActivity.offline ||
            activity == HarnessActivity.failed =>
      'Down',
    _ when until != null && until.isAfter(at) =>
      'Limited until ${two(until.hour)}:${two(until.minute)}',
    _ when activity == HarnessActivity.starting => 'Starting',
    _ when activity == HarnessActivity.paused => 'Stopped',
    // Before waiting: the sidebar marks blocked work as needing input too.
    _ when work == 'blocked' => 'Stuck',
    _
        when info.hasQuestion ||
            work == 'needs_human' ||
            activity == HarnessActivity.needsInput =>
      'Waiting',
    _ when work == 'review' => 'In review',
    _ when work == 'reconciling' => 'Checking',
    _ when activity == HarnessActivity.working => 'Working',
    _ when work == 'planned' || work == 'working' => 'Assigned',
    _ when activity == HarnessActivity.done => 'Finished',
    _ => 'Idle',
  };
  return SuperTabAgentGlance(
    label: label,
    machine: info.machine,
    model: info.model,
    effort:
        _concrete(agent.configuration['effort']) ??
        _concrete(info.controller.snapshot?.startEfforts[agent.harnessId]),
  );
}
