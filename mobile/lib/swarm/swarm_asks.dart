import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// Something the Swarm asks of the reader, wherever it came from: a decision to
/// answer or a Lead's tag.
abstract interface class SwarmAskItem {
  String get id;
  String get projectName;
  String get conversationId;
  String get conversationTitle;
  DateTime? get createdAt;
}

/// One question an agent asked the reader: options, the one it recommends and
/// what an answer unblocks (backend superTabs/decisions.ts). The desktop's
/// `SuperTabDecision` (`desktop/lib/super_tabs/decisions.dart`), field for field.
class SuperTabDecision implements SwarmAskItem {
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
  @override
  final String id, projectName, conversationId, conversationTitle;
  final String batchId, projectId, askerName, question, unblocks;
  final List<String> options;
  final int recommended;

  /// The option the reader chose; null while it is open.
  final int? choice;
  final String? note;
  @override
  final DateTime? createdAt;
}

/// A Lead's tag of the reader in one message (spec 2026-10-24-lead-mentions.md).
/// The desktop's `SuperTabMention` (`desktop/lib/super_tabs/notifications.dart`).
class SuperTabMention implements SwarmAskItem {
  SuperTabMention.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      projectId = row['projectId'] as String? ?? '',
      projectName = row['projectName'] as String? ?? '',
      conversationId = row['conversationId'] as String,
      conversationTitle = row['conversationTitle'] as String? ?? '',
      messageId = row['messageId'] as String,
      leadName = row['leadName'] as String? ?? 'Lead',
      text = row['text'] as String? ?? '',
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      resolvedBy = row['resolvedBy'] as String?;
  @override
  final String id, projectName, conversationId, conversationTitle;
  final String projectId, messageId, leadName, text;
  @override
  final DateTime? createdAt;

  /// `reply` or `done` once it moved to Earlier; null while it waits.
  final String? resolvedBy;
}

/// The reader's open decisions and waiting tags in one Swarm, read from the
/// backend whenever the Swarm's counts move, or the Swarm changes while one
/// waits — the desktop's `SuperTabDecisions` and `SuperTabMentions` in one,
/// open and waiting only: the phone shows what still needs the person.
class SwarmAsks extends ChangeNotifier {
  SwarmAsks(this.reader) {
    reader.addListener(_changed);
    reader.reads.addListener(_retry);
    _changed();
  }

  final SwarmReader reader;
  List<SuperTabDecision> decisions = const [];
  List<SuperTabMention> mentions = const [];
  String? error;

  /// Decisions being answered: their buttons wait for the backend.
  final Set<String> answering = {};

  /// An ask that arrived after the first read: what a phone notice tells.
  void Function(SwarmAskItem item)? onArrived;

  ({int decisions, int mentions})? _counts;
  int _lastChangedAt = -1, _generation = -1;

  // Null until the first read: asks waiting then are not news.
  Set<String>? _seen;
  Future<void>? _loading;
  bool _dirty = false, _failed = false, _disposed = false;

  String get _path => '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}';

  /// An ask can arrive while another is answered, leaving a count as it was,
  /// so any change of the Swarm is read while one waits. With none waiting
  /// and none just answered, nothing is. A Swarm read again from nothing is
  /// read again here too: the reader's access may have moved; and one the
  /// reader may no longer read keeps nothing here.
  void _changed() {
    final snapshot = reader.snapshot;
    if (snapshot == null) {
      if (reader.accessRevoked) _clear();
      return;
    }
    final counts = (
      decisions: snapshot.decisionsWaiting,
      mentions: snapshot.mentionsWaiting,
    );
    final moved = counts != _counts || reader.generation != _generation;
    if (!moved && reader.lastChangedAt == _lastChangedAt) return;
    _lastChangedAt = reader.lastChangedAt;
    _generation = reader.generation;
    _counts = counts;
    if (counts.decisions == 0 && counts.mentions == 0) {
      _seen ??= {};
      if (!moved || (decisions.isEmpty && mentions.isEmpty)) return;
    }
    unawaited(load());
  }

