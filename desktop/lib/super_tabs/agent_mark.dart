import 'dart:math' as math;

import '../state/app_state.dart';
import '../state/harness_activity.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';

/// How long progress holds a task, and how long a session its machine lists
/// as running may go without a screen change and still renew it: the
/// backend's LEASE_MS and QUIET_RUNNING_MS - LEASE_MS (superTabs/liveness.ts).
/// The Swarm stores only the lease an agent's own posts set; the renewal its
/// machine's reports give is never written into the task, so it is worked out
/// here from the reports every Desktop receives.
const _lease = Duration(minutes: 5);
const _quietRunning = Duration(minutes: 25);

/// A hand-off from an agent on the older built-in skills: a result saying it is
/// ready for review and naming a revision. The backend holds such work as
/// waiting for review in every project while those agents exist; Desktop
/// reads it only in a project without instructions ([superTabReadsHandoff]).
/// A copy of READY_FOR_REVIEW and REVISION in backend/src/superTabs/liveness.ts
/// (waitingForReview): change both together.
final _readyForReview = RegExp(r'\bready for review\b', caseSensitive: false);
final _revision = RegExp(
  r'(?:@|\b(?:at|head)\s+)[0-9a-f]{7,40}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b',
  caseSensitive: false,
);

/// The work an agent's row talks about: a question it waits on, its current
/// task, or a finished one whose pull request has not merged yet. Only a group
/// the viewer reads.
class SuperTabAgentWork {
  const SuperTabAgentWork(
    this.group, {
    this.awaitingMerge = false,
    this.readsHandoff = true,
  });
  final SuperTabConversation group;

  /// Whether a result saying "ready for review" is a hand-off: only in a
  /// project without instructions ([superTabReadsHandoff]).
  final bool readsHandoff;

  /// Done, with its pull request still open: the agent waits on its merge.
  final bool awaitingMerge;

  Map<String, dynamic>? get _assignment => group.assignment;
  String? get status => _assignment?['status'] as String?;

  /// Working, but handed over for review: the Swarm holds it without progress
  /// until a review finds problems in it (liveness.ts waitingForReview).
  bool get handedOver {
    final result = _assignment?['result'];
    return readsHandoff &&
        status == 'working' &&
        _assignment?['reviewFoundAt'] == null &&
        result is String &&
        _readyForReview.hasMatch(result) &&
        _revision.hasMatch(result);
  }

  /// When the agent last reported progress on it (backend assignment.progressAt).
  DateTime? get progressAt => _time(_assignment?['progressAt']);

  /// Until when its own last post holds it (backend assignment.leaseUntil).
  DateTime? get leaseUntil => _time(_assignment?['leaseUntil']);

  static DateTime? _time(Object? ms) =>
      ms is num ? DateTime.fromMillisecondsSinceEpoch(ms.toInt()) : null;
}

/// Whether [group]'s project predates instructions, where a result saying it
/// is ready for review still hands the work over.
bool superTabReadsHandoff(SuperTabController c, SuperTabConversation group) =>
    c.snapshot?.projectFor(group.id)?.hasInstructions != true;

/// Whether the viewer reads [group]: never a Buddy chat, and a private group
/// only when its people include them. The server sends no other; this keeps a
/// task, its title and a click to it away if one ever arrived.
bool superTabGroupReadable(SuperTabController c, SuperTabConversation group) =>
    !group.isBuddyChat &&
    (group.audience == null || group.audience!.contains(c.accountId));

/// [agent]'s work, and its current task (for the Swarm's word on its start).
({SuperTabAgentWork? work, SuperTabConversation? task}) _workOf(
  SuperTabController c,
  SuperTabAgent agent,
) {
  final groups = [
    for (final g in c.snapshot?.conversations ?? const <SuperTabConversation>[])
      if (!g.closed &&
          g.assignment?['agentId'] == agent.id &&
          superTabGroupReadable(c, g))
        g,
  ];
  final task = SuperTabAgentInfo(c, null, agent).taskGroup;
  // A question waiting on a person comes first, from whichever of its open
  // groups asks it: that is where its row's click goes.
  if (groups
          .where((g) => superTabWorkWaits(g.assignment?['status']))
          .firstOrNull
      case final asking?) {
    return (
      work: SuperTabAgentWork(
        asking,
        readsHandoff: superTabReadsHandoff(c, asking),
      ),
      task: task,
    );
  }
  if (task != null) {
    return (
      work: SuperTabAgentWork(
        task,
        readsHandoff: superTabReadsHandoff(c, task),
      ),
      task: task,
    );
  }
  final merging = groups
      .where(
        (g) =>
            g.assignment?['status'] == 'done' &&
            g.cards.pullRequests.isNotEmpty &&
            !g.cards.pullRequests.any((pr) => pr.merged),
      )
      .firstOrNull;
  return (
    work: merging == null
        ? null
        : SuperTabAgentWork(merging, awaitingMerge: true),
    task: null,
  );
}

