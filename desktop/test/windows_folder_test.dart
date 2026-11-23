import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/windows_folder.dart';

void main() {
  test('asks the file system where SystemRoot is, not the environment', () {
    final asked = <String>[];
    final folder = windowsFolder(
      real: (path) {
        asked.add(path);
        return r'D:\Win';
      },
    );

    expect(folder, r'D:\Win');
    expect(asked, [r'\\?\GLOBALROOT\SystemRoot']);
  });

  // Dart keeps the `\\?\` it was given on the path it answers.
  test(r'takes the folder off a \\?\ answer', () {
    expect(windowsFolder(real: (_) => r'\\?\D:\Win'), r'D:\Win');
  });

  test(
    'falls back to C:\\Windows for an answer cmd.exe reads specially, or none',
    () {
      for (final answer in [
        r'C:\Win%TEMP%',
        r'C:\Win!x!',
        r'C:\Win"',
        r'C:\Win^',
        r'C:\Win&calc',
        r'C:\Win|x',
        r'C:\Win<x',
        r'C:\Win>x',
        r'\\server\share\Windows',
        r'Windows',
        r'\Windows',
        '',
      ]) {
        expect(
          windowsFolder(real: (_) => answer),
          r'C:\Windows',
          reason: answer,
        );
      }
      expect(
        windowsFolder(
          real: (path) => throw FileSystemException('not found', path),
        ),
        r'C:\Windows',
      );
    },
  );

  test('on a real Windows it is the folder Windows runs from', () {
    expect(
      windowsFolder().toLowerCase(),
      Platform.environment['SystemRoot']!.toLowerCase(),
    );
  }, skip: !Platform.isWindows);
}
