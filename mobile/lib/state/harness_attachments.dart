import 'package:flutter/foundation.dart';

import '../terminal/terminal_binary.dart'
    show terminalLocalPasteFileMaxPayloadBytes;

/// One file attached to a harness that does not exist yet — the desktop's `HarnessAttachment`.
@immutable
class HarnessAttachment {
  const HarnessAttachment(this.name, this.bytes);

  final String name;
  final Uint8List bytes;
}

/// The files a New form carries into its harness, held in memory until the harness's terminal is
/// open to take them (`deliverAttachedTask`). The desktop's `HarnessAttachments`, without its
/// paste half: the phone's files come from the system's picker only.
class HarnessAttachments extends ChangeNotifier {
  /// What one file may weigh: the machine's own ceiling for a pasted file.
  static const maxBytes = terminalLocalPasteFileMaxPayloadBytes;

  final _files = <HarnessAttachment>[];

  List<HarnessAttachment> get files => List.unmodifiable(_files);
  bool get isEmpty => _files.isEmpty;

  /// Adds the files that fit, replacing one of the same name. Returns what to tell the person
  /// about any left out, or null when all were taken. [oversized] names files already known to be
  /// over [maxBytes], which were never read into memory to be refused here. The desktop's words.
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

  void remove(HarnessAttachment file) {
    if (_files.remove(file)) notifyListeners();
  }

  void clear() {
    if (_files.isEmpty) return;
    _files.clear();
    notifyListeners();
  }
}
