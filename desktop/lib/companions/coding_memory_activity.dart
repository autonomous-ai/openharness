import 'dart:async';

import 'package:flutter/foundation.dart';

import 'coding_memory_connection.dart';
import 'coding_memory_library.dart';

/// Owner-only inspection of the last recorded recall for an open native session.
class CodingMemoryActivity extends ChangeNotifier {
  CodingMemoryActivity(this.library)
    : _changes = library.changes,
      _libraryBusy = library.busy {
    library.addListener(_libraryChanged);
  }
  final CodingMemoryLibrary library;
  List<Map<String, dynamic>> sessions = [], items = [];
  String? selectedAgentId, error;
  bool busy = false, writing = false;
  bool? available;
  bool _disposed = false, _libraryBusy;
  int _generation = 0, _changes;
  bool get valid => !_disposed && library.valid;
  Map<String, dynamic>? get selection =>
      sessions.where((row) => row['agentId'] == selectedAgentId).firstOrNull;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _clear() {
    ++_generation;
    sessions = [];
    items = [];
    busy = false;
  }

  void _libraryChanged() {
    if (_disposed) return;
    var refreshNeeded = _libraryBusy && !library.busy;
    _libraryBusy = library.busy;
    if (!valid || library.available == false || library.error != null) {
      _clear();
      if (!valid) selectedAgentId = null;
      error = library.error;
      _notify();
      return;
    }
    if (_changes != library.changes) {
      _changes = library.changes;
      _clear();
      refreshNeeded = true;
      _notify();
    }
    if (refreshNeeded && !library.busy && !writing) unawaited(refresh());
  }

  Future<void> select(String? agentId) async {
    if (!valid || writing) return;
    ++_generation;
    busy = false;
    items = [];
    if (agentId == null) sessions = [];
    selectedAgentId = agentId;
    await refresh();
  }

  void _accept(Map<String, dynamic> result, String? requested) {
    final nextSessions = (result['sessions'] as List).map(memoryMap).toList();
    final nextItems = (result['items'] as List).map(memoryMap).toList();
    final selected = result['selectedAgentId'] as String?;
    if ((requested != null && requested != selected) ||
        nextSessions.any((row) => row['agentId'] is! String) ||
        nextItems.any((row) => memoryMap(row['record'])['id'] is! String) ||
        (nextItems.isNotEmpty &&
            !nextSessions.any((row) => row['agentId'] == selected))) {
      throw const CodingMemoryFailure('PAGE_CHANGED');
    }
    sessions = nextSessions;
    items = nextItems;
    selectedAgentId = selected;
    available = true;
  }

  void _failed(Object failure) {
    sessions = [];
    items = [];
    if (failure is CodingMemoryFailure &&
        ['UNSUPPORTED', 'INVALID_INPUT'].contains(failure.code)) {
      available = false;
      error = null;
    } else if (failure is CodingMemoryFailure &&
        ['SESSION_CHANGED', 'SESSION_UNAVAILABLE'].contains(failure.code)) {
      error = 'This coding session changed or closed. Choose an open session to continue.';
    } else {
      error = codingMemoryError(failure);
    }
  }

  Future<void> refresh() async {
    if (!valid || busy || writing || library.busy) return;
    final generation = ++_generation, requested = selectedAgentId;
    busy = true;
    error = null;
    _notify();
    try {
      final result = await library.activity(agentId: requested);
      if (!valid || generation != _generation) return;
      _accept(result, requested);
    } catch (failure) {
      if (!valid || generation != _generation) return;
      _failed(failure);
    } finally {
      if (!_disposed && generation == _generation) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> rate(Map<String, dynamic> item, String? value) async {
    if (!valid || busy || writing || library.busy || !items.contains(item)) {
      return;
    }
    final generation = ++_generation, requested = selectedAgentId;
    final record = memoryMap(item['record']),
        recall = memoryMap(item['recall']);
    writing = busy = true;
    error = null;
    _notify();
    try {
      final preview = await library.preview({
        'kind': 'feedback',
        'id': record['id'],
        'revision': record['revision'],
        'receiptId': recall['receiptId'],
        'value': value,
        'expected': memoryMap(recall['feedback'])['version'],
      });
      if (!valid || generation != _generation) return;
      // The explicit rating click authorizes this bound, one-use write. Never retry it.
      await library.apply(preview);
      if (!valid || generation != _generation) return;
      final result = await library.activity(agentId: requested);
      if (!valid || generation != _generation) return;
      _accept(result, requested);
    } catch (failure) {
      if (valid && generation == _generation) _failed(failure);
    } finally {
      writing = false;
      if (!_disposed) {
        if (generation == _generation) busy = false;
        _notify();
        if (generation != _generation && valid && !library.busy) {
          unawaited(refresh());
        }
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _clear();
    selectedAgentId = null;
    library.removeListener(_libraryChanged);
    super.dispose();
  }
}
