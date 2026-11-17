import 'package:file_selector/file_selector.dart' show XFile;
import 'package:flutter/foundation.dart';

import '../terminal/terminal_binary.dart'
    show terminalLocalPasteFileMaxPayloadBytes;

/// One file attached to a harness that does not exist yet, or to a chat
/// message: its bytes in memory, or a file on disk read only as it is sent.
@immutable
class HarnessAttachment {
  const HarnessAttachment(this.name, Uint8List this.bytes)
    : _disk = null,
      _size = 0;

  /// A file on disk, of the size it had when it was attached. It is read as
  /// it is sent, so a large file is never held whole in memory.
  const HarnessAttachment.onDisk(this.name, XFile this._disk, this._size)
    : bytes = null;

  final String name;

  /// The file's bytes, or null when it stays on disk until it is sent.
  final Uint8List? bytes;
  final XFile? _disk;
  final int _size;

  /// This file under [name], wherever it is held.
  HarnessAttachment named(String name) => name == this.name
      ? this
      : bytes != null
      ? HarnessAttachment(name, bytes!)
      : HarnessAttachment.onDisk(name, _disk!, _size);

  /// Whether the file is read from disk as it is sent.
  bool get onDisk => _disk != null;

  /// How much it weighed when it was attached.
  int get size => bytes?.length ?? _size;

  /// How much it weighs now: a file on disk may have changed since.
  Future<int> length() async => bytes?.length ?? await _disk!.length();

  /// The whole file, read now when it is on disk.
  Future<Uint8List> readBytes() async => bytes ?? await _disk!.readAsBytes();

  /// Its first [length] bytes, as a stream read from disk as it is taken.
  Stream<List<int>> openRead(int length) {
    final held = bytes;
    if (held == null) return _disk!.openRead(0, length);
    return Stream.value(
      held.length > length ? Uint8List.sublistView(held, 0, length) : held,
    );
  }
}

/// The files a New Harness box carries into its harness. Held in memory
/// until the harness's terminal is open to take them ([deliverAttachedTask]).
class HarnessAttachments extends ChangeNotifier {
  HarnessAttachments({this.onDeliveryProblem, this.limitBytes = maxBytes});

  /// What one file may weigh: the daemon's own ceiling for a pasted file.
  static const maxBytes = terminalLocalPasteFileMaxPayloadBytes;

  /// What one file may weigh in this box: [maxBytes], or another a test
  /// passes. A picked or dropped file up to it is read into memory when it is
  /// attached; a heavier one stays on disk.
  final int limitBytes;

  /// Told when files could not reach a created harness — after its box has
  /// closed, so the workspace says it rather than the box.
  final void Function(String message)? onDeliveryProblem;

  final _files = <HarnessAttachment>[];
  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  List<HarnessAttachment> get files => List.unmodifiable(_files);
  bool get isEmpty => _files.isEmpty;

  /// Adds the files that fit, replacing one of the same name. Returns what
  /// to tell the person about any left out, or null when all were taken.
  /// [oversized] names files already known to be over [maxBytes], which were
  /// never read into memory to be refused here.
  String? add(
    Iterable<HarnessAttachment> files, {
    Iterable<String> oversized = const [],
  }) {
    // A box given up with its conversation takes nothing more.
    if (_disposed) return null;
    final tooLarge = [...oversized];
    for (final file in files) {
      if (file.size == 0) continue;
      if (file.size > limitBytes) {
        tooLarge.add(file.name);
        continue;
      }
      _files.removeWhere((kept) => kept.name == file.name);
      _files.add(file);
    }
    notifyListeners();
    if (tooLarge.isEmpty) return null;
    final limit = '${limitBytes ~/ (1024 * 1024)} MB';
    return tooLarge.length == 1
        ? '${tooLarge.single} is over $limit.'
        : '${tooLarge.length} files are over $limit.';
  }

  /// Adds what was pasted beside what is there. A clipboard names every
  /// picture alike, so one whose name is taken is numbered, not swapped in.
  String? addPasted(
    Iterable<HarnessAttachment> files, {
    Iterable<String> oversized = const [],
  }) {
    final taken = {for (final file in _files) file.name};
    return add([
      for (final file in files) file.named(_freeName(file.name, taken)),
    ], oversized: oversized);
  }

  /// [name], or `name-2.ext`, `name-3.ext`… — the first not in [taken], which
  /// then holds it.
  static String _freeName(String name, Set<String> taken) {
    final dot = name.lastIndexOf('.');
    final stem = dot > 0 ? name.substring(0, dot) : name;
    final extension = dot > 0 ? name.substring(dot) : '';
    var candidate = name;
    for (var count = 2; !taken.add(candidate); count++) {
      candidate = '$stem-$count$extension';
    }
    return candidate;
  }

  void remove(HarnessAttachment file) {
    if (_files.remove(file)) notifyListeners();
  }

  void clear() {
    if (_files.isEmpty) return;
    _files.clear();
    notifyListeners();
  }
}
