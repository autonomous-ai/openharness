import 'dart:io';

void appendDurableLog(File file, String contents) {
  file.writeAsStringSync(contents, mode: FileMode.append, flush: true);
}
