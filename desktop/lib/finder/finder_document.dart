import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:re_editor/re_editor.dart';

import 'finder_files.dart';
import 'finder_load.dart';
import 'finder_models.dart';
import 'finder_text_format.dart';

/// What happened to the file on disk while a tab held it.
enum FinderDiskChange { none, changed, deleted }

/// One file open in a Finder tab: its content, its edits, and whether they
/// are saved — Orca's editor buffer, for one file.
///
/// Edits are compared against what was last read or saved, so typing a
/// change and undoing it leaves the file clean again.
class FinderDocument extends ChangeNotifier {
  FinderDocument(this.path, this._files);

  final String path;
  final FinderFiles _files;

  FinderLoad<FinderContent> content = const FinderLoading();
  CodeLineEditingController? editor;
  bool dirty = false;
  bool saving = false;
  String? saveError;
  FinderDiskChange disk = FinderDiskChange.none;

  String _saved = '';
  DiskStamp? _stamp;
  CodeLines? _lines;
  Timer? _compare;
  bool _disposed = false;

  Future<void> load() async {
    try {
      final read = await _files.read(path);
      if (read is FinderText) _adopt(read);
      content = FinderLoaded(read);
    } on FinderException catch (error) {
      content = FinderFailed(error.message);
    }
    _notify();
  }

  /// Writes the editor's text. False when there was nothing to write or the
  /// write failed ([saveError] says why).
  Future<bool> save() async {
    final editor = this.editor;
    if (editor == null || saving) return false;
    saving = true;
    saveError = null;
    _notify();
    final text = editor.text;
    try {
      _stamp = await _files.write(path, text);
      _saved = text;
      disk = FinderDiskChange.none;
      _setDirty(editor.text != text);
      return true;
    } on FinderException catch (error) {
      saveError = error.message;
      return false;
    } finally {
      saving = false;
      _notify();
    }
  }

  /// The watcher saw this path change. A clean tab follows the disk; a tab
  /// with edits keeps them and says the file changed under it.
  Future<void> diskChanged() async {
    final stamp = await _files.stamp(path);
    if (stamp != null && stamp == _stamp) return; // This tab's own save.
    if (stamp == null) {
      disk = FinderDiskChange.deleted;
      return _notify();
    }
    if (!dirty) return reloadFromDisk();
    disk = FinderDiskChange.changed;
    _notify();
  }

  /// Drops the edits and reads the file again.
  Future<void> reloadFromDisk() async {
    try {
      final read = await _files.read(path);
      if (read is FinderText && editor != null) {
        _saved = read.text;
        _stamp = read.stamp;
        editor!.text = read.text;
        _setDirty(false);
      } else {
        await load();
      }
      disk = FinderDiskChange.none;
    } on FinderException catch (error) {
      saveError = error.message;
    }
    _notify();
  }

  /// Keeps the edits over the disk's version; the next save overwrites it.
  Future<void> keepMine() async {
    _stamp = await _files.stamp(path);
    disk = FinderDiskChange.none;
    _notify();
  }

  void _adopt(FinderText read) {
    _saved = read.text;
    _stamp = read.stamp;
    editor?.dispose();
    editor = CodeLineEditingController.fromText(
      read.text,
      detectTextFormat(read.text),
    )..addListener(_edited);
    _lines = editor!.codeLines;
  }

  /// Selection moves notify too; only a new set of lines is an edit. Marked
  /// dirty at once, and checked against the saved text a moment later — a
  /// full comparison per keystroke would cost a large file its typing.
  void _edited() {
    final lines = editor!.codeLines;
    if (identical(lines, _lines)) return;
    _lines = lines;
    _setDirty(true);
    _compare?.cancel();
    _compare = Timer(const Duration(milliseconds: 250), () {
      if (!_disposed) _setDirty(editor!.text != _saved);
    });
  }

  void _setDirty(bool value) {
    if (dirty == value) return;
    dirty = value;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _compare?.cancel();
    editor?.dispose();
    super.dispose();
  }
}
