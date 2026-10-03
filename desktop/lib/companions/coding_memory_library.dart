import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'coding_memory_connection.dart';

Map<String, dynamic> memoryMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

/// In-memory presentation only: no retained quotes, draft or capability is
/// written to preferences, logs or a second database.
class CodingMemoryLibrary extends ChangeNotifier {
  CodingMemoryLibrary(this.connection) {
    connection.addListener(_connectionChanged);
  }
  final CodingMemoryConnection connection;
  bool _disposed = false, busy = false;
  bool? available;
  String scope = 'personal';
  String? error, nextCursor;
  Map<String, dynamic>? status;
  String? _snapshot;
  int changes = 0;
  List<Map<String, dynamic>> items = [];
  bool get valid => !_disposed && connection.valid;
  bool get learn => memoryMap(status?['preferences'])['learn'] == true;
  bool get recall => memoryMap(status?['preferences'])['recall'] == true;

  void _connectionChanged() {
    if (_disposed) return;
    if (!connection.valid) {
      items = [];
      status = null;
      nextCursor = null;
      error = codingMemoryError(const CodingMemoryFailure('OWNER_CHANGED'));
    }
    notifyListeners();
  }

  Future<Map<String, dynamic>> _request(Map<String, dynamic> payload) async {
    if (!valid) throw const CodingMemoryFailure('OWNER_CHANGED');
    final result = await connection.request(payload);
    if (!valid) throw const CodingMemoryFailure('OWNER_CHANGED');
    // Fixtures and future transports must honor the same typed refusal contract.
    if (result['ok'] != true) {
      throw CodingMemoryFailure(
        result['error'] as String? ?? 'MEMORY_UNAVAILABLE',
      );
    }
    return result;
  }

  Future<void> refresh({String? filter, bool more = false}) async {
    if (busy || !valid) return;
    if (more && nextCursor == null) return;
    if (filter != null && filter != scope) {
      scope = filter;
      items = [];
      nextCursor = null;
    }
    busy = true;
    error = null;
    notifyListeners();
    try {
      final currentStatus = await _request({'action': 'status'});
      final page = await _request({
        'action': 'list',
        'query': {'scope': scope, 'limit': 20, if (more) 'cursor': nextCursor},
      });
      final entries = (page['items'] as List).map(memoryMap).toList();
      if (!valid) return;
      status = currentStatus;
      available = true;
      final snapshot = jsonEncode(page['version']);
      if (snapshot != _snapshot) {
        _snapshot = snapshot;
        ++changes;
      }
      items = more ? [...items, ...entries] : entries;
      nextCursor = page['nextCursor'] as String?;
    } catch (failure) {
      if (_disposed) return;
      if (failure is CodingMemoryFailure && failure.code == 'UNSUPPORTED') {
        available = false;
      }
      // A stale snapshot can contain a newly private or forgotten record.
      items = [];
      nextCursor = null;
      _snapshot = null;
      ++changes;
      error = codingMemoryError(failure);
    } finally {
      busy = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<Map<String, dynamic>> detail(String id) =>
      _request({'action': 'show', 'id': id});

  Future<Map<String, dynamic>> activity({String? agentId}) => _request({
    'action': 'activity',
    'query': {'agentId': ?agentId},
  });

  Future<Map<String, dynamic>> notebooks({String? cursor}) => _request({
    'action': 'notebooks',
    'query': {'limit': 12, 'cursor': ?cursor},
  });

  Future<Map<String, dynamic>> notebook(String id) =>
      _request({'action': 'notebook', 'id': id});

  Future<Map<String, dynamic>> notebookMemories(String id, String cursor) =>
      _request({
        'action': 'list',
        'query': {'topicId': id, 'cursor': cursor, 'limit': 20},
      });

  Future<Map<String, dynamic>> projects({String search = '', int? before}) =>
      _request({
        'action': 'projects',
        'query': {'search': search, 'limit': 20, 'before': ?before},
      });

  Future<CodingMemoryPreview> preview(Map<String, dynamic> command) async {
    final result = await _request({'action': 'preview', 'command': command});
    return CodingMemoryPreview(
      result['capability'] as String,
      memoryMap(result['preview']),
      connection.epoch,
      Duration(milliseconds: (result['expiresInMs'] as num).toInt()),
    );
  }

  Future<void> apply(CodingMemoryPreview preview) async {
    if (preview.used || preview.expired || preview.epoch != connection.epoch) {
      throw const CodingMemoryFailure('PREVIEW_REQUIRED');
    }
    preview.used = true;
    await _request({'action': 'apply', 'capability': preview.capability});
    // A session rating does not change memory content. Keep the open detail and
    // its controls mounted while the caller refreshes the saved feedback.
    if (memoryMap(preview.data['command'])['kind'] == 'feedback') return;
    // Drop old content before refreshing. A failed refresh must not resurrect it.
    items = [];
    nextCursor = null;
    _snapshot = null;
    ++changes;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    items = [];
    status = null;
    nextCursor = null;
    // A modal lives above the companion viewer's route. Invalidate its retained
    // evidence before disposing the viewer's controller or it can outlive it.
    notifyListeners();
    connection.removeListener(_connectionChanged);
    connection.dispose();
    super.dispose();
  }
}

class CodingMemoryPreview {
  CodingMemoryPreview(
    this.capability,
    Map<String, dynamic> preview,
    this.epoch,
    this.lifetime,
  ) : data = memoryMap(jsonDecode(jsonEncode(preview))),
      _age = Stopwatch()..start();
  final String capability;
  final Map<String, dynamic> data;
  final int epoch;
  final Duration lifetime;
  final Stopwatch _age;
  bool used = false;
  bool get expired => _age.elapsed >= lifetime;
}
