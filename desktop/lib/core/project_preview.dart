import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'program_path.dart';

/// Read-only, bounded source material for a project preview. Never executes
/// project code, hooks, Markdown images or a Git network operation.
Future<Map<String, dynamic>> readLocalProjectPreview(
  String path, {
  String Function() program = gitProgram,
}) async {
  if (!p.isAbsolute(path) || path.length > 4096 || path.contains('\u0000')) {
    return {'error': 'INVALID_PATH'};
  }
  try {
    if (!await Directory(path).exists()) return {'error': 'NOT_FOUND'};
    final files = <String>[];
    String? readme;
    var seen = 0;
    await for (final entity in Directory(path).list(followLinks: false)) {
      final name = p.basename(entity.path);
      if (!name.startsWith('.')) files.add(name);
      if (readme == null &&
          RegExp(
            r'^readme(?:\.(?:md|markdown|txt))?$',
            caseSensitive: false,
          ).hasMatch(name) &&
          entity is File) {
        final file = await entity.open();
        try {
          final bytes = await file.read(32 * 1024);
          if (!bytes.contains(0)) {
            readme = utf8.decode(bytes, allowMalformed: true);
          }
        } finally {
          await file.close();
        }
      }
      if (++seen >= 200) break;
    }
    files.sort();
    final git = await Future.wait([
      _git(program, path, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      _git(program, path, ['status', '--porcelain=v1', '--untracked-files=no']),
      _git(program, path, ['log', '-1', '--format=%s%n%an%n%aI']),
      _git(program, path, ['log', '-100', '--format=%an']),
    ]);
    final commit = git[2]?.split('\n');
    return {
      'path': path,
      'readme': ?readme,
      'files': files.take(12).toList(),
      'branch': ?git[0],
      if (git[1] != null)
        'changedFiles': git[1]!.isEmpty ? 0 : git[1]!.split('\n').length,
      if (commit != null && commit.length >= 3)
        'commit': {
          'subject': commit[0],
          'author': commit[1],
          'date': commit[2],
        },
      if (git[3] != null)
        'contributors': git[3]!
            .split('\n')
            .where((name) => name.isNotEmpty)
            .toSet()
            .take(5)
            .toList(),
    };
  } on FileSystemException {
    return {'error': 'UNREADABLE'};
  }
}

Future<String?> _git(
  String Function() program,
  String path,
  List<String> args,
) async {
  Process? process;
  Timer? timer;
  var expired = false;
  try {
    process = await Process.start(
      program(),
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-C',
        path,
        ...args,
      ],
      environment: {'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0'},
    );
    timer = Timer(const Duration(seconds: 2), () {
      expired = true;
      process?.kill(ProcessSignal.sigkill);
    });
    var length = 0;
    final bytes = <int>[];
    final stdout = process.stdout.listen((chunk) {
      length += chunk.length;
      if (length > 32 * 1024) {
        expired = true;
        process?.kill(ProcessSignal.sigkill);
      } else {
        bytes.addAll(chunk);
      }
    });
    final outputDone = stdout.asFuture<void>();
    final stderr = process.stderr.drain<void>();
    final code = await process.exitCode;
    await outputDone;
    await stderr;
    return code == 0 && !expired
        ? utf8.decode(bytes, allowMalformed: true).trim()
        : null;
  } on ProcessException {
    return null;
  } finally {
    timer?.cancel();
  }
}
