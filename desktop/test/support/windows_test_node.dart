import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A real `node.exe` for the Windows-only tests: `HARNESS_TEST_NODE` (the Windows desktop
/// workflow sets it), else the first `node` that `where.exe` finds. node.exe is a single file,
/// so a test copies it into a scratch install.
String realWindowsNode() {
  final named = Platform.environment['HARNESS_TEST_NODE'];
  if (named != null && named.isNotEmpty) return named;
  final found = Process.runSync('where.exe', ['node']);
  final first = '${found.stdout}'
      .split(RegExp(r'\r?\n'))
      .map((line) => line.trim())
      .firstWhere((line) => line.isNotEmpty, orElse: () => '');
  if (found.exitCode != 0 || first.isEmpty) {
    fail(
      'No node.exe: set HARNESS_TEST_NODE (the Windows desktop workflow does)',
    );
  }
  return first;
}
