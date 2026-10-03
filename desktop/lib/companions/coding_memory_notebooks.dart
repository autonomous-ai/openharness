import 'dart:async';

import 'package:flutter/foundation.dart';

import 'coding_memory_connection.dart';
import 'coding_memory_library.dart';

/// Read-only navigation over derived project pages. The library owns the connection.
class CodingMemoryNotebooks extends ChangeNotifier {
  CodingMemoryNotebooks(this.library)
    : _libraryChanges = library.changes,
      _libraryBusy = library.busy {
    library.addListener(_libraryChanged);
  }

  final CodingMemoryLibrary library;
  List<Map<String, dynamic>> items = [];
  Map<String, dynamic>? page;
  String? selectedId, nextCursor, error;
  bool busy = false;
  bool? available;
  bool _disposed = false, _libraryBusy;
  int _generation = 0, _libraryChanges;
  bool get valid => !_disposed && library.valid;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _clear() {
    ++_generation;
    busy = false;
    items = [];
    nextCursor = null;
    page = null;
  }

  void _libraryChanged() {
    if (_disposed) return;
    var refreshNeeded = _libraryBusy && !library.busy;
    _libraryBusy = library.busy;
    if (!valid || library.available == false || library.error != null) {
      _clear();
      if (!valid) {
        selectedId = null;
        available = null;
      }
      error = library.error;
      _notify();
      return;
    }
    if (_libraryChanges != library.changes) {
      _libraryChanges = library.changes;
      _clear();
      refreshNeeded = true;
      _notify();
    }
    if (refreshNeeded && !library.busy) unawaited(refresh());
  }

  Future<void> open(String id) async {
    if (!valid || library.busy) return;
    ++_generation;
    busy = false;
    selectedId = id;
    page = null;
    await refresh();
  }

  Future<void> back() async {
    ++_generation;
    busy = false;
    selectedId = null;
    page = null;
    error = null;
    _notify();
    if (items.isEmpty) await refresh();
  }

  Future<void> refresh({bool more = false}) async {
    if (!valid || busy || library.busy) return;
    if (more && (nextCursor == null || selectedId != null)) return;
    final generation = ++_generation;
    final id = selectedId;
    busy = true;
    error = null;
    _notify();
    try {
      final result = id == null
          ? await library.notebooks(cursor: more ? nextCursor : null)
          : await library.notebook(id);
      if (!valid || generation != _generation) return;
      if (id == null) {
        final entries = (result['items'] as List).map(memoryMap).toList();
        final cursor = result['nextCursor'] as String?;
        if (entries.any((entry) => entry['id'] is! String)) {
          throw const CodingMemoryFailure('PAGE_CHANGED');
        }
        items = more ? [...items, ...entries] : entries;
        nextCursor = cursor;
      } else {
        if (memoryMap(result['summary'])['id'] != id) {
          throw const CodingMemoryFailure('PAGE_CHANGED');
        }
        page = result;
      }
      available = true;
    } catch (failure) {
      if (!valid || generation != _generation) return;
      items = [];
      nextCursor = null;
      page = null;
      if (failure is CodingMemoryFailure && failure.code == 'UNSUPPORTED') {
        available = false;
      } else {
        error = _notebookError(failure);
      }
    } finally {
      if (!_disposed && generation == _generation) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> moreMemories() async {
    final current = page, id = selectedId;
    final memories = memoryMap(current?['memories']);
    final cursor = memories['nextCursor'];
    if (!valid ||
        busy ||
        library.busy ||
        current == null ||
        id == null ||
        cursor is! String) {
      return;
    }
    final generation = ++_generation;
    busy = true;
    error = null;
    _notify();
    try {
      final result = await library.notebookMemories(id, cursor);
      if (!valid || generation != _generation) return;
      final entries = (result['items'] as List).map(memoryMap).toList();
      if (entries.any((entry) => entry['id'] is! String)) {
        throw const CodingMemoryFailure('PAGE_CHANGED');
      }
      page = {
        ...current,
        'memories': {
          ...result,
          'items': [...memories['items'] as List, ...entries],
        },
      };
    } catch (failure) {
      if (!valid || generation != _generation) return;
      // Paging cannot keep a page from a now-private or corrected snapshot.
      page = null;
      items = [];
      nextCursor = null;
      error = _notebookError(failure);
    } finally {
      if (!_disposed && generation == _generation) {
        busy = false;
        _notify();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _clear();
    selectedId = null;
    library.removeListener(_libraryChanged);
    super.dispose();
  }
}

String _notebookError(Object failure) => switch (failure) {
  CodingMemoryFailure(code: 'NOT_FOUND') =>
    'This notebook is no longer available. Return to project notebooks.',
  CodingMemoryFailure(code: 'PAGE_CHANGED') => 'The saved memories changed. Refresh this notebook to read the current version.',
  CodingMemoryFailure(code: 'TIMEOUT') =>
    'The local memory service did not reply. Refresh to try again.',
  _ => codingMemoryError(failure),
};
