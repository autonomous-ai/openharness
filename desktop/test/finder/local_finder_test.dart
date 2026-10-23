import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_models.dart';
import 'package:harness/finder/local_finder_files.dart';
import 'package:harness/finder/local_finder_git.dart';
import 'package:path/path.dart' as p;

/// Against a real folder and a real `git`, because what is under test is how
/// this side reads and changes them.
void main() {
  late String root;
  const files = LocalFinderFiles();
  const git = LocalFinderGit();

  Future<void> run(List<String> args) async {
    final result = await Process.run('git', ['-C', root, ...args]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
  }

  File file(String name) => File(p.join(root, name));

  setUp(() async {
    final temp = await Directory.systemTemp.createTemp('finder-');
    root = await temp.resolveSymbolicLinks();
  });
  tearDown(() => Directory(root).delete(recursive: true));

  Future<GitChanges> repository() async {
    await run(['init', '-q', '-b', 'main']);
    await run(['config', 'user.email', 'finder@test']);
    await run(['config', 'user.name', 'Finder Test']);
    file('a.txt').writeAsStringSync('one\ntwo\n');
    file('.gitignore').writeAsStringSync('build/\n');
    await run(['add', '.']);
    await run(['commit', '-qm', 'first']);
    return (await git.changes(root))!;
  }

  test(
    'lists folders first and hides .git, node_modules and .DS_Store',
    () async {
      for (final dir in ['src', '.git', 'node_modules']) {
        Directory(p.join(root, dir)).createSync();
      }
      for (final name in ['b.txt', 'A.md', '.DS_Store', '.env']) {
        file(name).writeAsStringSync('x');
      }
      final names = [for (final e in await files.list(root)) e.name];
      expect(names, ['src', '.env', 'A.md', 'b.txt']);
    },
  );

  test(
    'reads text with its stamp, images as bytes, and refuses binaries',
    () async {
      file('LICENSE').writeAsStringSync('MIT');
      file('a.png').writeAsBytesSync([1, 2, 3]);
      file('blob').writeAsBytesSync([0, 1, 2]);
      final text = await files.read(p.join(root, 'LICENSE'));
      expect(text, isA<FinderText>().having((t) => t.text, 'text', 'MIT'));
      expect(
        (text as FinderText).stamp,
        await files.stamp(p.join(root, 'LICENSE')),
      );
      expect(await files.read(p.join(root, 'a.png')), isA<FinderImage>());
      expect(await files.read(p.join(root, 'blob')), isA<FinderBinary>());
    },
  );

  test('writes, creates and renames, refusing to overwrite', () async {
    final path = p.join(root, 'n.txt');
    await files.createFile(path);
    final stamp = await files.write(path, 'hello');
    expect(file('n.txt').readAsStringSync(), 'hello');
    expect(stamp, await files.stamp(path));
    file('taken.txt').writeAsStringSync('x');
    await expectLater(
      files.rename(path, p.join(root, 'taken.txt')),
      throwsA(anything),
    );
    await files.rename(path, p.join(root, 'm.txt'));
    expect(file('m.txt').existsSync(), isTrue);
  });

  test('hears a change on disk', () async {
    final written = p.join(root, 'w.txt');
    final heard = files.watch(root).firstWhere((b) => b.contains(written));
    await Future<void>.delayed(const Duration(milliseconds: 300));
    file('w.txt').writeAsStringSync('x');
    expect(await heard.timeout(const Duration(seconds: 5)), contains(written));
  });

  test('says a folder outside any repository has no changes', () async {
    expect(await git.changes(root), isNull);
  });

  test(
    'reads changes with line counts, and diffs with the whole file',
    () async {
      await repository();
      file('a.txt').writeAsStringSync('one\nTWO\n');
      file('new.txt').writeAsStringSync('fresh\n');
      final repo = (await git.changes(root))!;
      expect(repo.branch, 'main');
      expect(repo.changes.map((c) => (c.path, c.area, c.added, c.removed)), [
        ('a.txt', GitArea.unstaged, 1, 1),
        ('new.txt', GitArea.untracked, null, null),
      ]);
      final diff = await git.diff(repo, repo.changes.first);
      expect(
        [
          for (final l in diff)
            if (l.kind != DiffLineKind.meta && l.kind != DiffLineKind.hunk)
              '${l.kind.name}:${l.text}',
        ],
        ['context:one', 'removed:two', 'added:TWO'],
      );
      final added = await git.diff(repo, repo.changes.last);
      expect(
        added.where((l) => l.kind == DiffLineKind.added).single.text,
        'fresh',
      );
    },
  );

  test('stages, unstages and discards', () async {
    var repo = await repository();
    file('a.txt').writeAsStringSync('changed\n');
    repo = (await git.changes(root))!;
    await git.stage(repo, repo.changes);
    repo = (await git.changes(root))!;
    expect(repo.changes.single.area, GitArea.staged);
    await git.unstage(repo, repo.changes);
    repo = (await git.changes(root))!;
    expect(repo.changes.single.area, GitArea.unstaged);
    await git.discard(repo, repo.changes);
    expect(file('a.txt').readAsStringSync(), 'one\ntwo\n');
    expect((await git.changes(root))!.changes, isEmpty);
  });

  test('tells which entries Git ignores', () async {
    final repo = await repository();
    Directory(p.join(root, 'build')).createSync();
    expect(
      await git.ignored(repo, [
        FinderEntry(
          name: 'build',
          path: p.join(root, 'build'),
          isDirectory: true,
        ),
        FinderEntry(
          name: 'a.txt',
          path: p.join(root, 'a.txt'),
          isDirectory: false,
        ),
      ]),
      {p.join(root, 'build')},
    );
  });
}
