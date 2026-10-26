import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_DECISION_SHOTS'];
final _picture = GlobalKey();

Future<void> shot(WidgetTester tester, String name) async {
  if (shots == null) return;
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

/// A Swarm whose reader is the peer, with the Lead and the peer's own Chat
/// with PM in the first project.
ConversationServer swarm() {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'ken.tran@example.com', 'role': 'collaborator'},
  ];
  server.state['conversations'] = [
    conversationFixture('lead', 'Lead'),
    {
      ...conversationFixture('pm-chat', 'ken.tran'),
      'projectId': 'lead',
      'audience': {
        'people': [
          {'id': 'peer', 'generation': 'g1'},
        ],
      },
    },
  ];
  return server;
}

Future<void> showView(WidgetTester tester, ConversationServer server) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller(account: 'peer');
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      builder: (context, child) => RepaintBoundary(key: _picture, child: child),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  // The project's rows, Chat with PM among them, show once it is expanded.
  if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
  await tester.pumpAndSettle();
}

Finder notificationsEntry() =>
    find.byKey(const ValueKey('super-notifications'));
Finder option(String id, int index) =>
    find.byKey(ValueKey('super-decision-$id-$index'));

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  group('the reader\'s decisions', () {
    test('the tab state counts the decisions waiting for the reader', () {
      final server = swarm()..ask(['Ship how?', 'Name it?']);
      expect(SuperTabSnapshot.fromJson(server.state).decisionsWaiting, 2);
    });

    test(
      'loads when the count moves, and one tap answers with that option',
      () async {
        final server = swarm()..ask(['Ship how?']);
        final controller = server.controller(account: 'peer');
        addTearDown(controller.dispose);
        final decisions = SuperTabDecisions.of(controller);
        await controller.refresh();
        await decisions.load();
        expect(decisions.open.single.question, 'Ship how?');
        expect(decisions.open.single.recommended, 0);

        expect(await decisions.answer(decisions.open.single, 1), isTrue);

        expect(server.posts.last['command'], {
          'type': 'decision.answer',
          'decisionId': 'decision-1',
          'choice': 1,
        });
        expect(decisions.open, isEmpty);
        expect(decisions.answered.single.choice, 1);
      },
    );
  });

  group('the Decisions list', () {
    testWidgets(
      'lists one batch per ask, marks the recommendation, and answers with one tap',
      (tester) async {
        final server = swarm()..ask(['Ship how?', 'Name it?']);
        await showView(tester, server);
        expect(
          find.descendant(of: notificationsEntry(), matching: find.text('2')),
          findsOneWidget,
        );
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        expect(find.text('Decisions'), findsOneWidget);
        expect(
          find.text('Wren asked 2 questions · web-project · Lead'),
          findsOneWidget,
        );
        expect(find.text('Behind a flag · Recommended'), findsNWidgets(2));
        expect(find.text('Unblocks: The release'), findsNWidgets(2));

        await tester.tap(option('decision-2', 1));
        await tester.pumpAndSettle();

        expect(server.posts.last['command'], {
          'type': 'decision.answer',
          'decisionId': 'decision-2',
          'choice': 1,
        });
        expect(find.text('You chose: To everyone'), findsOneWidget);
        expect(
          find.text('Wren asked 1 question · web-project · Lead'),
          findsOneWidget,
        );
      },
    );

    testWidgets('says when nothing waits', (tester) async {
      await showView(tester, swarm());
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      expect(find.text('No decisions waiting for you.'), findsOneWidget);
    });
  });

  group('Chat with PM', () {
    testWidgets(
      'shows the reader\'s open decisions of that project above its messages',
      (tester) async {
        final server = swarm()
          ..ask(['Ship how?'], conversationId: 'pm-chat')
          ..ask(['Elsewhere?'], projectId: 'other');
        await showView(tester, server);
        await tester.tap(find.byKey(const ValueKey('super-pm-chat-lead')));
        await tester.pumpAndSettle();
        final panel = find.byKey(const ValueKey('super-pm-decisions'));
        expect(panel, findsOneWidget);
        expect(
          find.descendant(of: panel, matching: find.text('Ship how?')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: panel, matching: find.text('Elsewhere?')),
          findsNothing,
        );
        // The list names the reader's own chat as the sidebar does.
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        expect(
          find.text('Wren asked 1 question · web-project · Chat with PM'),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const ValueKey('super-pm-chat-lead')));
        await tester.pumpAndSettle();

        await tester.tap(option('decision-1', 0));
        await tester.pumpAndSettle();
        expect(panel, findsNothing);
      },
    );
  });

  testWidgets('screenshots for review', (tester) async {
    final server = swarm()
      ..ask([
        'Ship offline editing to everyone, or behind a flag first?',
        'Keep the old sync screen for a week?',
      ])
      ..ask(['Which name for the setting?'], recommended: 1);
    server.decisions.last['options'] = ['Offline mode', 'Work offline'];
    server.decisions.last['unblocks'] = 'The settings copy';
    server.decisions[1]['options'] = ['Keep it a week', 'Remove it now'];
    server.decisions[1]['unblocks'] = 'Deleting the old screen';
    server.decisions.first['unblocks'] = 'Turning the feature on';
    await showView(tester, server);
    await tester.tap(notificationsEntry());
    await tester.pumpAndSettle();
    await shot(tester, 'decisions-list');
    await tester.tap(option('decision-1', 0));
    await tester.pumpAndSettle();
    await shot(tester, 'decisions-answered');
    await tester.tap(find.byKey(const ValueKey('super-pm-chat-lead')));
    await tester.pumpAndSettle();
    await shot(tester, 'chat-with-pm');
  }, skip: shots == null);
}
