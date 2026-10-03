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
  HarnessAttachments({this.onDeliveryProblem});

  /// What one file may weigh: the daemon's own ceiling for a pasted file.
  static const maxBytes = terminalLocalPasteFileMaxPayloadBytes;

  /// Told when files could not reach a created harness — after its box has
  /// closed, so the workspace says it rather than the box.
  final void Function(String message)? onDeliveryProblem;

  final _files = <HarnessAttachment>[];

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
    final tooLarge = [...oversized];
    for (final file in files) {
      if (file.bytes.isEmpty) continue;
      if (file.bytes.length > maxBytes) {
        tooLarge.add(file.name);
        continue;
      }
      _files
        ..removeWhere((kept) => kept.name == file.name)
        ..add(file);
    }
    notifyListeners();
    if (tooLarge.isEmpty) return null;
    final limit = '${maxBytes ~/ (1024 * 1024)} MB';
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
