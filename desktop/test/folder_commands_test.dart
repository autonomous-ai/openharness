import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/folder_commands.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory scratch;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('harness-folders-');
  });

  tearDown(() async {
    if (await scratch.exists()) await scratch.delete(recursive: true);
  });

  List<String> names() =>
      scratch.listSync().map((entry) => p.basename(entry.path)).toList();

  for (final windows in [true, false]) {
    group(
      windows ? 'reserveDirectory on Windows' : 'reserveDirectory with mkdir',
      () {
        test('makes a folder that is not there, and nothing else', () async {
          final folder = p.join(scratch.path, "Nguyễn Văn A'&%! project");
          final result = await reserveDirectory(folder, isWindows: windows);
          expect(result.exitCode, 0, reason: '${result.stderr}');
          expect(Directory(folder).existsSync(), isTrue);
          expect(names(), ["Nguyễn Văn A'&%! project"]);
        });

        test('refuses a name a folder or a file already has', () async {
          final folder = Directory(p.join(scratch.path, 'taken'))..createSync();
          final file = File(p.join(scratch.path, 'file'))
            ..writeAsStringSync('x');
          expect(
            (await reserveDirectory(folder.path, isWindows: windows)).exitCode,
            isNot(0),
          );
          expect(
            (await reserveDirectory(file.path, isWindows: windows)).exitCode,
            isNot(0),
          );
          expect(names().toSet(), {'taken', 'file'});
        });
      },
      skip: !windows && Platform.isWindows
          ? 'Windows has no mkdir program'
          : false,
    );
  }

  test(
    'copyTree copies a folder with its files, never over one that is there',
    () async {
      final source = Directory(p.join(scratch.path, 'from', '.env.d'))
        ..createSync(recursive: true);
      File(p.join(source.path, 'a.env')).writeAsStringSync('A=1');
      File(p.join(source.path, 'nested', 'b.env'))
        ..createSync(recursive: true)
        ..writeAsStringSync('B=2');
      final target = p.join(scratch.path, 'to', '.env.d');
      File(p.join(target, 'a.env'))
        ..createSync(recursive: true)
        ..writeAsStringSync('mine');

      await copyTree(source.path, target);

      expect(File(p.join(target, 'a.env')).readAsStringSync(), 'mine');
      expect(File(p.join(target, 'nested', 'b.env')).readAsStringSync(), 'B=2');
    },
  );

  test('copyTree leaves links behind', () async {
    final source = Directory(p.join(scratch.path, 'from'))..createSync();
    Link(p.join(source.path, 'link')).createSync(scratch.path);
    await copyTree(source.path, p.join(scratch.path, 'to'));
    expect(Directory(p.join(scratch.path, 'to')).listSync(), isEmpty);
  }, skip: Platform.isWindows ? 'a symbolic link needs Developer Mode' : false);
}