/// This Mac's own reading of the agent; null when it has none, or reads its
/// status as unknown.
HarnessActivity? superTabLocalActivity(AppNotifier? app, SuperTabAgent agent) {
  final local = app == null
      ? null
      : harnessActivity(app, agent.machineId, agent.harnessId);
  return local == HarnessActivity.unknown ? null : local;
}

Map<String, dynamic>? _report(SuperTabController c, SuperTabAgent agent) =>
    switch (c.snapshot?.pool(agent.machineId)?['observation']) {
      final Map report => report.cast<String, dynamic>(),
      _ => null,
    };

/// When the agent's task stops being held (liveness.ts leaseEnd): its own
/// last post's lease, or 5 minutes after its machine last renewed it, by
/// listing it running with a screen change in the last 25 minutes,
/// whichever is later. Null when nothing ever renewed it.
DateTime? superTabLeaseEnd(
  SuperTabController c,
  SuperTabAgent agent,
  SuperTabAgentWork work,
) {
  final own = work.leaseUntil;
  final report = _report(c, agent);
  final received = report?['receivedAt'];
  DateTime? renewed;
  if (report != null && received is num) {
    final running = report['runningHarnessIds'];
    final progress = report['harnessProgress'];
    if (running is! List) {
      // A report that lists no sessions says nothing about this one.
    } else if (!running.contains(agent.harnessId)) {
      // Not listed running: it last renewed when it went down.
      renewed = agent.downSince;
    } else if (progress is! Map) {
      renewed = DateTime.fromMillisecondsSinceEpoch(received.toInt());
    } else if (progress[agent.harnessId] case final num at) {
      renewed = DateTime.fromMillisecondsSinceEpoch(
        math.min(received.toInt(), at.toInt() + _quietRunning.inMilliseconds),
      );
    }
  }
  final reported = renewed?.add(_lease);
  if (own == null) return reported;
  if (reported == null) return own;
  return own.isAfter(reported) ? own : reported;
}

/// What the Swarm knows of an agent this Mac cannot see that stops it
/// running (Dee, 2026-10-29): its computer silent, offline; its session
/// stopped; its start failed. Null when none is known. While the Swarm
/// cannot be read, its computers are not called offline.
HarnessActivity? superTabSwarmDown(
  SuperTabController c,
  SuperTabAgent agent,
  SuperTabConversation? task,
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
  return task?.liveness?['state'] == 'orphaned' &&
          task?.liveness?['why'] == 'start-failed'
      ? HarnessActivity.failed
      : null;
}

/// An agent as its row shows it: its [work], its [mark], and the activity
/// its [words] go by.
class SuperTabAgentState {
  const SuperTabAgentState({
    required this.work,
    required this.mark,
    required this.words,
  });
  final SuperTabAgentWork? work;

  /// The mark its row shows, and the order it takes (Dee, 2026-10-30).
  final HarnessActivity mark;

  /// The activity its hover, its details, and its state word when it holds
  /// no task go by. They read the task itself, so they say Lost, In review
  /// or Assigned where the mark only shows a glyph, and claim Working only
  /// for a turn running here or a task the Swarm still holds.
  final HarnessActivity? words;
}

