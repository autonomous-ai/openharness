import 'package:flutter/foundation.dart';

import '../terminal/terminal_binary.dart'
    show terminalLocalPasteFileMaxPayloadBytes;

/// One file attached to a harness that does not exist yet.
@immutable
class HarnessAttachment {
  const HarnessAttachment(this.name, this.bytes);

  final String name;
  final Uint8List bytes;
}

/// The files a New Harness box carries into its harness. Held in memory
/// until the harness's terminal is open to take them ([deliverAttachedTask]).
class HarnessAttachments extends ChangeNotifier {
  HarnessAttachments({
    this.onDeliveryProblem,
    this.limitBytes = maxBytes,
    this.limitFiles,
  });

  /// What one file may weigh: the daemon's own ceiling for a pasted file.
  static const maxBytes = terminalLocalPasteFileMaxPayloadBytes;

  /// What one file may weigh in this box; a box whose files go somewhere with
  /// a lower ceiling than the daemon's passes it.
  final int limitBytes;

  /// How many files this box holds, or null for any number.
  final int? limitFiles;

  /// Told when files could not reach a created harness — after its box has
  /// closed, so the workspace says it rather than the box.
  final void Function(String message)? onDeliveryProblem;

  final _files = <HarnessAttachment>[];
  int _reading = 0;
  bool _disposed = false;

  /// Whether a picker, a drop or a paste is still reading files for this box.
  /// An owner that would let go of an empty box waits while this is true, so
  /// what the read brings is not lost.
  bool get isReading => _reading > 0;

  /// Runs [read], which ends by adding what it read here, and holds the box
  /// until it is done.
  Future<T> reading<T>(Future<T> Function() read) async {
    _reading++;
    try {
      return await read();
    } finally {
      _reading--;
    }
  }

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
    var surplus = 0;
    for (final file in files) {
      if (file.bytes.isEmpty) continue;
      if (file.bytes.length > limitBytes) {
        tooLarge.add(file.name);
        continue;
      }
      _files.removeWhere((kept) => kept.name == file.name);
      if (limitFiles != null && _files.length >= limitFiles!) {
        surplus++;
        continue;
      }
      _files.add(file);
    }
    notifyListeners();
    if (surplus > 0) return 'Attach at most $limitFiles files.';
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
      for (final file in files)
        HarnessAttachment(_freeName(file.name, taken), file.bytes),
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
