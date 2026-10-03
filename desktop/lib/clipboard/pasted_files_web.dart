import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'pasted_text.dart';

void Function() listenForPastedFiles({
  required bool Function() wanted,
  required void Function(List<({String name, Uint8List bytes})> files) onFiles,
}) {
  final listener = ((web.ClipboardEvent event) {
    final data = event.clipboardData;
    if (data == null || !wanted()) return;
    // The clipboard closes when this handler returns: take the files now.
    final files = [
      for (var i = 0; i < data.files.length; i++) ?data.files.item(i),
    ];
    if (files.isEmpty || pastedTextWins(data.getData('text/plain'))) return;
    event.preventDefault();
    unawaited(_read(files).then(onFiles));
  }).toJS;
  // Captured at the window: the field Flutter types into lives in its own
  // host element, and this must hear the paste whatever handles it there.
  web.window.addEventListener('paste', listener, true.toJS);
  return () => web.window.removeEventListener('paste', listener, true.toJS);
}

Future<List<({String name, Uint8List bytes})>> _read(
  List<web.File> files,
) async => [
  for (final file in files)
    (
      name: file.name,
      bytes: (await file.arrayBuffer().toDart).toDart.asUint8List(),
    ),
];
