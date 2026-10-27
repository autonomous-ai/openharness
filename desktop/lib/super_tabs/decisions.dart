import 'dart:async';

import 'package:flutter/foundation.dart';

import 'controller.dart';
import 'hands_on.dart';
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
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      remindedAt = DateTime.tryParse(row['remindedAt'] as String? ?? '');
  final String id, batchId, projectId, projectName, conversationId;
  final String conversationTitle, askerName, question, unblocks;
  final List<String> options;
  final int recommended;

  /// The option the reader chose; null while it is open.
  final int? choice;
  final String? note;

  final DateTime? createdAt;

  /// When the backend reminded the reader of it; null until it did.
  final DateTime? remindedAt;
}

/// An open request of the reader's that the backend reminded them of at
/// [at] (ms since the epoch), after 30 minutes unanswered.
typedef SuperTabReminder = ({
  String id,
  int at,
  String askerName,
  String projectName,
  String conversationTitle,
  String text,
});

/// The reader's decisions and hands-on requests in one Swarm: open and
/// answered, read from the backend whenever an open count moves or the Swarm
/// changes while one is open. One per controller, as the reader's tags are
/// (notifications.dart).
class SuperTabDecisions extends ChangeNotifier {
  SuperTabDecisions._(this.controller) {
    controller.addListener(_changed);
    _changed();
  }

  static final _all = Expando<SuperTabDecisions>();
  static SuperTabDecisions of(SuperTabController controller) =>
      _all[controller] ??= SuperTabDecisions._(controller);

  final SuperTabController controller;

  /// Told once each time the backend reminds the reader again while this
  /// Swarm is open; a reminder already there at the first reading is not.
  void Function(SuperTabReminder)? onReminded;
  int? _remindedAt, _reminder;
  bool _remindedRead = false;
  List<SuperTabDecision> open = const [], answered = const [];
  List<SuperTabHandsOn> handsOnOpen = const [], handsOnAnswered = const [];
  String? error;

  /// Decisions and requests being answered: their buttons wait for the
  /// backend.
  final Set<String> answering = {};
  int? _count;
  int _lastChangedAt = -1;
  Future<void>? _loading;
  bool _dirty = false;

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  /// The open ones asked in [projectId]'s conversations, for its Chat with PM.
  List<SuperTabDecision> openIn(String projectId) => [
    for (final d in open)
      if (d.projectId == projectId) d,
  ];

  /// The open hands-on requests asked in [projectId]'s conversations.
  List<SuperTabHandsOn> handsOnIn(String projectId) => [
    for (final r in handsOnOpen)
      if (r.projectId == projectId) r,
  ];

  void _changed() {
    final snapshot = controller.snapshot;
    if (snapshot == null) return;
    final reminded = snapshot.requestRemindedAt;
    if (_remindedRead && reminded != null && reminded != _remindedAt) {
      _reminder = reminded;
      unawaited(load());
    }
    _remindedRead = true;
    _remindedAt = reminded;
    final count = snapshot.decisionsWaiting + snapshot.handsOnWaiting;
    final moved = count != _count;
    if (!moved && controller.lastChangedAt == _lastChangedAt) return;
    _lastChangedAt = controller.lastChangedAt;
    _count = count;
    // Nothing open and nothing just answered: an idle Swarm reads nothing.
    if (count == 0 && !moved) return;
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

  Future<List<T>> _list<T>(
    String state,
    String kind,
    T Function(Map<String, dynamic>) read,
  ) async {
    final Map<String, dynamic> answer;
    try {
      answer = await controller.request(
        'GET',
        // Decisions are the default kind, and a backend from before hands-on
        // requests refuses any kind at all.
        '$_path/decisions?state=$state${kind == 'handsOn' ? '&kind=$kind' : ''}',
      );
    } on SuperTabFailure catch (failure) {
      // A backend from before decisions has no list, and one from before
      // hands-on requests refuses the kind: there is nothing to show.
      if (failure.statusCode == 404 ||
          (kind == 'handsOn' && failure.statusCode == 400)) {
        return const [];
      }
      rethrow;
    }
    return List.unmodifiable([
      for (final row
          in answer[kind == 'handsOn' ? 'handsOn' : 'decisions'] as List)
        read(superTabMap(row)),
    ]);
  }

  Future<void> _read() async {
    try {
      final (
        decisionsOpen,
        decisionsAnswered,
        requestsOpen,
        requestsAnswered,
      ) = await (
        _list('open', 'decision', SuperTabDecision.fromJson),
        _list('answered', 'decision', SuperTabDecision.fromJson),
        _list('open', 'handsOn', SuperTabHandsOn.fromJson),
        _list('answered', 'handsOn', SuperTabHandsOn.fromJson),
      ).wait;
      open = decisionsOpen;
      answered = decisionsAnswered;
      handsOnOpen = requestsOpen;
      handsOnAnswered = requestsAnswered;
      error = null;
      _remind();
    } catch (_) {
      error = 'Could not load decisions. Try again.';
    }
    notifyListeners();
  }

  /// Tells [onReminded] of the open request reminded last, once per move.
  void _remind() {
    final at = _reminder;
    if (at == null) return;
    _reminder = null;
    final reminders = <SuperTabReminder>[
      for (final r in handsOnOpen)
        if (r.remindedAt case final reminded?)
          (
            id: r.id,
            at: reminded.millisecondsSinceEpoch,
            askerName: r.askerName,
            projectName: r.projectName,
            conversationTitle: r.conversationTitle,
            text: r.request,
          ),
      for (final d in open)
        if (d.remindedAt case final reminded?)
          (
            id: d.id,
            at: reminded.millisecondsSinceEpoch,
            askerName: d.askerName,
            projectName: d.projectName,
            conversationTitle: d.conversationTitle,
            text: d.question,
          ),
    ]..sort((a, b) => b.at.compareTo(a.at));
    if (reminders.firstOrNull case final latest?) onReminded?.call(latest);
  }

  /// The reader's one-tap answer. Any reader may answer what was asked of
  /// them, so this does not wait behind the composer's pending send.
  Future<bool> answer(SuperTabDecision decision, int choice) => _send(
    decision.id,
    {'type': 'decision.answer', 'decisionId': decision.id, 'choice': choice},
  );

  /// The reader's answer to a hands-on request: a note is required with
  /// [SuperTabHandsOnAnswer.note], and [until] goes only with "can't now".
  Future<bool> answerHandsOn(
    SuperTabHandsOn request,
    SuperTabHandsOnAnswer answer, {
    String? note,
    DateTime? until,
  }) => _send(request.id, {
    'type': 'handsOn.answer',
    'requestId': request.id,
    'answer': answer.name,
    if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    if (until != null && answer == SuperTabHandsOnAnswer.cant)
      'until': until.toUtc().toIso8601String(),
  });

  Future<bool> _send(String id, Map<String, dynamic> command) async {
    answering.add(id);
    notifyListeners();
    try {
      await controller.request(
        'POST',
        '$_path/commands',
        body: {'operationId': superTabOperationId(), 'command': command},
      );
    } catch (_) {
      error = 'Could not send your answer. Try again.';
      return false;
    } finally {
      answering.remove(id);
      notifyListeners();
    }
    await load();
    unawaited(controller.refresh());
    return true;
  }
}
