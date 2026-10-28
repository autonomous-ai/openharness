import 'dart:async';

import 'package:flutter/foundation.dart';

import 'controller.dart';
import 'model.dart';

/// One question an agent asked the reader: options, the one it recommends and
/// what an answer unblocks (backend superTabs/decisions.ts).
class SuperTabDecision {
  SuperTabDecision.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      batchId = row['batchId'] as String? ?? row['id'] as String,
      projectId = row['projectId'] as String? ?? '',
      projectName = row['projectName'] as String? ?? '',
      conversationId = row['conversationId'] as String,
      conversationTitle = row['conversationTitle'] as String? ?? '',
      askerName = row['askerName'] as String? ?? 'Agent',
      question = row['question'] as String? ?? '',
      options = List.unmodifiable([
        for (final option in row['options'] as List? ?? const []) '$option',
      ]),
      recommended = (row['recommended'] as num?)?.toInt(),
      unblocks = row['unblocks'] as String? ?? '',
      choice = (row['choice'] as num?)?.toInt(),
      delegated = row['delegated'] == true,
      note = row['note'] as String?,
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? '');
  final String id, batchId, projectId, projectName, conversationId;
  final String conversationTitle, askerName, question, unblocks;
  final List<String> options;

  /// The option the asker recommends; null, or not one of [options], when it
  /// recommends none.
  final int? recommended;

  /// Whether Let PM decide can answer it: only with a recommended option.
  bool get canDelegate {
    final r = recommended;
    return r != null && r >= 0 && r < options.length;
  }

  /// The option the reader chose, or the PM chose for them ([delegated]);
  /// null while it is open.
  final int? choice;

  /// The reader left it to the PM, who took the recommended option.
  final bool delegated;
  final String? note;
  final DateTime? createdAt;
}

/// The reader's decisions in one Swarm: open and answered, read from the
/// backend when the open ones change (their digest, or the count from a
/// backend before it), when who may read what changes, and when the reader
/// answers one. Not on every Swarm change: machine readings and messages change
/// it every few seconds, and each read costs the backend a load. One per
/// controller, as the reader's tags are (notifications.dart).
class SuperTabDecisions extends ChangeNotifier {
  SuperTabDecisions._(this.controller) {
    controller.addListener(_changed);
    _changed();
  }

  static final _all = Expando<SuperTabDecisions>();
  static SuperTabDecisions of(SuperTabController controller) =>
      _all[controller] ??= SuperTabDecisions._(controller);

  final SuperTabController controller;
  List<SuperTabDecision> open = const [], answered = const [];
  String? error;

  /// Decisions being answered: their buttons wait for the backend.
  final Set<String> answering = {};
  int? _count;
  String? _digest;
  int? _epoch;
  // The Swarm change a failed read saw: the next one tries again.
  int? _failedAt;
  Future<void>? _loading;
  bool _dirty = false;

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  /// The open ones asked in [projectId]'s conversations, for its Chat with PM.
  List<SuperTabDecision> openIn(String projectId) => [
    for (final d in open)
      if (d.projectId == projectId) d,
  ];

  /// Those of [openIn] the reader has not set aside with Not now or Hide.
  List<SuperTabDecision> shownIn(String projectId) {
    final aside = controller.decisionsAside;
    return [
      for (final d in openIn(projectId))
        if (!aside.contains(d.id)) d,
    ];
  }

  /// Not now and Hide: folded in Chat with PM until the reader shows them
  /// again; a decision asked later still shows.
  void setAside(Iterable<SuperTabDecision> decisions) =>
      controller.setDecisionsAside(decisions.map((d) => d.id), aside: true);

  /// Show: every open decision of [projectId] in its Chat with PM again.
  void showAgain(String projectId) => controller.setDecisionsAside(
    openIn(projectId).map((d) => d.id),
    aside: false,
  );

  void _changed() {
    final snapshot = controller.snapshot;
    if (snapshot == null) return;
    final epoch = controller.visibilityEpoch;
    if (epoch != null && epoch != _epoch) {
      // Who may read what changed: nothing read before shows until read again
      // (review of #1820), even while the count stays.
      if (_epoch != null && (open.isNotEmpty || answered.isNotEmpty)) {
        open = answered = const [];
        notifyListeners();
      }
      _epoch = epoch;
    } else if (snapshot.decisionsWaiting == _count &&
        snapshot.decisionsDigest == _digest &&
        (_failedAt == null || _failedAt == controller.lastChangedAt)) {
      return;
    }
    _count = snapshot.decisionsWaiting;
    _digest = snapshot.decisionsDigest;
    unawaited(load());
  }

  /// Joins a read under way, and has it read once more when asked again.
  Future<void> load() {
    if (_loading case final running?) {
      _dirty = true;
      return running;
    }
    return _loading = () async {
      do {
        _dirty = false;
        await _read();
      } while (_dirty);
    }().whenComplete(() => _loading = null);
  }

  Future<List<SuperTabDecision>> _list(String state) async {
    final Map<String, dynamic> answer;
    try {
      answer = await controller.request('GET', '$_path/decisions?state=$state');
    } on SuperTabFailure catch (failure) {
      // A backend from before decisions has no list: there is nothing to show.
      if (failure.statusCode == 404) return const [];
      rethrow;
    }
    return List.unmodifiable([
      for (final row in answer['decisions'] as List)
        SuperTabDecision.fromJson(superTabMap(row)),
    ]);
  }

  Future<void> _read() async {
    final epoch = _epoch;
    try {
      final [nextOpen, nextAnswered] = await Future.wait([
        _list('open'),
        _list('answered'),
      ]);
      // Read before who may read what changed: the read asked again since
      // replaces it.
      if (epoch != _epoch) return;
      open = nextOpen;
      answered = nextAnswered;
      controller.keepDecisionsAside({for (final d in open) d.id});
      error = null;
      _failedAt = null;
    } catch (_) {
      error = 'Could not load decisions. Try again.';
      _failedAt = controller.lastChangedAt;
    }
    notifyListeners();
  }

  /// The reader's one-tap answer. Any reader may answer what was asked of
  /// them, so this does not wait behind the composer's pending send.
  Future<bool> answer(SuperTabDecision decision, int choice) =>
      _answer(decision, {'choice': choice});

  /// Let PM decide: the backend answers with the recommended option on the
  /// reader's behalf, recorded as the PM's choice, never as theirs.
  Future<bool> delegate(SuperTabDecision decision) =>
      _answer(decision, {'delegate': true});

  Future<bool> _answer(
    SuperTabDecision decision,
    Map<String, dynamic> answer,
  ) async {
    answering.add(decision.id);
    notifyListeners();
    try {
      await controller.request(
        'POST',
        '$_path/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'decision.answer',
            'decisionId': decision.id,
            ...answer,
          },
        },
      );
    } catch (_) {
      error = 'Could not send your answer. Try again.';
      return false;
    } finally {
      answering.remove(decision.id);
      notifyListeners();
    }
    await load();
    unawaited(controller.refresh());
    return true;
  }
}
