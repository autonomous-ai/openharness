import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import '../state/harness_attachments.dart';
import 'attachments.dart';
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
      expandedProjects.addAll(
        (initial['expandedProjects'] as List? ?? const []).whereType<String>(),
      );
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
      final terminals = initial['terminals'];
      if (terminals is Map) {
        for (final entry in terminals.entries) {
          if (entry.key is String && entry.value is String) {
            _terminals[entry.key as String] = entry.value as String;
          }
        }
      }
      final mentions = initial['mentions'];
      if (mentions is Map) {
        for (final group in mentions.entries) {
          if (group.key is String && group.value is Map) {
            _mentions[group.key as String] = {
              for (final mention in (group.value as Map).entries)
                if (mention.key is String && mention.value is String)
                  mention.key as String: mention.value as String,
            };
          }
        }
      }
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
  final _terminals = <String, String>{};
  final _mentions = <String, Map<String, String>>{};
  final _readAt = <String, int>{};
  final _images = <String, SuperTabImages>{};
  final _imageBytes = <String, Future<Uint8List>>{};
  final _messages = <String, List<SuperTabMessage>>{};
  final _before = <String, int?>{};
  final _reading = <String>{};
  final expandedProjects = <String>{};

  void toggleProject(String id) {
    if (!expandedProjects.remove(id)) expandedProjects.add(id);
    _saveSoon();
    _changed();
  }

  String get _path => '/api/super-tabs/${Uri.encodeComponent(tabId)}';
  SuperTabConversation? get selected => snapshot?.conversation(selectedId);
  bool get isOwner => snapshot?.ownerId == accountId;
  bool get canWrite =>
      !_disposed &&
      !accessRevoked &&
      (snapshot?.people.where((p) => p.id == accountId).firstOrNull?.canWrite ??
          false);
  bool get hasPendingAction => _pending != null;
  Map<String, dynamic>? get pendingCommand =>
      _pending == null ? null : superTabMap(_pending!['command']);
  String draft(String id) => _drafts[id] ?? '';

  /// The images waiting in [conversationId]'s composer, kept in memory only.
  SuperTabImages images(String conversationId) =>
      _images[conversationId] ??= (SuperTabImages(
        onDiscard: (id) => unawaited(
          request(
            'DELETE',
            '$_path/attachments/${Uri.encodeComponent(id)}',
          ).then((_) {}, onError: (Object _) {}),
        ),
      )..addListener(_changed));

  /// An attached image's bytes, read part by part through the same relay as
  /// every other request. The last few stay in memory; a failed read is
  /// forgotten so the next one tries again.
  Future<Uint8List> attachmentBytes(SuperTabAttachment attachment) {
    final known = _imageBytes.remove(attachment.id);
    if (known != null) return _imageBytes[attachment.id] = known;
    final read = _readAttachment(attachment);
    _imageBytes[attachment.id] = read;
    // A screenshot is a few megabytes: eight stay, about the images in view.
    while (_imageBytes.length > 8) {
      _imageBytes.remove(_imageBytes.keys.first);
    }
    read.catchError((Object _) {
      if (identical(_imageBytes[attachment.id], read)) {
        _imageBytes.remove(attachment.id);
      }
      return Uint8List(0);
    });
    return read;
  }

  Future<Uint8List> _readAttachment(SuperTabAttachment attachment) async {
    final bytes = BytesBuilder(copy: false);
    for (var index = 0; index < attachment.parts; index++) {
      final part = await request(
        'GET',
        '$_path/attachments/${Uri.encodeComponent(attachment.id)}/parts/$index',
      );
      bytes.add(base64Decode(part['data'] as String));
    }
    if (bytes.length != attachment.size) {
      throw const FormatException('The image arrived incomplete.');
    }
    return bytes.takeBytes();
  }

  /// Uploads [file] in parts unless it already was, and returns its ID. An
  /// interrupted upload resumes with the parts the backend is missing.
  Future<String> _upload(SuperTabImages staged, HarnessAttachment file) async {
    if (staged.uploadedId(file) case final id?) return id;
    final bytes = file.bytes;
    final parts = (bytes.length / kSuperTabImagePartBytes).ceil();
    String part(int index) => base64Encode(
      bytes.sublist(
        index * kSuperTabImagePartBytes,
        min(bytes.length, (index + 1) * kSuperTabImagePartBytes),
      ),
    );
    var id = staged.startedId(file);
    List<int> missing = [for (var index = 1; index < parts; index++) index];
    if (id != null) {
      try {
        final known = await request(
          'GET',
          '$_path/attachments/${Uri.encodeComponent(id)}',
        );
        missing = [
          for (final index in known['missing'] as List? ?? const [])
            (index as num).toInt(),
        ];
      } on SuperTabFailure catch (failure) {
        if (failure.code != 'NOT_FOUND') rethrow;
        staged.forget(file);
        id = null;
      }
    }
    if (id == null) {
      final created = await request(
        'POST',
        '$_path/attachments',
        body: {'name': file.name, 'size': bytes.length, 'data': part(0)},
      );
      id = created['id'] as String;
      staged.markStarted(file, id);
    }
    for (final index in missing) {
      if (_disposed) throw const SuperTabFailure('CLOSED', 'Swarm closed.');
      await request(
        'POST',
        '$_path/attachments/${Uri.encodeComponent(id)}/parts/$index',
        body: {'data': part(index)},
      );
    }
    staged.markUploaded(file, id);
    return id;
  }

  SuperTabAgent? terminalAgent(String conversationId) {
    return terminalAgents(conversationId).firstOrNull;
  }

  List<SuperTabAgent> terminalAgents(String conversationId) {
    if (accessRevoked) return const [];
    final id = _terminals[conversationId];
    final group = snapshot?.conversation(conversationId);
    if (id == null || group == null) return const [];
    return snapshot!.agents
        .where((agent) => group.agentIds.contains(agent.id))
        .toList();
  }

  void selectGroupTerminals(String conversationId) {
    if (_disposed ||
        accessRevoked ||
        snapshot?.conversation(conversationId) == null) {
      return;
    }
    _terminals[conversationId] = '*';
    _saveSoon();
    _changed();
  }

  void selectTerminal(String conversationId, String? agentId) {
    if (_disposed || accessRevoked) return;
    if (agentId != null &&
        snapshot?.conversation(conversationId)?.agentIds.contains(agentId) !=
            true) {
      return;
    }
    if (_terminals[conversationId] == agentId) {
      return;
    }
    if (agentId == null) {
      _terminals.remove(conversationId);
    } else {
      _terminals[conversationId] = agentId;
    }
    _saveSoon();
    _changed();
  }

  List<SuperTabMessage> messages(String id) => List.unmodifiable(
    (_messages[id] ?? const <SuperTabMessage>[]).where(
      (m) => m.source['kind'] != 'update-request',
    ),
  );
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

  /// Open dialogs and native panes lose their content immediately, before
  /// account cleanup waits for an in-flight read or a draft write.
  void revokeAccess(String message) {
    if (_disposed) return;
    accessRevoked = true;
    error = message;
    snapshot = null;
    _messages.clear();
    _imageBytes.clear();
    for (final staged in _images.values) {
      staged.clear();
    }
    _poll?.cancel();
    _changed();
  }

  Map<String, dynamic> _localState() => {
    'tabId': tabId,
    'accountId': accountId,
    'selectedId': selectedId,
    'expandedProjects': expandedProjects.toList(),
    'drafts': Map<String, String>.of(_drafts),
    'terminals': Map<String, String>.of(_terminals),

    'mentions': {
      for (final entry in _mentions.entries)
        entry.key: Map<String, String>.of(entry.value),
    },
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
    _mentions[conversationId]?.removeWhere(
      (_, token) => !containsMention(value, token),
    );
    _saveSoon();
  }

  static bool containsMention(String text, String token) =>
      RegExp('(?:^|\\s)${RegExp.escape(token)}(?=\$|\\s|[.,!?;:])')
          .hasMatch(text);

  void mention(String conversationId, String agentId, String token) {
    if (containsMention(draft(conversationId), token)) {
      (_mentions[conversationId] ??= {})[agentId] = token;
      _saveSoon();
      _changed();
    }
  }

  Map<String, String> mentions(String conversationId) =>
      Map.unmodifiable(_mentions[conversationId] ?? const {});

  void select(String id) {
    if (snapshot?.conversation(id) == null || id == selectedId) return;
    if (!snapshot!.isProjectLead(id)) {
      expandedProjects.add(snapshot!.conversation(id)!.projectId);
    }
    selectedId = id;
    _saveSoon();
    _changed();
    unawaited(loadMessages(id));
  }

  /// A visible transcript passes its loaded boundary: a newer snapshot may
  /// already advertise messages that have not arrived on this client yet.
  void markRead(String id, {int? through}) {
    final advertised = snapshot?.conversation(id)?.lastMessageSequence ?? 0;
    final last = through == null ? advertised : min(through, advertised);
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
      if (_disposed || accessRevoked) return;
      final nextRevision = (answer['revision'] as num).toInt();
      final next = SuperTabSnapshot.fromJson(superTabMap(answer['state']));
      if (next.id != tabId) {
        throw const FormatException('A different Swarm was returned.');
      }
      if (nextRevision >= revision) {
        snapshot = next;
        final allowed = next.conversations.map((c) => c.id).toSet();
        final localAccessChanged =
            !allowed.contains(selectedId) ||
            [
              ..._drafts.keys,
              ..._terminals.keys,
              ..._mentions.keys,
              ..._readAt.keys,
            ].any((id) => !allowed.contains(id)) ||
            expandedProjects.any(
              (id) => !next.projects.any((project) => project.id == id),
            );
        _messages.removeWhere((id, _) => !allowed.contains(id));
        for (final id in _images.keys.where((id) => !allowed.contains(id))) {
          _images[id]!.clear();
        }
        _drafts.removeWhere((id, _) => !allowed.contains(id));
        _terminals.removeWhere((id, _) => !allowed.contains(id));
        _mentions.removeWhere((id, _) => !allowed.contains(id));
        _before.removeWhere((id, _) => !allowed.contains(id));
        _readAt.removeWhere((id, _) => !allowed.contains(id));
        expandedProjects.removeWhere(
          (id) => !next.projects.any((project) => project.id == id),
        );
        if (!allowed.contains(selectedId)) {
          selectedId = next.projects.firstOrNull?.leadConversationId ?? 'lead';
        }
        revision = nextRevision;
        error = null;
        if (localAccessChanged) _saveSoon();
      }
      await loadMessages(selectedId);
    } catch (failure) {
      _readFailure(failure);
    } finally {
      loading = false;
      _changed();
    }
  }

  void _readFailure(Object failure, {bool revokeTab = true}) {
    if (_disposed) return;
    error = failure is SuperTabFailure
        ? failure.message
        : 'Could not refresh this conversation. Try again.';
    if (revokeTab &&
        failure is SuperTabFailure &&
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
      if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
        return;
      }
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
      _readFailure(failure, revokeTab: false);
      if (failure is SuperTabFailure &&
          const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        _messages.remove(id);
        unawaited(refresh());
      }
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
        if (_drafts[id]?.trim() == command['text']) {
          _drafts.remove(id);
          _mentions.remove(id);
        }
        final sent = (command['attachmentIds'] as List? ?? const []).toSet();
        final staged = _images[id];
        if (staged != null && sent.isNotEmpty) {
          for (final file in staged.files) {
            if (sent.contains(staged.uploadedId(file))) staged.sent(file);
          }
        }
      }
      if (command['type'] == 'conversation.create' &&
          result['conversationId'] is String) {
        // A successful create selects its confirmed destination even when the
        // following read is offline. Never leave the old group's composer active.
        selectedId = result['conversationId'] as String;
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
            failure.code == 'INVALID_ATTACHMENT') {
          // An expired or already sent upload: the images still in the
          // composer upload again on the next send.
          final command = superTabMap(pending['command']);
          _images[command['conversationId']]?.forgetUploads();
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

  /// Uploads the composer's images first, then sends the text with their
  /// IDs. Images alone are a message too.
  Future<Map<String, dynamic>?> send({
    String? replyTo,
    List<String> recipients = const [],
  }) async {
    final conversationId = selectedId;
    final text = draft(conversationId).trim();
    final staged = images(conversationId);
    if ((text.isEmpty && staged.isEmpty) ||
        selected == null ||
        selected!.archived) {
      return null;
    }
    final addressed = recipients.isEmpty
        ? mentions(selectedId).entries
              .where((entry) => containsMention(text, entry.value))
              .map((entry) => entry.key)
              .toList()
        : recipients;
    if (addressed.any((id) => !selected!.agentIds.contains(id))) {
      operationError = 'A mentioned agent is no longer in this conversation. Remove its mention or choose another agent.';
      _changed();
      return null;
    }
    final attachmentIds = <String>[];
    if (!staged.isEmpty) {
      if (_disposed || !canWrite || saving || _pending != null) return null;
      saving = true;
      operationError = null;
      _changed();
      try {
        for (final file in staged.files) {
          attachmentIds.add(await _upload(staged, file));
        }
      } catch (failure) {
        if (_disposed) return null;
        operationError = failure is SuperTabFailure
            ? failure.message
            : 'Could not upload the image. Try again.';
        return null;
      } finally {
        saving = false;
        _changed();
      }
      if (_disposed) return null;
    }
    return command({
      'type': 'message.send',
      'conversationId': conversationId,
      'text': text,
      'replyTo': replyTo,
      'recipientIds': addressed,
      if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
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
    for (final staged in _images.values) {
      staged.dispose();
    }
    _imageBytes.clear();
    // The owner awaits flush when changing account or closing the tab.
    super.dispose();
  }
}
