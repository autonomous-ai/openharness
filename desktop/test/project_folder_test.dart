import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:path/path.dart' as p;

void main() {
  test('a new project is named after its agent and the time, and two in one minute never share a folder', () async {
    final root = await Directory.systemTemp.createTemp(
      'harness-new-project-test-',
    );
    addTearDown(() => root.delete(recursive: true));
    final existing = File(p.join(root.path, 'keep.txt'));
    await existing.writeAsString('keep');
    DateTime at() => DateTime(2026, 9, 3, 9, 5, 7);
    const request = ProjectFolderRequest.newProject();
    expect(request.payload, {'projectSource': 'new'});
    // A file already holding the minute's name is never replaced.
    await File(p.join(root.path, 'codex-2026-09-03-09-05'))
        .writeAsString('keep');
    final folders = await Future.wait([
      request.prepareLocal(projectHome: root.path, label: 'Codex', now: at),
      request.prepareLocal(projectHome: root.path, label: 'Codex', now: at),
    ]);
    expect(folders.map(p.basename).toSet(), {
      'codex-2026-09-03-09-05-07',
      'codex-2026-09-03-09-05-07-2',
    });
    expect(folders.every((folder) => p.isWithin(root.path, folder)), isTrue);
    expect(await existing.readAsString(), 'keep');
    expect(
      await File(p.join(root.path, 'codex-2026-09-03-09-05')).readAsString(),
      'keep',
    );
    expect(
      p.basename(
        await request.prepareLocal(
          projectHome: root.path,
          label: 'Autonomous Circuit',
          now: at,
        ),
      ),
      'autonomous-circuit-2026-09-03-09-05',
    );
    expect(
      p.basename(await request.prepareLocal(projectHome: root.path)),
      matches(RegExp(r'^harness-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$')),
    );
  });
  test('folder names pad every part and fall back to harness', () {
    final at = DateTime(2026, 12, 25, 0, 0, 9);
    expect(projectFolderName('Blender', at), 'blender-2026-12-25-00-00');
    expect(
      projectFolderName('text-to-cad', at, withSeconds: true),
      'text-to-cad-2026-12-25-00-00-09',
    );
    expect(projectFolderName('***', at), 'harness-2026-12-25-00-00');
  });
  test('long suggested names preserve the timestamp through remote name limits and collisions', () {
    final request = ProjectFolderRequest.generated(
      label: 'A very long descriptive name for a custom harness from the store',
      at: DateTime(2026, 9, 20, 17, 22, 19),
    );
    final names = <String>[];
    for (var i = 0; i < 105; i++) {
      final name = request.availableGeneratedName(names);
      expect(name.length, lessThanOrEqualTo(64));
      expect(name, contains('-2026-09-20-17-22'));
      expect(request.withGeneratedName(name).payload['projectName'], name);
      names.add(name);
    }
    expect(names.toSet(), hasLength(105));
    expect(names.last, endsWith('-2026-09-20-17-22-19-104'));
  });
  test(
    'remote repository uses the existing safe clone on this computer',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'harness-remote-project-test-',
      );
      addTearDown(() => root.delete(recursive: true));
      final source = p.join(root.path, 'source.git');
      expect(
        (await Process.run('git', ['init', '--bare', source])).exitCode,
        0,
      );
      final request = ProjectFolderRequest.remote(
        GitHubRepository.parse('owner/repo')!,
      );
      final folder = await request.prepareLocal(
        projectHome: p.join(root.path, 'projects'),
        createClone: () => RepositoryClone(
          startProcess: (args, environment) {
            expect(args[2], 'https://github.com/owner/repo.git');
            return Process.start('git', [
              'clone',
              '--',
              source,
              args.last,
            ], environment: environment);
          },
        ),
      );
      expect(await Directory(p.join(folder, '.git')).exists(), isTrue);
      expect(request.payload, {
        'projectSource': 'remote',
        'repositoryUrl': 'https://github.com/owner/repo.git',
      });
    },
  );
}
