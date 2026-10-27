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
      recommended = (row['recommended'] as num?)?.toInt() ?? 0,
      unblocks = row['unblocks'] as String? ?? '',
      choice = (row['choice'] as num?)?.toInt(),
      note = row['note'] as String?,
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? '');
  final String id, batchId, projectId, projectName, conversationId;
  final String conversationTitle, askerName, question, unblocks;
  final List<String> options;
  final int recommended;

  /// The option the reader chose; null while it is open.
  final int? choice;
  final String? note;
  final DateTime? createdAt;
}

/// The reader's decisions in one Swarm: open and answered, read from the
/// backend when the open count moves or the reader answers one. Not on every
/// Swarm change: machine readings and messages change it every few seconds,
/// and each read costs the backend a load. One per controller, as the
/// reader's tags are (notifications.dart).
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
  Future<void>? _loading;
  bool _dirty = false;

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  /// The open ones asked in [projectId]'s conversations, for its Chat with PM.
  List<SuperTabDecision> openIn(String projectId) => [
    for (final d in open)
      if (d.projectId == projectId) d,
  ];

  void _changed() {
    final snapshot = controller.snapshot;
    if (snapshot == null) return;
    final count = snapshot.decisionsWaiting;
    if (count == _count) return;
    _count = count;
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
    try {
      final [nextOpen, nextAnswered] = await Future.wait([
        _list('open'),
        _list('answered'),
      ]);
      open = nextOpen;
      answered = nextAnswered;
      error = null;
    } catch (_) {
      error = 'Could not load decisions. Try again.';
    }
    notifyListeners();
  }

  /// The reader's one-tap answer. Any reader may answer what was asked of
  /// them, so this does not wait behind the composer's pending send.
  Future<bool> answer(SuperTabDecision decision, int choice) async {
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
            'choice': choice,
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
