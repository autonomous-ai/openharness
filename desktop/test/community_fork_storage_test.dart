import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/fork_link.dart';
import 'package:harness/community/fork_project.dart';

import 'community_fork_test.dart' show link, snapshot;

class StorageImporter extends ForkProjectImporter {
  StorageImporter(Directory fixture)
    : super(
        root: Directory('${fixture.path}/metadata'),
        projectsRoot: Directory('${fixture.path}/harnesses'),
      );

  int downloads = 0;
  Completer<void>? holdDownload;

  @override
  Future<Map<String, dynamic>> download(ForkLink request) async {
    downloads++;
    await holdDownload?.future;
    return snapshot()..['id'] = request.harnessId;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory fixture;
  late StorageImporter importer;
  setUp(() async {
    fixture = await Directory.systemTemp.createTemp('fork-storage-test-');
    importer = StorageImporter(fixture);
  });
  tearDown(() => fixture.delete(recursive: true));

  String getOldFolder() =>
      '${importer.root.path}/forks/${link.requestId}/project';
  File receipt() =>
      File('${importer.root.path}/forks/${link.requestId}/.fork-receipt.json');
  Future<Map<String, dynamic>> legacy({Map<String, dynamic>? extra}) async {
    final old = Directory(getOldFolder());
    await old.create(recursive: true);
    await File('${old.path}/marker.txt').writeAsString('my edited project\n');
    await File('${old.path}/.private-note').writeAsString('preserve me');
    final saved = <String, dynamic>{
      'key': link.key,
      'title': 'Moonlight',
      'engine': 'codex',
      'dsh': 'forks/test',
      ...?extra,
    };
    await receipt().writeAsString(jsonEncode(saved));
    return saved;
  }

  test(
    'editable source uses the normal project folder; metadata stays private',
    () async {
      final fork = await importer.prepare(link);
      expect(fork.folder, '${fixture.path}/harnesses/moonlight');
      expect(
        fork.package,
        '${importer.root.path}/forks/${link.requestId}/package',
      );
      expect(fork.legacyFolder, isNull);
      expect(
        await File('${fork.folder}/index.html').readAsString(),
        '<h1>Hello</h1>',
      );
      expect(await File('${fork.package}/harness.json').exists(), isTrue);
      expect(
        await FileSystemEntity.type(getOldFolder(), followLinks: false),
        FileSystemEntityType.notFound,
      );
      await File('${fork.folder}/index.html').writeAsString('my version');
      final reopened = await StorageImporter(fixture).prepare(link);
      expect(reopened.folder, fork.folder);
      expect(
        await File('${fork.folder}/index.html').readAsString(),
        'my version',
      );
      expect(importer.downloads, 1);
    },
  );

  test('existing projects and separate forks with the same title are never overwritten', () async {
    final occupied = Directory('${fixture.path}/harnesses/moonlight');
    await occupied.create(recursive: true);
    await File('${occupied.path}/work.txt').writeAsString('keep this');
    const another = ForkLink(
      'starter-moonlight',
      '22222222-2222-4222-8222-222222222222',
    );
    final forks = await Future.wait([
      importer.prepare(link),
      StorageImporter(fixture).prepare(another),
    ]);
    expect(forks.map((f) => f.folder).toSet(), {
      '${fixture.path}/harnesses/moonlight-2',
      '${fixture.path}/harnesses/moonlight-3',
    });
    expect(await File('${occupied.path}/work.txt').readAsString(), 'keep this');
  });

  test('concurrent deliveries share one import and mismatched receipts are refused', () async {
    importer.holdDownload = Completer<void>();
    final first = importer.prepare(link);
    final duplicate = StorageImporter(fixture).prepare(link);
    expect(identical(first, duplicate), isTrue);
    await expectLater(
      StorageImporter(fixture)
          .prepare(ForkLink('starter-other', link.requestId)),
      throwsFormatException,
    );
    importer.holdDownload!.complete();
    final result = await first;
    expect((await duplicate).folder, result.folder);
    expect(importer.downloads, 1);
    await expectLater(
      importer.prepare(ForkLink('starter-other', link.requestId)),
      throwsFormatException,
    );
  });

  test('migration preserves edited files, links and a running process in the original cwd', () async {
    await legacy();
    final old = getOldFolder();
    await Link('$old/linked-marker').create('marker.txt');
    final process = await Process.start('/bin/sh', [
      '-c',
      r'/bin/pwd -P; read signal; /bin/pwd -P; cat marker.txt; cat "$1/marker.txt"',
      'fork-migration-test',
      old,
    ], workingDirectory: old);
    final lines = StreamIterator(
      process.stdout.transform(utf8.decoder).transform(const LineSplitter()),
    );
    try {
      expect(await lines.moveNext(), isTrue);
      expect(lines.current, await Directory(old).resolveSymbolicLinks());
      final fork = await importer.prepare(link);
      expect(fork.folder, '${fixture.path}/harnesses/moonlight');
      expect(fork.legacyFolder, old);
      expect(fork.ownsFolder(old), isTrue);
      expect(fork.ownsFolder(fork.folder), isTrue);
      expect(await Link(old).target(), fork.folder);
      expect(
        await File('${fork.folder}/.private-note').readAsString(),
        'preserve me',
      );
      expect(await Link('${fork.folder}/linked-marker').target(), 'marker.txt');
      process.stdin.writeln('continue');
      await process.stdin.close();
      expect(await lines.moveNext(), isTrue);
      expect(
        lines.current,
        await Directory(fork.folder).resolveSymbolicLinks(),
      );
      for (var i = 0; i < 2; i++) {
        expect(await lines.moveNext(), isTrue);
        expect(lines.current, 'my edited project');
      }
      expect(await process.exitCode, 0);
      expect(importer.downloads, 0);
      expect((await importer.prepare(link)).folder, fork.folder);
    } finally {
      process.kill();
      await lines.cancel();
    }
  }, skip: Platform.isWindows);

  for (final interruption in ['before-move', 'after-move', 'after-link']) {
    test(
      'migration resumes $interruption using its saved reservation',
      () async {
        final target = Directory('${fixture.path}/harnesses/moonlight');
        await target.create(recursive: true);
        await legacy(
          extra: {
            'projectPath': target.path,
            'movingProject': true,
            'keepLegacyPath': true,
          },
        );
        if (interruption != 'before-move') {
          await Directory(getOldFolder()).rename(target.path);
        }
        if (interruption == 'after-link') {
          await Link(getOldFolder()).create(target.path);
        }
        final fork = await importer.prepare(link);
        expect(fork.folder, target.path);
        expect(
          await File('${target.path}/marker.txt').readAsString(),
          'my edited project\n',
        );
        expect(await Link(getOldFolder()).target(), target.path);
        expect(
          jsonDecode(await receipt().readAsString())['movingProject'],
          isNull,
        );
        expect(importer.downloads, 0);
      },
      skip: Platform.isWindows,
    );
  }

  test(
    'a changed reservation keeps both the original files and the new occupant',
    () async {
      final target = Directory('${fixture.path}/harnesses/moonlight');
      await target.create(recursive: true);
      await File('${target.path}/work.txt').writeAsString('other work');
      await legacy(
        extra: {
          'projectPath': target.path,
          'movingProject': true,
          'keepLegacyPath': true,
        },
      );
      await expectLater(importer.prepare(link), throwsFormatException);
      expect(
        await File('${getOldFolder()}/marker.txt').readAsString(),
        'my edited project\n',
      );
      expect(
        await File('${target.path}/work.txt').readAsString(),
        'other work',
      );
    },
  );

  test(
    'a missing completed project is reported instead of silently reimported',
    () async {
      final fork = await importer.prepare(link);
      await Directory(fork.folder).rename('${fork.folder}-moved');
      await expectLater(importer.prepare(link), throwsFormatException);
      expect(importer.downloads, 1);
      expect(await File('${fork.folder}-moved/index.html').exists(), isTrue);
      expect(await Directory(fork.folder).exists(), isFalse);
    },
  );

  test('a missing legacy project never creates an empty replacement', () async {
    await legacy();
    await Directory(getOldFolder()).rename('${getOldFolder()}-saved');
    await expectLater(importer.prepare(link), throwsFormatException);
    expect(await Directory('${fixture.path}/harnesses').exists(), isFalse);
    expect(importer.downloads, 0);
  });
}
