import 'dart:typed_data';

import 'pasted_files_native.dart'
    if (dart.library.js_interop) 'pasted_files_web.dart'
    as impl;

/// One file a paste carried: a screenshot, a copied picture, a copied file.
typedef PastedFile = ({String name, Uint8List bytes});

/// Hears a browser's paste while [wanted] says so, and hands [onFiles] the
/// files it carried instead of letting the field have them. A paste whose
/// text wins ([pastedTextWins]) is left to the browser. Returns what stops
/// listening.
///
/// A native build hears nothing here: its clipboard is read when ⌘V is
/// pressed ([NativeClipboard]), not delivered by an event.
void Function() listenForPastedFiles({
  required bool Function() wanted,
  required void Function(List<PastedFile> files) onFiles,
}) => impl.listenForPastedFiles(wanted: wanted, onFiles: onFiles);
