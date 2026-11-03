import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/backlog_view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_BACKLOG_SHOTS'];

/// Set to measure how long the Backlog takes to build with 300 tasks.
final bench = Platform.environment['SUPER_TAB_BACKLOG_BENCH'] != null;

/// Manage ▸ Backlog as the PR shows it (Scholes, task #2355): a Swarm with a
/// task in every group, in both appearances, all of it, Mine, and one project.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  /// [projects] projects, [perProject] tasks in each, cycling through the
  /// states; Scholes asked for every third.
  ConversationServer swarm({int projects = 2, int perProject = 4}) {
    final server = ConversationServer();
    const names = ['openharness', 'lampos', 'website', 'firmware'];
    server.state['projects'] = [
      for (var p = 0; p < projects; p++)
        projectFixture(
          'p$p',
          p < names.length ? names[p] : 'project-$p',
          'chat-$p',
        ),
    ];
    (server.state['people'] as List).addAll([
      {
        'id': 'scholes',
        'email': 'scholes@example.com',
        'username': 'scholes',
        'role': 'collaborator',
      },
      {
        'id': 'huy',
        'email': 'huy@example.com',
        'username': 'huy',
        'role': 'collaborator',
      },
    ]);
    server.state['agents'] = [
      for (final (id, name, machine) in const [
        ('thorne', 'Thorne', 'pro9'),
        ('lyra', 'Lyra', 'pro9'),
        ('quill', 'Quill', 'studio'),
      ])
        {
          'id': id,
          'name': name,
          'displayName': name,
          'machineId': machine,
          'harnessId': 'h-$id',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
    ];
    server.state['machines'] = [
      {'machineId': 'pro9', 'name': 'MacBook Pro-9'},
      {'machineId': 'studio', 'name': 'Mac Studio'},
    ];
    const titles = [
      'New session starts on the last project',
      'Sidebar task groups',
      'Machine names in every row',
      'Thread reply bar',
      'Status menu fixture',
      'GitHub setup line clears in seconds',
    ];
    final now = DateTime(2026, 11, 3, 17).millisecondsSinceEpoch;
    final conversations = server.state['conversations'] as List;
    conversations.removeWhere((g) => (g as Map)['id'] == 'offline');
    var number = 2300;
    for (var p = 0; p < projects; p++) {
      conversations.add({
        ...conversationFixture('chat-$p', 'chat'),
        'projectId': 'p$p',
      });
      for (var i = 0; i < perProject; i++) {
        final state = (number - 2300) % 6;
        final agent = const ['thorne', 'lyra', 'quill'][number % 3];
        conversations.add(<String, dynamic>{
          ...conversationFixture('t$number', titles[state]),
          'projectId': 'p$p',
          'number': number,
          'requesterId': const ['scholes', 'huy', 'owner'][number % 3],
          'agentIds': [if (state > 0) agent],
          if (state > 0)
            'assignment': {
              'id': 'a$number',
              'agentId': agent,
              'status': const [
                '',
                'working',
                'working',
                'review',
                'done',
                'done',
              ][state],
              'progressAt': now,
            },
          if (state == 2)
            'liveness': {
              'state': 'waiting',
              'why': 'person',
              'personId': 'scholes',
              'since': now,
            },
          if (state == 5) 'shippedAt': now,
          if (state > 0)
            'pullRequestUrls': [
              'https://github.com/autonomous-ai/openharness/pull/${number + 400}',
            ],
        });
        number++;
      }
    }
    return server;
  }

  Future<void> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.light,
    GlobalKey? picture,
  }) async {
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
    await tester.binding.setSurfaceSize(const Size(900, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => picture == null
            ? child!
            : RepaintBoundary(key: picture, child: child),
        home: Scaffold(
          body: ListenableBuilder(
            listenable: c,
            builder: (context, _) => SuperTabBacklogView(
              controller: c,
              onOpenConversation: (_) {},
              now: () => (c.groupChangedAt('t2301') ?? DateTime(2026)).add(
                const Duration(minutes: 7),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  for (final brightness in Brightness.values) {
    for (final scene in ['all', 'mine', 'project']) {
      testWidgets('screenshots for review ($scene, ${brightness.name})', (
        tester,
      ) async {
        final picture = GlobalKey();
        await show(
          tester,
          swarm(perProject: 3),
          brightness: brightness,
          picture: picture,
        );
        if (scene == 'mine') {
          await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
          await tester.pumpAndSettle();
        } else if (scene == 'project') {
          await tester.tap(find.byKey(const ValueKey('super-backlog-project')));
          await tester.pumpAndSettle();
          await tester.tap(find.text('lampos').last);
          await tester.pumpAndSettle();
        }
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 2);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/backlog-$scene-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }, skip: shots == null);
    }
  }

  testWidgets('300 tasks across 30 projects: build and rebuild times', (
    tester,
  ) async {
    final server = swarm(projects: 30, perProject: 10);
    final first = Stopwatch()..start();
    await show(tester, server);
    first.stop();
    final rebuild = Stopwatch()..start();
    await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
    await tester.pump();
    rebuild.stop();
    // ignore: avoid_print
    print(
      'Backlog, 300 tasks: first frame ${first.elapsedMilliseconds} ms '
      '(controller read included), filter rebuild '
      '${rebuild.elapsedMilliseconds} ms (headless debug VM)',
    );
  }, skip: !bench);
}
