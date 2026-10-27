import 'dart:async';

import 'package:collection/collection.dart' show DeepCollectionEquality;
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
    reader.reads.addListener(_swarmRead);
    reader.firstLoads.addListener(_loadAsked);
    _changed();
  }

  final SwarmReader reader;
  List<SuperTabDecision> decisions = const [];
  List<SuperTabMention> mentions = const [];
  String? error;

  /// What waits for the person here is not read yet since the Swarm was last
  /// read from nothing: Home shows its skeleton meanwhile, never a false
  /// "Nothing needs you". False once that read answers, either way; when the
  /// Swarm's counts say nothing waits; when the Swarm itself could not be
  /// read; and when the reader may no longer read it.
  bool get loading =>
      !reader.accessRevoked &&
      !reader.updateRequired &&
      !(reader.snapshot == null && reader.error != null) &&
      _settled != reader.generation;

  /// The [SwarmReader.generation] whose asks were read, or need none.
  int _settled = -1;

  /// Decisions being answered: their buttons wait for the backend.
  final Set<String> answering = {};

  /// Answers sent whose reply never came, by decision: sent again under the
  /// same receipt and choice until one is confirmed, so the backend applies
  /// the answer once and no other is offered meanwhile.
  final _unconfirmed = <String, ({String operationId, int choice})>{};

  /// Tags being marked done, tags whose Done failed (with what to say on
  /// them), and tags confirmed done that a list read before then may still
  /// hold: a Done shows the moment it is tapped, and the tag goes the moment
  /// it is confirmed, not at the next read — on the owner's iPhone
  /// (2026-10-27) it took 10 seconds, with no sign the tap counted.
  final _finishing = <String>{}, _done = <String>{};
  final _notDone = <String, String>{};

  /// [mention] is being marked done.
  bool finishing(SuperTabMention mention) => _finishing.contains(mention.id);

  /// What to say on [mention] after its Done failed; null otherwise.
  String? notDone(SuperTabMention mention) => _notDone[mention.id];

  /// The option sent for [decision] and not confirmed: [answer] sends it
  /// again.
  int? unconfirmed(SuperTabDecision decision) =>
      _unconfirmed[decision.id]?.choice;

  /// An ask that arrived after the first read: what a phone notice tells.
  void Function(SwarmAskItem item)? onArrived;

  ({int decisions, int mentions})? _counts;

  /// The rows [decisions] and [mentions] were made from: a read answering the
  /// same keeps them as they are, and tells nobody.
  List<Map<String, dynamic>> _openRows = const [], _waitingRows = const [];
  static const _same = DeepCollectionEquality();
  int _lastChangedAt = -1, _generation = -1;

  /// The lists asked for alongside a first load ([SwarmReader.firstLoads]),
  /// so they need not wait behind it: used for the Swarm that load reads, and
  /// for no other.
  ({int load, Future<List<List<Map<String, dynamic>>>> rows})? _along;

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
    final reloaded = reader.generation != _generation;
    final along = _along;
    if (reloaded) _along = null;
    final moved = counts != _counts || reloaded;
    if (!moved && reader.lastChangedAt == _lastChangedAt) return;
    _lastChangedAt = reader.lastChangedAt;
    _generation = reader.generation;
    _counts = counts;
    // What was read before may be of chats the reader can no longer see:
    // none of it stays while the new read runs, nor if that read fails.
    if (reloaded && (decisions.isNotEmpty || mentions.isNotEmpty)) {
      _empty();
      notifyListeners();
    }
    if (counts.decisions == 0 && counts.mentions == 0) {
      _seen ??= {};
      if (!moved || (decisions.isEmpty && mentions.isEmpty)) return _settle();
    }
    final rows = reloaded && along?.load == reader.heldLoad ? along : null;
    unawaited(load(along: rows?.rows));
  }

  /// A first load is asked for: the lists are asked with it.
  void _loadAsked() {
    if (_disposed || reader.accessRevoked) return;
    final rows = _fetch()..ignore();
    _along = (load: reader.firstLoads.value, rows: rows);
  }

  /// Nothing to read for the Swarm as it is: [loading] ends.
  void _settle() {
    if (_settled == reader.generation) return;
    _settled = reader.generation;
    notifyListeners();
  }

  /// Each read of the Swarm, changed or not: a move of its last-change time
  /// alone tells only here ([SwarmReader.lastChangedAt]), and a read that
  /// failed is tried again, as the Swarm staying as it was tells nothing.
  void _swarmRead() {
    _changed();
    if (_failed && _loading == null) unawaited(load());
  }

  void _clear() {
    final held = decisions.isNotEmpty || mentions.isNotEmpty || error != null;
    _empty();
    error = null;
    _unconfirmed.clear();
    _done.clear();
    _notDone.clear();
    _counts = null;
    _failed = false;
    if (held) notifyListeners();
  }

  void _empty() {
    decisions = const [];
    mentions = const [];
    _openRows = _waitingRows = const [];
  }

  /// Joins a read under way, and has it read once more when asked again.
  /// [along] is what was read alongside the Swarm's first load, used in
  /// place of a first read of the lists.
  Future<void> load({Future<List<List<Map<String, dynamic>>>>? along}) {
    if (_disposed || reader.accessRevoked) return Future.value();
    if (_loading case final running?) {
      _dirty = true;
      return running;
    }
    return _loading = () async {
      var rows = along;
      do {
        _dirty = false;
        if (!await _read(rows)) _dirty = true;
        rows = null;
      } while (_dirty && !_disposed);
    }().whenComplete(() => _loading = null);
  }

  Future<List<List<Map<String, dynamic>>>> _fetch() => Future.wait([
    _rows('decisions?state=open', 'decisions'),
    _rows('mentions?state=waiting', 'mentions'),
  ]);

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

  /// False when lists read [along] a first load disagree with its counts:
  /// something moved between the two answers, so they are read again.
  Future<bool> _read(Future<List<List<Map<String, dynamic>>>>? along) async {
    // An answer from before the Swarm was read again from nothing, or taken
    // away, may hold asks the reader can no longer see: it is not applied.
    final generation = reader.generation;
    final counts = _counts;
    try {
      final [openRows, waitingRows] = await (along ?? _fetch());
      if (_disposed || reader.generation != generation) return true;
      if (along != null &&
          (openRows.length != counts?.decisions ||
              waitingRows.length != counts?.mentions)) {
        return false;
      }
      final waitingIds = {for (final row in waitingRows) row['id']};
      // Done here and no longer waiting there: the backend caught up.
      _done.removeWhere((id) => !waitingIds.contains(id));
      final notDone = _notDone.length;
      _notDone.removeWhere((id, _) => !waitingIds.contains(id));
      final waiting = [
        for (final row in waitingRows)
          if (!_done.contains(row['id'])) row,
      ];
      var changed =
          error != null || notDone != _notDone.length || _settled != generation;
      _settled = generation;
      if (!_same.equals(openRows, _openRows)) {
        _openRows = openRows;
        decisions = List.unmodifiable(openRows.map(SuperTabDecision.fromJson));
        changed = true;
      }
      if (!_same.equals(waiting, _waitingRows)) {
        _waitingRows = waiting;
        mentions = List.unmodifiable(waiting.map(SuperTabMention.fromJson));
        changed = true;
      }
      error = null;
      _failed = false;
      // No longer open: answered, by this answer or another.
      _unconfirmed.removeWhere((id, _) => !decisions.any((d) => d.id == id));
      final seen = _seen;
      final now = <SwarmAskItem>[...decisions, ...mentions];
      _seen = {...?seen, for (final ask in now) ask.id};
      if (seen != null) {
        for (final ask in now) {
          if (!seen.contains(ask.id)) onArrived?.call(ask);
        }
      }
      if (changed) notifyListeners();
    } catch (_) {
      if (_disposed || reader.generation != generation) return true;
      const failed = 'Could not load what is waiting for you. Try again.';
      final told = error == failed && _failed && _settled == generation;
      error = failed;
      _failed = true;
      _settled = generation;
      if (!told) notifyListeners();
    }
    return true;
  }

  Future<void> _command(Map<String, dynamic> command, {String? operationId}) =>
      reader.request(
        'POST',
        '$_path/commands',
        body: {
          'operationId': operationId ?? superTabOperationId(),
          'command': command,
        },
      );

  /// The reader's one-tap answer, sent once. Any reader may answer what was
  /// asked of them, viewers included. An answer not confirmed is sent again
  /// as it was, whatever [choice] says; a decision the backend has answered
  /// already (by this answer, its reply lost, or another device) is read
  /// back.
  Future<bool> answer(SuperTabDecision decision, int choice) async {
    if (_disposed || !answering.add(decision.id)) return false;
    final sent = _unconfirmed[decision.id] ??= (
      operationId: superTabOperationId(),
      choice: choice,
    );
    notifyListeners();
    try {
      await _command({
        'type': 'decision.answer',
        'decisionId': decision.id,
        'choice': sent.choice,
      }, operationId: sent.operationId);
    } on SuperTabFailure catch (failure) {
      if (failure.code != 'DECISION_ANSWERED') {
        // A definitive refusal changed nothing: another answer may be sent.
        // A lost reply keeps its receipt, so a retry is the same answer.
        final status = failure.statusCode;
        final refused =
            status >= 400 && status < 500 && status != 408 && status != 429;
        if (refused) _unconfirmed.remove(decision.id);
        error = refused
            ? failure.message
            : 'Could not send your answer. Try again.';
        return false;
      }
    } catch (_) {
      error = 'Could not send your answer. Try again.';
      return false;
    } finally {
      answering.remove(decision.id);
      if (!_disposed) notifyListeners();
    }
    _unconfirmed.remove(decision.id);
    error = null;
    await load();
    unawaited(reader.refresh());
    return true;
  }

  /// The reader is finished with [mention]: [finishing] at once, out of
  /// [mentions] once the backend confirms it. A failure says so on that tag
  /// alone ([notDone]); the tag stays, to be marked again.
  Future<bool> done(SuperTabMention mention) async {
    if (_disposed || !_finishing.add(mention.id)) return false;
    _notDone.remove(mention.id);
    notifyListeners();
    try {
      await _command({'type': 'mention.done', 'mentionId': mention.id});
    } catch (_) {
      if (_disposed) return false;
      _finishing.remove(mention.id);
      _notDone[mention.id] = 'Not marked done. Try again.';
      notifyListeners();
      return false;
    }
    if (_disposed) return false;
    _finishing.remove(mention.id);
    _done.add(mention.id);
    mentions = List.unmodifiable(mentions.where((m) => m.id != mention.id));
    _waitingRows = [
      for (final row in _waitingRows)
        if (row['id'] != mention.id) row,
    ];
    notifyListeners();
    await load();
    unawaited(reader.refresh());
    return true;
  }

  @override
  void dispose() {
    _disposed = true;
    reader.removeListener(_changed);
    reader.reads.removeListener(_swarmRead);
    reader.firstLoads.removeListener(_loadAsked);
    super.dispose();
  }
}
