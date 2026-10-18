import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'model.dart';

typedef SuperTabRequest = Future<Map<String, dynamic>> Function(
  String method,
  String path, {
  Map<String, dynamic>? body,
});

String superTabOperationId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

class SuperTabFailure implements Exception {
  const SuperTabFailure(this.code, this.message, {this.statusCode = 0});
  final String code, message;
  final int statusCode;
  @override
  String toString() => message;
}

/// Personal navigation/drafts live on this client. Membership, work and messages
/// live on the backend; refreshing never selects another person's conversation.
class SuperTabController extends ChangeNotifier {
  SuperTabController({
    required this.tabId,
    required this.accountId,
    required this.request,
    required this.save,
    Map<String, dynamic> initial = const {},
    this.pollInterval = const Duration(seconds: 3),
  }) {
    if (initial['tabId'] == tabId && initial['accountId'] == accountId) {
      selectedId = initial['selectedId'] as String? ?? 'lead';
      final drafts = initial['drafts'];
      if (drafts is Map) {
        for (final entry in drafts.entries) {
          if (entry.key is String && entry.value is String) {
            _drafts[entry.key as String] = entry.value as String;
          }
        }
      }
      final read = initial['readAt'];
      if (read is Map) {
        for (final entry in read.entries) {
          if (entry.key is String && entry.value is num) {
            _readAt[entry.key as String] = (entry.value as num).toInt();
          }
        }
      }
      if (initial['pending'] is Map) {
        final value = superTabMap(initial['pending']);
        if (value['operationId'] is String && value['command'] is Map) {
          _pending = value;
          operationError = 'Check the pending action before sending it again.';
        }
      }
    }
  }

  final String tabId, accountId;
  final SuperTabRequest request;
  final Future<void> Function(Map<String, dynamic> state) save;
  final Duration pollInterval;
  SuperTabSnapshot? snapshot;
  String selectedId = 'lead';
  int revision = -1;
  String? error, operationError;
  bool loading = false, saving = false, accessRevoked = false;
  bool _disposed = false;
  Timer? _poll, _draftSave;
  Future<void>? _refreshing;
  Future<void> _persisting = Future.value();
  Map<String, dynamic>? _pending;
  final _drafts = <String, String>{};
  final _readAt = <String, int>{};
  final _messages = <String, List<SuperTabMessage>>{};
  final _before = <String, int?>{};
  final _reading = <String>{};

  String get _path => '/api/super-tabs/${Uri.encodeComponent(tabId)}';
  SuperTabConversation? get selected => snapshot?.conversation(selectedId);
  bool get isOwner => snapshot?.ownerId == accountId;
  bool get canWrite =>
      !accessRevoked &&
      (snapshot?.people.where((p) => p.id == accountId).firstOrNull?.canWrite ??
          false);
  bool get hasPendingAction => _pending != null;
  Map<String, dynamic>? get pendingCommand =>
      _pending == null ? null : superTabMap(_pending!['command']);
  String draft(String id) => _drafts[id] ?? '';
  List<SuperTabMessage> messages(String id) =>
      List.unmodifiable(_messages[id] ?? const []);
  bool hasOlder(String id) => _before[id] != null;
  bool unread(SuperTabConversation group) =>
      group.lastMessageSequence > (_readAt[group.id] ?? 0);

