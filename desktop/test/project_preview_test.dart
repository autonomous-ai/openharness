import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/project_preview.dart';

void main() {
  late Directory root;
  setUp(
    () async =>
        root = await Directory.systemTemp.createTemp('harness-preview-'),
  );
  tearDown(() => root.delete(recursive: true));

  Future<void> git(List<String> args) async {
    final result = await Process.run('git', ['-C', root.path, ...args]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
  }

  test('previews README, branch, commit and authors without running a fsmonitor hook', () async {
    await git(['init', '-b', 'preview']);
    await File('${root.path}/README.md')
        .writeAsString('# Project\nExisting content');
    await git(['add', 'README.md']);
    await git([
      '-c',
      'user.name=Preview Author',
      '-c',
      'user.email=preview@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'First commit',
    ]);
    await File('${root.path}/README.md')
        .writeAsString('# Project\nUpdated content');
    await git(['config', 'core.fsmonitor', 'touch ${root.path}/monitor-ran']);
    final preview = await readLocalProjectPreview(root.path);
    expect(preview['readme'], '# Project\nUpdated content');
    expect(preview['branch'], 'preview');
    expect(preview['changedFiles'], 1);
    expect(preview['commit'], containsPair('subject', 'First commit'));
    expect(preview['contributors'], ['Preview Author']);
    expect(await File('${root.path}/monitor-ran').exists(), isFalse);
  });

  test(
    'ordinary folders work, README reads are bounded, symlinks stay unread',
    () async {
      final readme = File('${root.path}/README.md');
      await readme.writeAsString('a' * 40000);
      expect(
        (await readLocalProjectPreview(root.path))['readme'].length,
        32768,
      );
      await readme.delete();
      await File('${root.path}/private.txt').writeAsString('private');
      await Link(readme.path).create('${root.path}/private.txt');
      final preview = await readLocalProjectPreview(root.path);
      expect(preview['readme'], isNull);
      expect(preview['files'], contains('private.txt'));
      expect(preview['commit'], isNull);
      expect(
        (await readLocalProjectPreview('${root.path}/missing'))['error'],
        'NOT_FOUND',
      );
      expect(
        (await readLocalProjectPreview('relative'))['error'],
        'INVALID_PATH',
      );
    },
  );

  test("runs the resolver's git", () async {
    final init = await Process.run('git', ['-C', root.path, 'init', '-b', 'x']);
    expect(init.exitCode, 0);
    expect((await readLocalProjectPreview(root.path))['branch'], 'x');
    // Absolute and missing: a bare `git` would run the real one instead.
    final missing = '${root.path}/no-git/git';
    String noGit() => throw const ProcessException('git', [], 'not found', 2);
    for (final program in [() => missing, noGit]) {
      final preview = await readLocalProjectPreview(
        root.path,
        program: program,
      );
      expect(preview['path'], root.path);
      expect(preview['branch'], isNull);
    }
  });
}