/// [agent]'s state, worked out once per build, at [now] by the Swarm's clock
/// ([superTabServerNow]).
///
/// The Swarm's state comes first, since every Desktop receives it, so an
/// agent on another computer reads the same here as on its own. This Mac's
/// reading wins only when it is live: a turn running, a question on screen,
/// starting, failed. Unseen here, the Swarm's word that it stopped comes
/// next. This Mac's idle, stopped or offline never beats a task the Swarm
/// still holds: a Mac that sees a shared machine reads every agent there
/// idle, since no turn is reported to it.
///
/// Lost work is down; needs_human or blocked needs you; in review, handed
/// over, or done with its pull request still open, waits (✓); held is
/// working, and past its lease nobody can say (◌); nothing held, idle.
SuperTabAgentState superTabAgentState(
  SuperTabController c,
  AppNotifier? app,
  SuperTabAgent agent, {
  required DateTime now,
}) {
  final (:work, :task) = _workOf(c, agent);
  final status = work?.status;
  final local = superTabLocalActivity(app, agent);
  final down = local == null ? superTabSwarmDown(c, agent, task, now) : null;
  final held = status == 'working' || status == 'planned';
  final handedOver = work?.handedOver == true;
  final end = work == null ? null : superTabLeaseEnd(c, agent, work);
  final holding = held && !handedOver && end != null && end.isAfter(now);

  HarnessActivity? words() {
    if (local
        case HarnessActivity.needsInput ||
            HarnessActivity.failed ||
            HarnessActivity.starting) {
      return local;
    }
    if (down != null) return down;
    if (holding) return HarnessActivity.working;
    if (local case HarnessActivity.paused || HarnessActivity.offline) {
      return local;
    }
    if (superTabWorkWaits(status)) return HarnessActivity.needsInput;
    return local;
  }

  HarnessActivity mark() {
    if (status == 'lost') return HarnessActivity.offline;
    if (local
        case HarnessActivity.needsInput ||
            HarnessActivity.failed ||
            HarnessActivity.starting ||
            HarnessActivity.working) {
      return local!;
    }
    if (down != null) return down;
    if (holding) return HarnessActivity.working;
    if (local case HarnessActivity.paused || HarnessActivity.offline) {
      return local!;
    }
    if (superTabWorkWaits(status) ||
        (local == null && agent.alerting.contains('prompt'))) {
      return HarnessActivity.needsInput;
    }
    if (status == 'review' || handedOver || work?.awaitingMerge == true) {
      return HarnessActivity.done;
    }
    // Held past its lease: nobody vouches for it, whatever this Mac reads.
    // A server without leases says only that the task is held.
    if (held) {
      return end == null
          ? local ?? HarnessActivity.working
          : HarnessActivity.unknown;
    }
    if (status == 'reconciling') return local ?? HarnessActivity.unknown;
    return local ?? HarnessActivity.idle;
  }

  return SuperTabAgentState(work: work, mark: mark(), words: words());
}

/// How long since an agent's last progress, shortest: "now", "4m", "2h", "3d".
String superTabAgentAge(Duration age) =>
    age.inMinutes < 1 ? 'now' : superTabAgoShort(age);

/// The Swarm's clock, as far as its machines' reports tell it.
class _ServerClock {
  int? _evidence;
  final _samples = <({DateTime at, Duration offset})>[];
}

final _clocks = Expando<_ServerClock>();

/// How long a reading of the Swarm's clock counts: past it, with no new
/// report from any machine, this Mac's own clock is used again.
const _clockWindow = Duration(minutes: 10);

/// [local] by the Swarm's clock, so a Mac whose clock runs fast or slow
/// reads leases and ages as the Swarm does (review of #2281). Each machine
/// report is stamped by the server on arrival, every few seconds, so a report
/// newer than the last one seen is no later than the server's now: each such
/// reading is a lower bound of the offset, and the largest of the last 10
/// minutes is the best. Until one arrives, this Mac's own clock is used.
DateTime superTabServerNow(SuperTabController c, DateTime local) {
  final clock = _clocks[c] ??= _ServerClock();
  int? newest;
  for (final machine in c.snapshot?.machines ?? const <Map>[]) {
    if (machine['observation'] case {'receivedAt': final num at}) {
      newest = math.max(newest ?? 0, at.toInt());
    }
  }
  // The first report read may be hours old (every machine silent): it is
  // only a baseline. A newer one arrived since, so it is fresh.
  if (newest != null) {
    final before = clock._evidence;
    if (before == null || newest < before) {
      clock._evidence = newest;
    } else if (newest > before) {
      clock._evidence = newest;
      clock._samples.add((
        at: local,
        offset: DateTime.fromMillisecondsSinceEpoch(newest).difference(local),
      ));
    }
  }
  clock._samples.removeWhere(
    (s) => local.difference(s.at) > _clockWindow || s.at.isAfter(local),
  );
  if (clock._samples.isEmpty) return local;
  return local.add(
    clock._samples.map((s) => s.offset).reduce((a, b) => a > b ? a : b),
  );
}