  void start() {
    if (_disposed) return;
    unawaited(refresh());
    _poll?.cancel();
    if (pollInterval > Duration.zero) {
      _poll = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  Map<String, dynamic> _localState() => {
    'tabId': tabId,
    'accountId': accountId,
    'selectedId': selectedId,
    'drafts': Map<String, String>.of(_drafts),
    'readAt': Map<String, int>.of(_readAt),
    if (_pending != null) 'pending': _pending,
  };

  Future<void> _persist() {
    // Serial writes prevent an older autosave from restoring a resolved receipt.
    final next = _persisting
        .catchError((Object _) {})
        .then((_) => save(_localState()));
    _persisting = next;
    return next;
  }

  void _saveSoon() {
    _draftSave?.cancel();
    _draftSave = Timer(const Duration(milliseconds: 200), () {
      unawaited(
        _persist().catchError((Object _) {
          error = 'Could not save this draft on this computer.';
          _changed();
        }),
      );
    });
  }

  void setDraft(String conversationId, String value) {
    _drafts[conversationId] = value;
    _saveSoon();
  }

  void select(String id) {
    if (snapshot?.conversation(id) == null || id == selectedId) return;
    selectedId = id;
    _saveSoon();
    _changed();
    unawaited(loadMessages(id));
  }

  void markRead(String id) {
    final last = snapshot?.conversation(id)?.lastMessageSequence ?? 0;
    if ((_readAt[id] ?? 0) >= last) return;
    _readAt[id] = last;
    _saveSoon();
    _changed();
  }

  Future<void> refresh() {
    if (_disposed || accessRevoked) return Future.value();
    return _refreshing ??= _read().whenComplete(() => _refreshing = null);
  }

  Future<void> _read() async {
    loading = snapshot == null;
    _changed();
    try {
      final answer = await request('GET', _path);
      if (_disposed) return;
      final nextRevision = (answer['revision'] as num).toInt();
      final next = SuperTabSnapshot.fromJson(superTabMap(answer['state']));
      if (next.id != tabId) {
        throw const FormatException('A different Super Tab was returned.');
      }
      if (nextRevision >= revision) {
        snapshot = next;
        revision = nextRevision;
        error = null;
      }
      await loadMessages(selectedId);
    } catch (failure) {
      _readFailure(failure);
    } finally {
      loading = false;
      _changed();
    }
  }

  void _readFailure(Object failure) {
    if (_disposed) return;
    error = failure is SuperTabFailure
        ? failure.message
        : 'Could not refresh this conversation. Try again.';
    if (failure is SuperTabFailure &&
        const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
      accessRevoked = true;
      snapshot = null;
      _messages.clear();
      _poll?.cancel();
    }
  }

  Future<void> loadMessages(String id, {bool older = false}) async {
    if (_disposed ||
        accessRevoked ||
        _reading.contains(id) ||
        snapshot?.conversation(id) == null) {
      return;
    }
    if (older && !hasOlder(id)) return;
    _reading.add(id);
    try {
      final known = _messages[id];
      final tail = known != null && known.isNotEmpty
          ? known.last.sequence
          : null;
      final query = older
          ? '?before=${_before[id]}'
          : tail != null
          ? '?after=$tail'
          : '';
      var answer = await request(
        'GET',
        '$_path/conversations/${Uri.encodeComponent(id)}/messages$query',
      );
      if (!_disposed &&
          !older &&
          tail != null &&
          (answer['messages'] as List).isEmpty) {
        // No new text: refresh delivery receipts in the page already shown.
        answer = await request(
          'GET',
          '$_path/conversations/${Uri.encodeComponent(id)}/messages?before=${tail + 1}',
        );
      }
      if (_disposed || accessRevoked) return;
      final incoming = (answer['messages'] as List)
          .map((m) => SuperTabMessage.fromJson(superTabMap(m)))
          .toList();
      if (incoming.any((m) => m.conversationId != id)) {
        throw const FormatException('A different conversation was returned.');
      }
      final combined = {
        for (final m in _messages[id] ?? <SuperTabMessage>[]) m.id: m,
        for (final m in incoming) m.id: m,
      };
      _messages[id] = combined.values.toList()
        ..sort((a, b) => a.sequence.compareTo(b.sequence));
      if (older || !_before.containsKey(id)) {
        _before[id] = (answer['next'] as num?)?.toInt();
      }
      _changed();
    } catch (failure) {
      _readFailure(failure);
      _changed();
    } finally {
      _reading.remove(id);
    }
  }

  Future<Map<String, dynamic>?> command(Map<String, dynamic> command) async {
    if (_disposed || !_maySend(command) || saving || _pending != null) {
      return null;
    }
    _pending = {
      'operationId': superTabOperationId(),
      'command': Map<String, dynamic>.of(command),
    };
    return retry();
  }

  Future<Map<String, dynamic>?> retry() async {
    final pending = _pending;
    if (_disposed ||
        saving ||
        pending == null ||
        !_maySend(superTabMap(pending['command']))) {
      return null;
    }
    saving = true;
    operationError = null;
    _changed();
    try {
      // The receipt ID reaches durable local storage before the request can reach the server.
      await _persist();
      if (_disposed) return null;
      final answer = await request('POST', '$_path/commands', body: pending);
      if (_disposed) return null;
      final result = superTabMap(answer['result']);
      final command = superTabMap(pending['command']);
      if (command['type'] == 'message.send') {
        final id = command['conversationId'] as String;
        if (_drafts[id]?.trim() == command['text']) _drafts.remove(id);
      }
      _pending = null;
      try {
        await _persist();
      } catch (_) {
        _pending = pending;
        rethrow;
      }
      await refresh();
      if (!_disposed &&
          revision < ((answer['revision'] as num?)?.toInt() ?? revision)) {
        await refresh();
      }
      return result;
    } catch (failure) {
      if (!_disposed) {
        operationError = failure is SuperTabFailure
            ? failure.message
            : 'The action is not confirmed. Retry to check it.';
        if (failure is SuperTabFailure &&
            failure.statusCode >= 400 &&
            failure.statusCode < 500 &&
            !const {408, 429}.contains(failure.statusCode)) {
          // A definitive rejection made no change. Preserve the draft and let
          // the person correct it; a lost reply retains its exact receipt ID.
          _pending = null;
          try {
            await _persist();
          } catch (_) {
            _pending = pending;
          }
        }
        if (failure is SuperTabFailure &&
            const {
              'FORBIDDEN',
              'NOT_FOUND',
              'READ_ONLY',
            }.contains(failure.code)) {
          await refresh();
        }
      }
      return null;
    } finally {
      saving = false;
      _changed();
    }
  }

  bool _maySend(Map<String, dynamic> command) =>
      canWrite ||
      (!accessRevoked &&
          snapshot != null &&
          command['type'] == 'member.remove' &&
          command['userId'] == accountId);

  Future<Map<String, dynamic>?> send({
    String? replyTo,
    List<String> recipients = const [],
  }) {
    final text = draft(selectedId).trim();
    if (text.isEmpty || selected?.archived == true) return Future.value(null);
    return command({
      'type': 'message.send',
      'conversationId': selectedId,
      'text': text,
      'replyTo': replyTo,
      'recipientIds': recipients,
    });
  }

  Future<void> flush() async {
    _draftSave?.cancel();
    await _persist();
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _draftSave?.cancel();
    // The owner awaits flush when changing account or closing the tab.
    super.dispose();
  }
}