  /// A read that failed is tried again at the Swarm's next read, which tells
  /// nothing when the Swarm stayed as it was.
  void _retry() {
    if (_failed && _loading == null) unawaited(load());
  }

  void _clear() {
    final held = decisions.isNotEmpty || mentions.isNotEmpty || error != null;
    decisions = const [];
    mentions = const [];
    error = null;
    _counts = null;
    _failed = false;
    if (held) notifyListeners();
  }

  /// Joins a read under way, and has it read once more when asked again.
  Future<void> load() {
    if (_disposed || reader.accessRevoked) return Future.value();
    if (_loading case final running?) {
      _dirty = true;
      return running;
    }
    return _loading = () async {
      do {
        _dirty = false;
        await _read();
      } while (_dirty && !_disposed);
    }().whenComplete(() => _loading = null);
  }

  Future<List<Map<String, dynamic>>> _rows(String path, String key) async {
    final Object? answer;
    try {
      answer = await reader.request('GET', '$_path/$path');
    } on SuperTabFailure catch (failure) {
      // A backend from before decisions or tags has no list: nothing to show.
      if (failure.statusCode == 404) return const [];
      rethrow;
    }
    return [
      for (final row in superTabMap(answer)[key] as List) superTabMap(row),
    ];
  }

  Future<void> _read() async {
    // An answer from before the Swarm was read again from nothing, or taken
    // away, may hold asks the reader can no longer see: it is not applied.
    final generation = reader.generation;
    try {
      final [openRows, waitingRows] = await Future.wait([
        _rows('decisions?state=open', 'decisions'),
        _rows('mentions?state=waiting', 'mentions'),
      ]);
      if (_disposed || reader.generation != generation) return;
      decisions = List.unmodifiable(openRows.map(SuperTabDecision.fromJson));
      mentions = List.unmodifiable(waitingRows.map(SuperTabMention.fromJson));
      error = null;
      _failed = false;
      final seen = _seen;
      final now = <SwarmAskItem>[...decisions, ...mentions];
      _seen = {...?seen, for (final ask in now) ask.id};
      if (seen != null) {
        for (final ask in now) {
          if (!seen.contains(ask.id)) onArrived?.call(ask);
        }
      }
    } catch (_) {
      if (_disposed || reader.generation != generation) return;
      error = 'Could not load what is waiting for you. Try again.';
      _failed = true;
    }
    notifyListeners();
  }

  Future<bool> _command(Map<String, dynamic> command) async {
    await reader.request(
      'POST',
      '$_path/commands',
      body: {'operationId': superTabOperationId(), 'command': command},
    );
    return true;
  }

  /// The reader's one-tap answer, sent once. Any reader may answer what was
  /// asked of them, viewers included.
  Future<bool> answer(SuperTabDecision decision, int choice) async {
    if (!answering.add(decision.id)) return false;
    notifyListeners();
    try {
      await _command({
        'type': 'decision.answer',
        'decisionId': decision.id,
        'choice': choice,
      });
    } catch (_) {
      error = 'Could not send your answer. Try again.';
      return false;
    } finally {
      answering.remove(decision.id);
      if (!_disposed) notifyListeners();
    }
    await load();
    unawaited(reader.refresh());
    return true;
  }

  /// The reader is finished with [mention].
  Future<bool> done(SuperTabMention mention) async {
    try {
      await _command({'type': 'mention.done', 'mentionId': mention.id});
    } catch (_) {
      error = 'Could not mark it done. Try again.';
      if (!_disposed) notifyListeners();
      return false;
    }
    await load();
    unawaited(reader.refresh());
    return true;
  }

  @override
  void dispose() {
    _disposed = true;
    reader.removeListener(_changed);
    reader.reads.removeListener(_retry);
    super.dispose();
  }
}
