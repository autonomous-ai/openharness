import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
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

/// A Swarm whose reader is the peer, with the Lead and the peer's own Buddy
/// chat in the first project, where the PM's private lines reach them.
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
      ...conversationFixture('buddy-peer-lead', "ken.tran's Buddy"),
      'projectId': 'lead',
      'kind': 'buddy',
      'buddyOwnerId': 'peer',
    },
  ];
  return server;
}

Future<SuperTabController> showView(
  WidgetTester tester,
  ConversationServer server, {
  Map<String, dynamic>? initial,
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller(account: 'peer', initial: initial);
  addTearDown(c.dispose);
  // The chrome's tokens follow the app's brightness, as the app sets it.
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      // A new key for each view: a restart builds the whole view again.
      key: UniqueKey(),
      theme: grid.buildAppTheme(brightness: brightness),
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
  // The project's rows show once it is expanded.
  if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
  await tester.pumpAndSettle();
  return c;
}

Finder notificationsEntry() =>
    find.byKey(const ValueKey('super-notifications'));
Finder option(String id, int index) =>
    find.byKey(ValueKey('super-decision-$id-$index'));
Finder letPmDecide(String id) =>
    find.byKey(ValueKey('super-decision-$id-delegate'));
Finder notNow(String id) => find.byKey(ValueKey('super-decision-$id-later'));
Finder pmPanel() => find.byKey(const ValueKey('super-pm-decisions'));
Finder inPanel(String text) =>
    find.descendant(of: pmPanel(), matching: find.text(text));

Future<void> openPmChat(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('super-buddy-lead')));
  await tester.pumpAndSettle();
}

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

  group('reading the reader\'s decisions', () {
    test(
      'a Swarm change that leaves the waiting count alone reads no decisions',
      () async {
        final server = swarm()..ask(['Ship how?']);
        final controller = server.controller(account: 'peer');
        addTearDown(controller.dispose);
        final decisions = SuperTabDecisions.of(controller);
        await controller.refresh();
        await pumpEventQueue();
        expect(decisions.open.single.question, 'Ship how?');
        final reads = server.decisionReads;
        final before = controller.lastChangedAt;

        // A message, a machine reading: the Swarm changed, the count did not.
        (server.state['conversations'] as List).first['title'] = 'Lead room';
        await controller.refresh();
        await pumpEventQueue();

        expect(controller.lastChangedAt, isNot(before));
        expect(server.decisionReads, reads);
      },
    );

    test('reads again when the waiting count moves', () async {
      // A backend from before the digest: the count alone tells.
      final server = swarm()
        ..decisionsDigestMissing = true
        ..ask(['Ship how?']);
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final decisions = SuperTabDecisions.of(controller);
      await controller.refresh();
      await pumpEventQueue();

      server.ask(['Name it?']);
      await controller.refresh();
      await pumpEventQueue();

      expect(decisions.open.map((d) => d.question), ['Name it?', 'Ship how?']);
    });

    test('reads again when one is answered elsewhere and another asked, though the count stays', () async {
      final server = swarm()..ask(['Ship how?']);
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final decisions = SuperTabDecisions.of(controller);
      await controller.refresh();
      await pumpEventQueue();
      expect(decisions.open.single.question, 'Ship how?');

      server
        ..answerDecision('decision-1', 0)
        ..ask(['Name it?']);
      await controller.refresh();
      await pumpEventQueue();

      expect(controller.snapshot!.decisionsWaiting, 1);
      expect(decisions.open.single.question, 'Name it?');
      expect(decisions.answered.single.question, 'Ship how?');
    });

    test(
      'a read that failed is tried again on the next Swarm change',
      () async {
        final server = swarm()
          ..failDecisions = true
          ..ask(['Ship how?']);
        final controller = server.controller(account: 'peer');
        addTearDown(controller.dispose);
        final decisions = SuperTabDecisions.of(controller);
        await controller.refresh();
        await pumpEventQueue();
        expect(decisions.error, isNotNull);

        server.failDecisions = false;
        (server.state['conversations'] as List).first['title'] = 'Lead room';
        await controller.refresh();
        await pumpEventQueue();

        expect(decisions.error, isNull);
        expect(decisions.open.single.question, 'Ship how?');
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

    testWidgets(
      'drops the decisions of a conversation the reader leaves at once, though another keeps the count',
      (tester) async {
        final server = swarm();
        (server.state['conversations'] as List).add({
          ...conversationFixture('plans', 'Plans'),
          'projectId': 'lead',
        });
        server.ask(['Ship how?'], conversationId: 'plans');
        final c = await showView(tester, server);
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        expect(find.text('Ship how?'), findsOneWidget);

        // The reader loses the workgroup and the Lead asks elsewhere: still
        // one waiting. The new list is slow to come.
        (server.state['conversations'] as List).removeWhere(
          (g) => (g as Map)['id'] == 'plans',
        );
        server
          ..hideDecision('decision-1')
          ..ask(['Name it?']);
        server.parts.epoch++;
        final slow = server.holdDecisions = Completer<void>();
        await c.refresh();
        await tester.pump();

        expect(c.snapshot!.decisionsWaiting, 1);
        expect(find.text('Ship how?'), findsNothing);
        expect(find.text('Behind a flag · Recommended'), findsNothing);

        server.holdDecisions = null;
        slow.complete();
        await tester.pumpAndSettle();
        expect(find.text('Name it?'), findsOneWidget);
        expect(find.text('Ship how?'), findsNothing);
      },
    );

    testWidgets('says when nothing waits', (tester) async {
      await showView(tester, swarm());
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      expect(find.text('No decisions waiting for you.'), findsOneWidget);
    });
  });

  group('the Buddy chat', () {
    testWidgets(
      'shows the reader\'s open decisions of that project above its messages',
      (tester) async {
        final server = swarm()
          ..ask(['Ship how?'])
          ..ask(['Elsewhere?'], projectId: 'other');
        await showView(tester, server);
        await tester.tap(find.byKey(const ValueKey('super-buddy-lead')));
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
        // The list names where each was asked: the project chat, for both.
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        expect(
          find.text('Wren asked 1 question · web-project · Lead'),
          findsNWidgets(2),
        );
        await tester.tap(find.byKey(const ValueKey('super-buddy-lead')));
        await tester.pumpAndSettle();

        await tester.tap(option('decision-1', 0));
        await tester.pumpAndSettle();
        expect(panel, findsNothing);
      },
    );
  });

  group('a decision the reader does not want to answer', () {
    test('Let the coordinator decide sends a delegated answer, and the answer reads as theirs', () async {
      final server = swarm()..ask(['Ship how?'], recommended: 1);
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final decisions = SuperTabDecisions.of(controller);
      await controller.refresh();
      await decisions.load();

      expect(await decisions.delegate(decisions.open.single), isTrue);

      expect(server.posts.last['command'], {
        'type': 'decision.answer',
        'decisionId': 'decision-1',
        'delegate': true,
      });
      expect(decisions.open, isEmpty);
      expect(decisions.answered.single.choice, 1);
      expect(decisions.answered.single.delegated, isTrue);
    });

    testWidgets(
      'the Buddy chat offers Let Product Manager decide and Not now on each card, and none without a recommended option',
      (tester) async {
        final server = swarm()
          ..ask(['Ship how?'])
          ..ask(['Which colour?']);
        server.decisions.last['recommended'] = null;
        await showView(tester, server);
        await openPmChat(tester);
        expect(inPanel('Decisions for you (2)'), findsOneWidget);
        expect(letPmDecide('decision-1'), findsOneWidget);
        expect(notNow('decision-1'), findsOneWidget);
        expect(letPmDecide('decision-2'), findsNothing);
        expect(notNow('decision-2'), findsOneWidget);

        await tester.tap(letPmDecide('decision-1'));
        await tester.pumpAndSettle();

        expect(server.posts.last['command'], {
          'type': 'decision.answer',
          'decisionId': 'decision-1',
          'delegate': true,
        });
        expect(inPanel('Ship how?'), findsNothing);
        // The answered list says the Product Manager decided, never that the reader chose.
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        expect(
          find.text('Product Manager decided: Behind a flag'),
          findsOneWidget,
        );
        expect(find.text('You chose: Behind a flag'), findsNothing);
      },
    );

    testWidgets('the coordinator is called what its project calls it', (
      tester,
    ) async {
      final server = swarm()..ask(['Ship how?']);
      (server.state['projects'] as List).first['coordinatorName'] =
          'Coordinator';
      await showView(tester, server);
      await openPmChat(tester);
      expect(
        find.descendant(
          of: letPmDecide('decision-1'),
          matching: find.text('Let Coordinator decide'),
        ),
        findsOneWidget,
      );
      await tester.tap(letPmDecide('decision-1'));
      await tester.pumpAndSettle();
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      expect(find.text('Coordinator decided: Behind a flag'), findsOneWidget);
      expect(find.textContaining('PM decide'), findsNothing);
    });

    testWidgets(
      'Not now folds the card into one line, still folded after a restart, until a new decision arrives',
      (tester) async {
        final server = swarm()..ask(['Ship how?']);
        await showView(tester, server);
        await openPmChat(tester);

        await tester.tap(notNow('decision-1'));
        await tester.pumpAndSettle();

        expect(inPanel('Decisions for you (1)'), findsOneWidget);
        expect(inPanel('Ship how?'), findsNothing);
        expect(
          find.byKey(const ValueKey('super-pm-decisions-show')),
          findsOneWidget,
        );
        expect(
          server.posts.where((p) => p['command']?['type'] == 'decision.answer'),
          isEmpty,
        );

        // A restart reads what this computer saved for the reader.
        final restarted = await showView(tester, server, initial: server.saved);
        await openPmChat(tester);
        expect(inPanel('Decisions for you (1)'), findsOneWidget);
        expect(inPanel('Ship how?'), findsNothing);
        // The Decisions list still holds it, with no Not now there.
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        expect(find.text('Ship how?'), findsOneWidget);
        expect(notNow('decision-1'), findsNothing);

        server.ask(['Name it?']);
        await restarted.refresh();
        await openPmChat(tester);
        expect(inPanel('Decisions for you (2)'), findsOneWidget);
        expect(inPanel('Name it?'), findsOneWidget);
        expect(inPanel('Ship how?'), findsNothing);
      },
    );

    test('a decision set aside stays set aside while newer ones push it off the capped list, until it is answered', () async {
      final server = swarm()
        ..ask(['Ship how?'])
        ..ask(['Name it?']);
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final decisions = SuperTabDecisions.of(controller);
      await controller.refresh();
      await decisions.load();
      decisions.setAside([decisions.open.last]);
      expect(controller.decisionsAside, {'decision-1'});

      // The list holds the newest two of three: the oldest is still open.
      server
        ..decisionPage = 2
        ..ask(['Which colour?']);
      await controller.refresh();
      await pumpEventQueue();
      expect(decisions.open.map((d) => d.id), ['decision-3', 'decision-2']);
      expect(controller.decisionsAside, {'decision-1'});

      // Newer ones answered: it is back in the list, still set aside.
      server
        ..answerDecision('decision-3', 0)
        ..answerDecision('decision-2', 0);
      await controller.refresh();
      await pumpEventQueue();
      expect(decisions.open.map((d) => d.id), ['decision-1']);
      expect(decisions.shownIn('lead'), isEmpty);

      // Answered: nothing is kept for it.
      server.answerDecision('decision-1', 0);
      await controller.refresh();
      await pumpEventQueue();
      expect(controller.decisionsAside, isEmpty);
    });

    test(
      'a decision set aside is forgotten once it is gone from a complete list',
      () async {
        final server = swarm()
          ..decisionPage = 50
          ..ask(['Ship how?', 'Name it?']);
        final controller = server.controller(account: 'peer');
        addTearDown(controller.dispose);
        final decisions = SuperTabDecisions.of(controller);
        await controller.refresh();
        await decisions.load();
        decisions.setAside(decisions.open);

        // The reader can no longer read one: the list, holding every open
        // one, no longer has it.
        server.hideDecision('decision-1');
        await controller.refresh();
        await pumpEventQueue();

        expect(controller.decisionsAside, {'decision-2'});
      },
    );

    test('a list that does not say it holds every open one forgets nothing it left out', () async {
      // A backend from before the list said so: what is missing from it
      // may still be open.
      final server = swarm()..ask(['Ship how?', 'Name it?']);
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final decisions = SuperTabDecisions.of(controller);
      await controller.refresh();
      await decisions.load();
      decisions.setAside(decisions.open);

      server.hideDecision('decision-1');
      await controller.refresh();
      await pumpEventQueue();

      expect(controller.decisionsAside, {'decision-1', 'decision-2'});
    });

    test('on a backend from before Let PM decide, reads answered decisions as before', () async {
      final server = swarm()
        ..settledMissing = true
        ..ask(['Ship how?']);
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final decisions = SuperTabDecisions.of(controller);
      await controller.refresh();
      await decisions.load();

      expect(await decisions.answer(decisions.open.single, 1), isTrue);

      expect(decisions.error, isNull);
      expect(decisions.answered.single.choice, 1);
    });

    testWidgets(
      'a refused Let PM decide shows on its card in the Buddy chat, and Retry sends it again',
      (tester) async {
        final server = swarm()..ask(['Ship how?', 'Name it?']);
        await showView(tester, server);
        await openPmChat(tester);
        // An older backend, or one that refuses: the card says so.
        server.refuse = {
          'code': 'INVALID_COMMAND',
          'message': 'Unrecognized key: delegate',
        };

        await tester.tap(letPmDecide('decision-1'));
        await tester.pumpAndSettle();

        final card = find.byKey(const ValueKey('super-decision-decision-1'));
        expect(
          find.descendant(
            of: card,
            matching: find.text('Could not send your answer. Try again.'),
          ),
          findsOneWidget,
        );
        expect(inPanel('Ship how?'), findsOneWidget);
        // Only the card that failed says so.
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('super-decision-decision-2')),
            matching: find.text('Could not send your answer. Try again.'),
          ),
          findsNothing,
        );

        server.refuse = null;
        await tester.tap(
          find.byKey(const ValueKey('super-decision-decision-1-retry')),
        );
        await tester.pumpAndSettle();

        expect(server.posts.last['command'], {
          'type': 'decision.answer',
          'decisionId': 'decision-1',
          'delegate': true,
        });
        expect(inPanel('Ship how?'), findsNothing);
        expect(
          find.text('Could not send your answer. Try again.'),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a refused answer in the Decisions list says so once, on its card',
      (tester) async {
        final server = swarm()..ask(['Ship how?']);
        await showView(tester, server);
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        server.refuse = {'code': 'DECISION_ANSWERED', 'message': 'Answered.'};

        await tester.tap(option('decision-1', 1));
        await tester.pumpAndSettle();

        expect(find.text(SuperTabDecisions.sendFailed), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-decision-decision-1-retry')),
          findsOneWidget,
        );
      },
    );

    testWidgets('Hide folds the whole section, and Show opens it again', (
      tester,
    ) async {
      final server = swarm()..ask(['Ship how?', 'Name it?']);
      await showView(tester, server);
      await openPmChat(tester);

      await tester.tap(find.byKey(const ValueKey('super-pm-decisions-hide')));
      await tester.pumpAndSettle();
      expect(inPanel('Decisions for you (2)'), findsOneWidget);
      expect(inPanel('Ship how?'), findsNothing);
      expect(inPanel('Name it?'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('super-pm-decisions-show')));
      await tester.pumpAndSettle();
      expect(inPanel('Ship how?'), findsOneWidget);
      expect(inPanel('Name it?'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-pm-decisions-hide')),
        findsOneWidget,
      );
    });
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
    await tester.tap(find.byKey(const ValueKey('super-buddy-lead')));
    await tester.pumpAndSettle();
    await shot(tester, 'chat-with-pm');
  }, skip: shots == null);

  for (final brightness in Brightness.values) {
    testWidgets(
      'screenshots of Let PM decide, Not now and Hide, ${brightness.name}',
      (tester) async {
        final server = swarm()
          ..ask([
            'For a Mac in a Swarm without the Desktop app, start agents with the CLI only?',
          ])
          ..ask(['Which name for the setting?'], recommended: 1);
        server.decisions.first['options'] = ['Yes', 'No'];
        server.decisions.first['unblocks'] = 'Starting agents on that Mac';
        server.decisions.last['options'] = ['Offline mode', 'Work offline'];
        server.decisions.last['unblocks'] = 'The settings copy';
        final name = brightness.name;
        await showView(tester, server, brightness: brightness);
        await openPmChat(tester);
        await shot(tester, 'pm-decisions-$name');
        await tester.tap(notNow('decision-2'));
        await tester.pumpAndSettle();
        await shot(tester, 'pm-decisions-not-now-$name');
        await tester.tap(find.byKey(const ValueKey('super-pm-decisions-hide')));
        await tester.pumpAndSettle();
        await shot(tester, 'pm-decisions-hidden-$name');
        await tester.tap(find.byKey(const ValueKey('super-pm-decisions-show')));
        await tester.pumpAndSettle();
        await tester.tap(letPmDecide('decision-1'));
        await tester.pumpAndSettle();
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        await shot(tester, 'pm-decided-$name');
      },
      skip: shots == null,
    );
  }
}
