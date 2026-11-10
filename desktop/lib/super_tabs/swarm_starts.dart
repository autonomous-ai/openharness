import 'dart:async';

import 'package:flutter/foundation.dart';

import '../state/new_harness.dart';

/// A Swarm's New Project or New Agent whose form closed once it was under way (anh Dee, 2026-11-10: "as soon as i hit new
/// project or new agent, just get me back to my main screen ... NEVER block users for minutes"). Its row in the left pane
/// says `starting` until it is done, when the project's or the agent's own row takes its place, or `failed`, whose click
/// opens its form again with why.
class SwarmStart {
  SwarmStart._(this.tabId, this.form, {required this.project});

  /// The Swarm it starts in.
  final String tabId;

  /// New Project's, else an agent's.
  final bool project;

  /// Its form, closed: it holds the start, and opens again on it.
  final NewHarnessController form;

  bool get failed => _failed;
  bool _failed = false;

  /// Its row's name: a project's repository, an agent's name once it has one.
  String get name => project
      ? form.leadRepositoryName ?? 'New project'
      : form.integration?.name ?? 'New agent';

  /// The project it made, whose own row it stands in for while it starts.
  String? get projectId => form.integration?.projectId;

  /// A private project's: its row keeps the lock.
  bool get isPrivate => form.integration?.projectVisibility == 'private';

  /// One per start: its row's key.
  String get id => form.integration?.creationId ?? '${identityHashCode(this)}';
}

/// The starts going on without their forms, the app's ([AppNotifier.swarmStarts]).
class SwarmStarts extends ChangeNotifier {
  final _starts = <SwarmStart>[];
  bool _disposed = false;

  List<SwarmStart> of(String tabId) => [
    for (final start in _starts)
      if (start.tabId == tabId) start,
  ];

  /// [form]'s start goes on here until it is done or fails.
  void add(String tabId, NewHarnessController form, {required bool project}) {
    if (_disposed || _starts.any((start) => start.form == form)) return;
    final start = SwarmStart._(tabId, form, project: project);
    _starts.add(start);
    notifyListeners();
    unawaited(_finish(start));
  }

  Future<void> _finish(SwarmStart start) async {
    final form = start.form;
    var outcome =
        await (form.running ?? Future.value(NewHarnessOutcome.failed));
    // A request its machine holds (an engine installing, a model waking) ends by itself: asked after, as an open form does.
    while (outcome == NewHarnessOutcome.failed && form.canFollowPending) {
      await Future<void>.delayed(NewHarnessController.heldFollowInterval);
      if (!_starts.contains(start)) return;
      outcome = await form.followHeld();
    }
    if (!_starts.contains(start)) return;
    if (outcome == NewHarnessOutcome.created) {
      _starts.remove(start);
      form.dispose();
    } else {
      start._failed = true;
    }
    notifyListeners();
  }

  /// A start of [tabId]'s that failed, of the kind New Project ([project]) or New Agent opens, for its form to show again:
  /// it leaves the list, and the form's Try again hands it back.
  NewHarnessController? takeFailed(String tabId, {required bool project}) {
    final start = _starts
        .where((s) => s.tabId == tabId && s.project == project && s.failed)
        .firstOrNull;
    if (start == null) return null;
    _starts.remove(start);
    notifyListeners();
    return start.form;
  }

  @override
  void dispose() {
    _disposed = true;
    for (final start in _starts) {
      start.form.dispose();
    }
    _starts.clear();
    super.dispose();
  }
}
