import '../state/app_state.dart';
import '../state/harness_activity.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';

/// The work an agent's row talks about: a question it waits on, its current
/// task, or a finished one whose pull request has not merged yet. Only a group
/// the viewer reads.
class SuperTabAgentWork {
  const SuperTabAgentWork(this.group, {this.awaitingMerge = false});
  final SuperTabConversation group;

  /// Done, with its pull request still open: the agent waits on its merge.
  final bool awaitingMerge;

  String? get status => group.assignment?['status'] as String?;

  /// When the agent last reported progress on it (backend assignment.progressAt).
  DateTime? get progressAt => _time(group.assignment?['progressAt']);

  /// Until when that progress vouches for it (backend assignment.leaseUntil):
  /// the Swarm moves a task whose agent stays quiet past it.
  DateTime? get leaseUntil => _time(group.assignment?['leaseUntil']);

  static DateTime? _time(Object? ms) =>
      ms is num ? DateTime.fromMillisecondsSinceEpoch(ms.toInt()) : null;
}

/// Whether the viewer reads [group]: never a Buddy chat, and a private group
/// only when its people include them. The server sends no other; this keeps a
/// title from showing if one ever arrived.
bool _readable(SuperTabController c, SuperTabConversation group) =>
    !group.isBuddyChat &&
    (group.audience == null || group.audience!.contains(c.accountId));

SuperTabAgentWork? superTabAgentWork(
  SuperTabController c,
  SuperTabAgent agent,
) {
  // A question waiting on a person comes first, from whichever of its open
  // groups asks it: that is where its row's click goes.
  final asking = c.snapshot?.conversations
      .where(
        (g) =>
            !g.closed &&
            _readable(c, g) &&
            g.assignment?['agentId'] == agent.id &&
            superTabWorkWaits(g.assignment?['status']),
      )
      .firstOrNull;
  if (asking != null) return SuperTabAgentWork(asking);
  final current = SuperTabAgentInfo(c, null, agent).taskGroup;
  if (current != null) {
    return _readable(c, current) ? SuperTabAgentWork(current) : null;
  }
  final waiting = c.snapshot?.conversations
      .where(
        (g) =>
            !g.closed &&
            _readable(c, g) &&
            g.assignment?['agentId'] == agent.id &&
            g.assignment?['status'] == 'done' &&
            g.cards.pullRequests.isNotEmpty &&
            !g.cards.pullRequests.any((pr) => pr.merged),
      )
      .firstOrNull;
  return waiting == null
      ? null
      : SuperTabAgentWork(waiting, awaitingMerge: true);
}

/// This Mac's own reading of the agent; null when it has none, or reads its
/// status as unknown.
HarnessActivity? superTabLocalActivity(AppNotifier? app, SuperTabAgent agent) {
  final local = app == null
      ? null
      : harnessActivity(app, agent.machineId, agent.harnessId);
  return local == HarnessActivity.unknown ? null : local;
}

/// What the Swarm knows of an agent this Mac cannot see that stops it
/// running (Dee, 2026-10-29): its computer silent, offline; its session
/// stopped; its start failed. Null when none is known. While the Swarm
/// cannot be read, its computers are not called offline.
HarnessActivity? superTabSwarmDown(
  SuperTabController c,
  SuperTabAgent agent,
  DateTime now,
) {
  // The computer it runs on reports for itself: a Harness Team account
  // shown as its Mac has its own heartbeat.
  final machine = c.snapshot?.pool(agent.machineId);
  final at = switch (machine?['observation']) {
    {'receivedAt': final num at} => at.toInt(),
    _ => null,
  };
  if (machine != null &&
      !c.backendUnreachable &&
      superTabMachineStatus(
            age: at == null
                ? null
                : now.difference(DateTime.fromMillisecondsSinceEpoch(at)),
          ) ==
          SuperTabMachineStatus.offline) {
    return HarnessActivity.offline;
  }
  if (agent.downSince != null) return HarnessActivity.paused;
  final task = SuperTabAgentInfo(c, null, agent).taskGroup;
  return task?.liveness?['state'] == 'orphaned' &&
          task?.liveness?['why'] == 'start-failed'
      ? HarnessActivity.failed
      : null;
}

/// The mark an agent's row shows, and the order it takes (Dee, 2026-10-30):
/// the Swarm's state first, which every Desktop receives, so an agent on
/// another computer reads the same here as on its own.
///
/// This Mac's reading wins only when it is live: a turn running, a question
/// on screen, starting, failed. Its idle, stopped or offline never beats
/// progress the Swarm still vouches for: a Mac that sees a shared machine
/// reads every agent there idle, since no turn is reported to it.
///
/// Lost work is down; needs_human or blocked needs you; in review, or done
/// with its pull request still open, waits (✓); working with its lease
/// unexpired is working, and past it nobody can say (◌); nothing held, idle.
HarnessActivity superTabAgentMark(
  SuperTabController c,
  AppNotifier? app,
  SuperTabAgent agent, {
  required DateTime now,
}) {
  final work = superTabAgentWork(c, agent);
  final status = work?.status;
  if (status == 'lost') return HarnessActivity.offline;
  final local = superTabLocalActivity(app, agent);
  if (local
      case HarnessActivity.needsInput ||
          HarnessActivity.failed ||
          HarnessActivity.starting ||
          HarnessActivity.working) {
    return local!;
  }
  final held = status == 'working' || status == 'planned';
  final lease = work?.leaseUntil;
  if (held && lease != null && lease.isAfter(now)) {
    return HarnessActivity.working;
  }
  if (local case HarnessActivity.paused || HarnessActivity.offline) {
    return local!;
  }
  if (local == null) {
    if (superTabSwarmDown(c, agent, now) case final down?) return down;
  }
  if (superTabWorkWaits(status) ||
      (local == null && agent.alerting.contains('prompt'))) {
    return HarnessActivity.needsInput;
  }
  if (status == 'review' || work?.awaitingMerge == true) {
    return HarnessActivity.done;
  }
  if (local != null) return local;
  // A server without leases says only that the task is held.
  if (held) {
    return lease == null ? HarnessActivity.working : HarnessActivity.unknown;
  }
  if (status == 'reconciling') return HarnessActivity.unknown;
  return HarnessActivity.idle;
}

/// How long since an agent's last progress, shortest: "now", "4m", "2h", "3d".
String superTabAgentAge(Duration age) =>
    age.inMinutes < 1 ? 'now' : superTabAgoShort(age);

/// The activity an agent's words go by (its hover, its details, and the
/// state word when it holds no task), beside its mark. The words read the
/// task itself, so they say Lost, In review or Assigned where the mark only
/// shows a glyph; they claim Working only for a turn running here or
/// progress the Swarm still vouches for, never for a task merely held.
HarnessActivity? superTabAgentWordsActivity(
  SuperTabController c,
  AppNotifier? app,
  SuperTabAgent agent, {
  required DateTime now,
}) {
  final local = superTabLocalActivity(app, agent);
  if (local
      case HarnessActivity.needsInput ||
          HarnessActivity.failed ||
          HarnessActivity.starting) {
    return local;
  }
  final work = superTabAgentWork(c, agent);
  final status = work?.status;
  final lease = work?.leaseUntil;
  if ((status == 'working' || status == 'planned') &&
      lease != null &&
      lease.isAfter(now)) {
    return HarnessActivity.working;
  }
  if (local case HarnessActivity.paused || HarnessActivity.offline) {
    return local;
  }
  if (local == null) {
    if (superTabSwarmDown(c, agent, now) case final down?) return down;
  }
  if (superTabWorkWaits(status)) return HarnessActivity.needsInput;
  return local;
}
