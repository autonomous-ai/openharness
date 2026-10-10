import 'dart:io';

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:harness/community/fork_inbox.dart';
import 'package:harness/community/fork_link.dart';
import 'package:harness/community/fork_project.dart';
import 'package:harness/community/publish_project.dart';

import '../test/community_fork_test.dart' show MemoryStore;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'macOS queues native links before Dart is ready and delivers warm links',
    (tester) async {
      if (!Platform.isMacOS) return;
      const directory = String.fromEnvironment('HARNESS_LINK_REVIEW_DIR');
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Center(
              child: Text(
                'Community link review — open the Blender fork in the browser',
              ),
            ),
          ),
        ),
      );
      await tester.runAsync(() async {
        final root = Directory(directory);
        await root.create(recursive: true);
        final inbox = ForkInbox(MemoryStore());
        Future<void> until(bool Function() ready) async {
          final deadline = DateTime.now().add(const Duration(minutes: 3));
          while (!ready() && DateTime.now().isBefore(deadline)) {
            await Future<void>.delayed(const Duration(milliseconds: 100));
          }
          expect(
            ready(),
            isTrue,
            reason: 'Browser-to-native link was not delivered.',
          );
        }

        // A browser/OS UI driver clicks Fork and acknowledges its native Open
        // prompt, then writes this marker. No private account or live agent is used.
        await File('$directory/phase').writeAsString('before-ready');
        await until(() => File('$directory/cold-sent').existsSync());
        await inbox.initialize();
        await until(() => inbox.pending.isNotEmpty);
        expect(inbox.pending.single.harnessId, 'starter-ribbon-lamp');
        await inbox.complete(inbox.pending.single);
        await File('$directory/phase').writeAsString('warm');
        await until(() => inbox.pending.isNotEmpty);
        expect(inbox.pending.single.harnessId, 'starter-portable-light');
        await until(() => File('$directory/warm-sent').existsSync());
        expect(inbox.pending, hasLength(1));
        await File('$directory/phase').writeAsString('passed');
        inbox.dispose();
      });
    },
    skip:
        !Platform.isMacOS ||
        const String.fromEnvironment('HARNESS_LINK_REVIEW_DIR') == '',
  );

  testWidgets('public featured snapshots import as editable native projects', (
    tester,
  ) async {
    const origin = String.fromEnvironment('HARNESS_COMMUNITY_ORIGIN');
    expect(
      origin,
      isNotEmpty,
      reason: 'Pass the disposable community preview origin.',
    );
    await tester.runAsync(() async {
      final root = await Directory.systemTemp.createTemp(
        'community-native-import-',
      );
      try {
        final projectFolders = Directory('${root.path}/harnesses');
        final importer = ForkProjectImporter(
          root: Directory('${root.path}/metadata'),
          projectsRoot: projectFolders,
          origin: origin,
        );
        const projects = {
          'ribbon-lamp': 'scenes/hello.py',
          'signal-study': 'circuit.txt',
          'alpine-drift': 'src/main.ts',
          'two-futures': 'out/rollout.qpos.json',
          'molecular-shapes': 'molecules/hello.py',
          'lantern-room': 'track.strudel',
          'portable-light': 'out/main.pdf',
          'harness-keynote': 'deck.md',
          'moonlight': 'index.html',
        };
        var i = 0;
        for (final entry in projects.entries) {
          final request =
              '${(++i).toString().padLeft(8, '0')}-0000-4000-8000-000000000000';
          final fork = await importer.prepare(
            ForkLink('starter-${entry.key}', request),
          );
          expect(Directory(fork.folder).parent.path, projectFolders.path);
          expect(
            await File('${fork.folder}/${entry.value}').length(),
            greaterThan(0),
          );
          final draft = await buildPublicationDraft(
            folder: fork.folder,
            title: fork.title,
            engine: fork.engine,
            harnessId: fork.dsh,
          );
          expect(draft['forkedFrom'], 'starter-${entry.key}');
          expect(
            (draft['files'] as List).any((f) => f['path'] == entry.value),
            isTrue,
          );
          if (entry.key == 'ribbon-lamp') {
            expect(
              await File('${fork.folder}/.harness/design.json').exists(),
              isTrue,
            );
            expect(
              (await File(
                '${fork.folder}/out/model.glb',
              ).readAsBytes()).take(4),
              [103, 108, 84, 70],
            );
          }
          if (entry.key == 'portable-light') {
            expect(
              (await File('${fork.folder}/out/main.pdf').readAsBytes()).take(4),
              [37, 80, 68, 70],
            );
          }
        }
      } finally {
        await root.delete(recursive: true);
      }
    });
  });

  testWidgets('native publication arrives as a private browser draft', (
    tester,
  ) async {
    const directory = String.fromEnvironment('HARNESS_PUBLISH_REVIEW_DIR');
    const origin = String.fromEnvironment('HARNESS_COMMUNITY_ORIGIN');
    await tester.runAsync(() async {
      final root = await Directory.systemTemp.createTemp('hub-native-publish-');
      try {
        await File('${root.path}/preview.html').writeAsString(
          '<!doctype html><style>body{background:#ede9e2;font:48px Georgia;padding:10vw;color:#233b32}</style><h1>A quieter orbit.</h1><p>Made from an open harness.</p>',
        );
        final draft = await buildPublicationDraft(
          folder: root.path,
          title: 'A quieter orbit',
          engine: 'codex',
          tail: {
            'rows': [
              {
                'ask': 'Make an orbit in warm paper and forest green.',
                'answer': 'Here is a quieter version.',
              },
            ],
          },
        );
        draft['description'] =
            'A disposable draft for the native-to-web publishing check.';
        final handoff = await PublicationHandoff.start(draft, origin: origin);
        try {
          await Directory(directory).create(recursive: true);
          await File('$directory/url').writeAsString(handoff.url.toString());
          final deadline = DateTime.now().add(const Duration(minutes: 4));
          while (!File('$directory/reviewed').existsSync() &&
              DateTime.now().isBefore(deadline)) {
            await Future<void>.delayed(const Duration(milliseconds: 200));
          }
          expect(
            File('$directory/reviewed').existsSync(),
            isTrue,
            reason: 'Review the imported draft in the browser.',
          );
        } finally {
          await handoff.close();
        }
      } finally {
        await root.delete(recursive: true);
      }
    });
  }, skip: const String.fromEnvironment('HARNESS_PUBLISH_REVIEW_DIR') == '');
}
