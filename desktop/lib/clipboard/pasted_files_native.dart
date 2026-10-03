import 'dart:typed_data';

void Function() listenForPastedFiles({
  required bool Function() wanted,
  required void Function(List<({String name, Uint8List bytes})> files) onFiles,
}) => () {};
