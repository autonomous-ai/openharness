import 'package:web/web.dart' as web;

import 'snapshot_store.dart';

/// Browser implementation of the existing snapshot-store entry point. A cache
/// may be discarded when storage is unavailable or full, just as on desktop.
class FileSnapshotStore implements SnapshotStore {
  FileSnapshotStore(this.name);
  final String name;
  String get _key => 'harness.web.v1.snapshot.$name';

  @override
  Future<String?> read() async {
    try {
      return web.window.localStorage.getItem(_key);
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(String contents) async {
    try {
      web.window.localStorage.setItem(_key, contents);
    } on Object {
      // Recomputed on the next launch.
    }
  }

  @override
  Future<void> clear() async {
    try {
      web.window.localStorage.removeItem(_key);
    } on Object {
      // Best-effort cache, never a prerequisite for opening the workspace.
    }
  }
}
