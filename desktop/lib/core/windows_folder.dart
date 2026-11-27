import 'dart:io';

import 'package:path/path.dart' as p;

/// Windows' own folder, asked of the file system (cli lib/windows/powershell.ts's
/// systemRoot): SystemRoot and windir are whoever starts the app's, and can name
/// another folder. A drive's folder that cmd.exe reads as itself between quotes,
/// with no variable, `!`, quote or operator; anything else, or no answer (off
/// Windows), is the folder Windows installs to. Without [real], the file
/// system's own reader, asked once a process.
String windowsFolder({String Function(String path)? real}) {
  if (real == null) return _asked;
  try {
    var folder = real(r'\\?\GLOBALROOT\SystemRoot');
    // Dart keeps the `\\?\` it was given on the path it answers.
    if (folder.startsWith(r'\\?\')) folder = folder.substring(4);
    if (RegExp(r'^[A-Za-z]:\\[^%!"^&|<>]*$').hasMatch(folder)) return folder;
  } on FileSystemException {
    // Not there off Windows, or not readable.
  }
  return r'C:\Windows';
}

final String _asked = windowsFolder(
  real: (path) => Directory(path).resolveSymbolicLinksSync(),
);

/// One of Windows' own programs by its full path in System32: a bare name is
/// looked for in the app's folder and its working folder first.
String windowsSystemProgram(String name) =>
    p.windows.join(windowsFolder(), 'System32', name);
