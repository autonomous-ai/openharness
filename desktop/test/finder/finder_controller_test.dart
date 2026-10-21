import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_controller.dart';
import 'package:harness/finder/finder_document.dart';
import 'package:harness/finder/finder_file_actions.dart';
import 'package:harness/finder/finder_load.dart';
import 'package:harness/finder/finder_models.dart';

import 'fakes.dart';

void main() {
  late FakeFinderFiles files;
  late FakeFinderGit git;
  late FinderController controller;

  setUp(() async {
    files = FakeFinderFiles();
    git = FakeFinderGit();
    controller = FinderController(root: '/r', files: files, git: git);
    addTearDown(controller.dispose);
    await controller.start();
  });

  FinderDocument documentOf(String path) =>
      controller.tabs.byId('file:$path')!.document!;

  test('reads the tree and the repository, and marks what changed', () {
    expect(controller.tree.rows.map((r) => r.entry.name), ['lib', 'README.md']);
    expect(
      controller.git.fileStatus('/r/lib/main.dart'),
      GitChangeKind.modified,
    );
    expect(controller.git.folderStatus('/r/lib'), GitChangeKind.modified);
    expect(controller.git.repository?.branch, 'main');
  });

  test(
    'a preview tab gives way to the next preview; a kept one stays',
    () async {
      controller.openFile('/r/README.md');
      controller.openFile('/r/lib/main.dart');
      expect(controller.tabs.tabs.map((t) => t.path), ['/r/lib/main.dart']);

      controller.openFile('/r/lib/main.dart', preview: false);
      controller.openFile('/r/README.md');
      expect(controller.tabs.tabs.map((t) => (t.path, t.preview)), [
        ('/r/lib/main.dart', false),
        ('/r/README.md', true),
      ]);
      expect(controller.tabs.activeId, 'file:/r/README.md');
    },
  );

  test(
    'editing keeps a preview tab, marks it dirty, and saving writes it',
    () async {
      controller.openFile('/r/lib/main.dart');
      await pumpEventQueue();
      final document = documentOf('/r/lib/main.dart');
      document.editor!.text = 'void main() => print(1);\n';
      expect(document.dirty, isTrue);
      expect(controller.tabs.active!.preview, isFalse);

      expect(await controller.saveActive(), isTrue);
      expect(files.writes['/r/lib/main.dart'], 'void main() => print(1);\n');
      expect(document.dirty, isFalse);
    },
  );

  test('undoing back to the saved text leaves the tab clean', () async {
    controller.openFile('/r/lib/main.dart');
    await pumpEventQueue();
    final document = documentOf('/r/lib/main.dart');
    document.editor!.text = 'changed';
    document.editor!.text = 'void main() {}\n';
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(document.dirty, isFalse);
  });

  test('a clean tab follows the disk; a dirty one asks', () async {
    controller.openFile('/r/README.md', preview: false);
    controller.openFile('/r/lib/main.dart', preview: false);
    await pumpEventQueue();

    files.changeOnDisk('/r/README.md', '# New');
    controller.onDiskChanged({'/r/README.md'});
    await pumpEventQueue();
    expect(documentOf('/r/README.md').editor!.text, '# New');

    final edited = documentOf('/r/lib/main.dart');
    edited.editor!.text = 'mine';
    files.changeOnDisk('/r/lib/main.dart', 'theirs');
    controller.onDiskChanged({'/r/lib/main.dart'});
    await pumpEventQueue();
    expect(edited.disk, FinderDiskChange.changed);
    expect(edited.editor!.text, 'mine');

    await edited.reloadFromDisk();
    expect(edited.editor!.text, 'theirs');
    expect(edited.dirty, isFalse);
    expect(edited.disk, FinderDiskChange.none);
  });

  test('its own save is not mistaken for a change on disk', () async {
    controller.openFile('/r/lib/main.dart');
    await pumpEventQueue();
    final document = documentOf('/r/lib/main.dart');
    document.editor!.text = 'saved';
    await document.save();
    document.editor!.text = 'typing on';
    controller.onDiskChanged({'/r/lib/main.dart'});
    await pumpEventQueue();
    expect(document.disk, FinderDiskChange.none);
  });

  test('a change opens its diff, and Stage reads Git again', () async {
    controller.openChange(FakeFinderGit.edited);
    await pumpEventQueue();
    final diff = controller.tabs.active!.diff!;
    expect(diff.diff, isA<FinderLoaded<List<DiffLine>>>());

    final reads = git.reads;
    expect(await controller.stage([FakeFinderGit.edited]), isNull);
    expect(git.staged, ['lib/main.dart']);
    expect(git.reads, greaterThan(reads));
  });

  test('discard restores tracked files and trashes untracked ones', () async {
    const fresh = GitChange(
      path: 'notes.txt',
      kind: GitChangeKind.untracked,
      area: GitArea.untracked,
    );
    expect(await controller.discard([FakeFinderGit.edited, fresh]), isNull);
    expect(git.discarded, ['lib/main.dart']);
    expect(files.trashed, ['/r/notes.txt']);
  });

  test(
    'new files open kept; names are checked; renames close old tabs',
    () async {
      expect(
        await controller.create('/r/lib', 'a.dart', asFolder: false),
        isNull,
      );
      expect(controller.tabs.active!.path, '/r/lib/a.dart');
      expect(controller.tabs.active!.preview, isFalse);
      expect(await controller.create('/r', 'x/y', asFolder: false), isNotNull);
      expect(await controller.create('/r', '  ', asFolder: false), isNotNull);

      expect(await controller.rename('/r/lib/a.dart', 'b.dart'), isNull);
      expect(controller.tabs.byId('file:/r/lib/a.dart'), isNull);
      expect(files.texts.containsKey('/r/lib/b.dart'), isTrue);
    },
  );

  test('a rename waits while the file has unsaved edits', () async {
    controller.openFile('/r/README.md');
    await pumpEventQueue();
    documentOf('/r/README.md').editor!.text = 'draft';
    expect(await controller.rename('/r/README.md', 'R.md'), isNotNull);
    expect(files.texts.containsKey('/r/README.md'), isTrue);
  });

  test('a failed Git read is said, and clears the marks', () async {
    git.fail = true;
    await controller.git.refresh();
    expect(controller.git.status, isA<FinderFailed<GitChanges?>>());
    expect(controller.git.fileStatus('/r/lib/main.dart'), isNull);
  });

  test('ignored entries are marked once Git answers', () async {
    git.ignoredPaths = {'/r/README.md'};
    await controller.refresh();
    expect(controller.git.isIgnored('/r/README.md'), isTrue);
    expect(controller.git.isIgnored('/r/lib'), isFalse);
  });
}
