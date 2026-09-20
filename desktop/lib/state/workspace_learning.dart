import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';

enum WorkspaceLesson { agent, pane, zoom, commands }

/// Progress belongs to this person's desktop, never to an agent or project.
/// Merely opening a chooser does not complete the agent/pane lessons.
class WorkspaceLearning extends ChangeNotifier {
  WorkspaceLearning({this.storage});
  final LocalKeyValueStore? storage;
  static const storageKey = 'workspace_quick_start_v1';
  final _completed = <WorkspaceLesson>{};
  bool active = false;
  bool dismissed = false;
  bool loaded = false;
  bool _disposed = false;
  int _revision = 0;
  Future<void> _saving = Future.value();

  Set<WorkspaceLesson> get completed => Set.unmodifiable(_completed);
  bool get finished => _completed.length == WorkspaceLesson.values.length;
  bool get offer => loaded && !active && !dismissed && !finished;
  WorkspaceLesson? get next => WorkspaceLesson.values
      .where((step) => !_completed.contains(step))
      .firstOrNull;

  Future<void> load() async {
    final revision = _revision;
    try {
      final raw = await storage?.read(storageKey);
      if (_disposed || revision != _revision) return;
      final data = raw == null ? null : jsonDecode(raw);
      if (data is Map) {
        active = data['active'] == true;
        dismissed = data['dismissed'] == true;
        final done = data['completed'];
        if (done is List) {
          _completed.addAll(
            WorkspaceLesson.values.where((s) => done.contains(s.name)),
          );
        }
      }
    } catch (_) {
      // A missing/corrupt preference must never block the workspace.
    } finally {
      if (!_disposed) {
        loaded = true;
        notifyListeners();
      }
    }
  }

  void start() {
    if (finished) _completed.clear();
    active = true;
    dismissed = false;
    _changed();
  }

  void pause() {
    active = false;
    dismissed = true;
    _changed();
  }

  void observe({required int agents, required bool zoomed}) {
    if (!active || finished) return;
    final before = _completed.length;
    if (agents > 0) _completed.add(WorkspaceLesson.agent);
    if (agents > 1) _completed.add(WorkspaceLesson.pane);
    if (agents > 1 && zoomed) _completed.add(WorkspaceLesson.zoom);
    if (before != _completed.length) _changed();
  }

  void commandSearchOpened() {
    if (!active || next != WorkspaceLesson.commands) return;
    _completed.add(WorkspaceLesson.commands);
    _changed();
  }

  void _changed() {
    _revision++;
    final data = jsonEncode({
      'active': active,
      'dismissed': dismissed,
      'completed': _completed.map((s) => s.name).toList(),
    });
    _saving = _saving.then((_) async {
      try {
        await storage?.write(storageKey, data);
      } catch (_) {
        // Learning remains available if a preference cannot be saved.
      }
    });
    notifyListeners();
  }

  Future<void> flush() => _saving;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
