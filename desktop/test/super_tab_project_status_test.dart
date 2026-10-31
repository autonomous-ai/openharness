import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_status_card.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_STATUS_SHOTS'];
final _picture = GlobalKey();

/// Today, 16:52 on this computer's clock, as the backend sends it.
final _at = () {
  final now = DateTime.now();
  return DateTime(now.year, now.month, now.day, 16, 52);
}();

const _report =
    'Memory engine  first PR #4750, waiting on build checks\n'
    'Test bench     docs PR #4752 open, building the month\n'
    'Details: https://github.com/autonomous-ai/openharness/pull/4750.';

Map<String, dynamic> _status(String text, {DateTime? at}) => {
  'text': text,
  'at': (at ?? _at).toUtc().toIso8601String(),
  'by': 'lead-agent',
};

/// The reader is the peer, in a Swarm of two projects: web-project (its chat
/// `lead`, with a report) and Design (its chat `design-lead`).
ConversationServer swarm({Map<String, dynamic>? status}) {
  final server = ConversationServer();
  server.state['projects'] = [
    {
      ...projectFixture('lead', 'web-project', 'lead'),
      'status': status ?? _status(_report),
    },
    projectFixture('design', 'Design', 'design-lead'),
  ];
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'dee@example.com', 'role': 'collaborator'},
  ];
  server.state['conversations'] = [
    conversationFixture('lead', 'Lead'),
    {...conversationFixture('design-lead', 'Lead'), 'projectId': 'design'},
  ];
  return server;
}

Future<SuperTabController> showView(
  WidgetTester tester,
  ConversationServer server, {
  Map<String, dynamic>? initial,
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller(account: 'peer', initial: initial);
  addTearDown(c.dispose);
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
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
  return c;
}

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

Finder card(String projectId) =>
    find.byKey(ValueKey('super-project-status-$projectId'));
Finder statusText() => find.byKey(const ValueKey('super-project-status-text'));
Finder needs(String id) =>
    find.byKey(ValueKey('super-project-status-needs-$id'));
Finder answer(String id) =>
    find.byKey(ValueKey('super-project-status-answer-$id'));
Finder fold(String projectId) =>
    find.byKey(ValueKey('super-project-status-fold-$projectId'));

String plain(WidgetTester tester, Finder text) =>
    tester.widget<Text>(text).textSpan!.toPlainText();

String heading(WidgetTester tester, String projectId) => plain(
  tester,
  find.descendant(of: card(projectId), matching: find.byType(Text)).first,
);

Future<void> change(
  WidgetTester tester,
  ConversationServer server,
  SuperTabController c,
  void Function() edit,
) async {
  edit();
  server.revision++;
  await c.refresh();
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  group('the project row\'s status', () {
    test('reads text, time and writer; anything else reads as none', () {
      final status = SuperTabProject.fromJson({
        ...projectFixture('lead', 'web-project', 'lead'),
        'status': _status('Building'),
      }).status!;
      expect(status.text, 'Building');
      expect(status.at, _at.toUtc());
      expect(status.by, 'lead-agent');
      for (final value in <Object?>[
        null,
        'Building',
        {'text': ''},
        {'text': '  \n'},
        {'text': 7},
        {'at': '2026-10-31T09:00:00Z'},
      ]) {
        expect(
          SuperTabProject.fromJson({
            ...projectFixture('lead', 'web-project', 'lead'),
            'status': value,
          }).status,
          isNull,
          reason: '$value',
        );
      }
      // An older backend sends no status at all.
      expect(
        SuperTabProject.fromJson(projectFixture('lead', 'x', 'lead')).status,
        isNull,
      );
    });

    test('text at the limit is kept whole; longer is cut to it', () {
      final at = 'a' * SuperTabProjectStatus.maxText;
      expect(SuperTabProjectStatus.read({'text': at})!.text, at);
      expect(
        SuperTabProjectStatus.read({'text': '${at}bc'})!.text,
        hasLength(SuperTabProjectStatus.maxText),
      );
      // A bad time keeps the text and drops only the time.
      final odd = SuperTabProjectStatus.read({'text': 'x', 'at': 'soon'})!;
      expect(odd.text, 'x');
      expect(odd.at, isNull);
    });

    test('the time reads as a clock today and with its date before', () {
      final now = DateTime(2026, 10, 31, 18);
      expect(
        SuperTabProjectStatusCard.updatedAt(
          DateTime(2026, 10, 31, 16, 52),
          now,
        ),
        '16:52',
      );
      expect(
        SuperTabProjectStatusCard.updatedAt(DateTime(2026, 10, 30, 9, 5), now),
        'Oct 30, 09:05',
      );
      expect(
        SuperTabProjectStatusCard.updatedAt(DateTime(2025, 12, 1, 9, 5), now),
        'Dec 1 2025, 09:05',
      );
    });
  });

  group('the status card', () {
    testWidgets(
      'shows the coordinator\'s text and when it was updated, links clickable',
      (tester) async {
        await showView(tester, swarm());
        expect(card('lead'), findsOneWidget);
        expect(heading(tester, 'lead'), 'Status · updated 16:52');
        expect(plain(tester, statusText()), _report);
        // The link is its own span, without the sentence's full stop.
        final spans = <TextSpan>[];
        tester.widget<Text>(statusText()).textSpan!.visitChildren((span) {
          if (span is TextSpan && span.recognizer != null) spans.add(span);
          return true;
        });
        expect(
          spans.single.text,
          'https://github.com/autonomous-ai/openharness/pull/4750',
        );
        expect(spans.single.recognizer, isA<TapGestureRecognizer>());
        // It sits above the chat, not in it.
        expect(find.byType(SuperTabProjectStatusCard), findsOneWidget);
      },
    );

    testWidgets(
      'Needs you lists only the reader\'s open decisions in this project, and Answer opens it where Notifications answers it',
      (tester) async {
        final server = swarm()
          // decision-1: asked here, open.
          ..ask(['Model keys for live runs?'])
          // decision-2: asked in the other project.
          ..ask(['Logo?'], projectId: 'design', conversationId: 'design-lead')
          // decision-3: says this project, but its conversation is Design's.
          ..ask(['Mismatch?'], conversationId: 'design-lead')
          // decision-4: in a conversation the reader cannot read.
          ..ask(['Hidden?'], conversationId: 'private-elsewhere')
          // decision-5: asked here, already answered.
          ..ask(['Done already?']);
        server.answerDecision('decision-5', 0);
        await showView(tester, server);

        expect(needs('decision-1'), findsOneWidget);
        for (final id in [
          'decision-2',
          'decision-3',
          'decision-4',
          'decision-5',
        ]) {
          expect(needs(id), findsNothing, reason: id);
        }
        expect(find.text('Logo?'), findsNothing);
        expect(find.text('Hidden?'), findsNothing);
        expect(
          find.descendant(
            of: needs('decision-1'),
            matching: find.text('dee: Model keys for live runs?'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: needs('decision-1'),
            matching: find.text('Needs you'),
          ),
          findsOneWidget,
        );

        await tester.tap(answer('decision-1'));
        await tester.pumpAndSettle();
        // The Notifications page, with the decision's own option buttons.
        expect(find.text('Decisions'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-decision-decision-1-0')),
          findsOneWidget,
        );
        expect(server.posts, isEmpty);
      },
    );

    testWidgets(
      'hidden while there is no report and nothing waits; a decision alone shows it',
      (tester) async {
        final server = swarm(status: {});
        final c = await showView(tester, server);
        expect(card('lead'), findsNothing);

        // A decision in the other project changes nothing here.
        await change(tester, server, c, () {
          server.ask(
            ['Logo?'],
            projectId: 'design',
            conversationId: 'design-lead',
          );
        });
        expect(card('lead'), findsNothing);

        await change(tester, server, c, () => server.ask(['Ship how?']));
        expect(card('lead'), findsOneWidget);
        expect(heading(tester, 'lead'), 'Status');
        expect(statusText(), findsNothing);
        expect(needs('decision-2'), findsOneWidget);

        await change(
          tester,
          server,
          c,
          () => server.answerDecision('decision-2', 0),
        );
        expect(card('lead'), findsNothing);
      },
    );

    testWidgets(
      'folding is remembered per project on this computer, and the heading still says what waits',
      (tester) async {
        final server = swarm()..ask(['Ship how?']);
        (server.state['projects'] as List)[1]['status'] = _status(
          'Logo drafts',
        );
        final c = await showView(tester, server);

        await tester.tap(fold('lead'));
        await tester.pumpAndSettle();
        expect(statusText(), findsNothing);
        expect(needs('decision-1'), findsNothing);
        expect(heading(tester, 'lead'), 'Status · updated 16:52 · 1 needs you');
        expect(c.statusFolded('lead'), isTrue);

        await c.flush();
        final saved = server.saved!;
        expect(saved['statusFolded'], ['lead']);

        // Restarted: still folded here; the other project's card is not.
        await tester.pumpWidget(const SizedBox());
        final again = await showView(tester, server, initial: saved);
        expect(statusText(), findsNothing);
        expect(heading(tester, 'lead'), 'Status · updated 16:52 · 1 needs you');
        again.select('design-lead');
        await tester.pumpAndSettle();
        expect(plain(tester, statusText()), 'Logo drafts');

        // Shown again, and that is remembered too.
        again.select('lead');
        await tester.pumpAndSettle();
        await tester.tap(fold('lead'));
        await tester.pumpAndSettle();
        expect(plain(tester, statusText()), _report);
        await again.flush();
        expect(server.saved!['statusFolded'], isEmpty);
      },
    );

    test('the folded set keeps only the newest projects', () async {
      final server = swarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      for (var i = 0; i <= SuperTabController.statusFoldedKept; i++) {
        c.setStatusFolded('p$i', folded: true);
      }
      expect(c.statusFolded('p0'), isFalse);
      expect(c.statusFolded('p1'), isTrue);
      expect(c.statusFolded('p${SuperTabController.statusFoldedKept}'), isTrue);
      // Another account's saved view on this computer is not read.
      await c.flush();
      final other = SuperTabController(
        tabId: 'tab',
        accountId: 'someone-else',
        request: (_, _, {body}) async => const {},
        save: (_) async {},
        initial: server.saved!,
      );
      addTearDown(other.dispose);
      expect(other.statusFolded('p1'), isFalse);
    });

    testWidgets(
      'a new report replaces the card in place and adds nothing to the chat',
      (tester) async {
        final server = swarm();
        final c = await showView(tester, server);
        final messages = c.messages('lead').length;
        await change(tester, server, c, () {
          (server.state['projects'] as List)[0]['status'] = _status(
            'Memory engine  merged #4750',
            at: _at.add(const Duration(minutes: 30)),
          );
        });
        expect(plain(tester, statusText()), 'Memory engine  merged #4750');
        expect(heading(tester, 'lead'), 'Status · updated 17:22');
        expect(find.byType(SuperTabProjectStatusCard), findsOneWidget);
        expect(c.messages('lead').length, messages);
      },
    );

    testWidgets(
      'each project\'s chat shows its own card, never the one opened before',
      (tester) async {
        final server = swarm();
        (server.state['projects'] as List)[1]['status'] = _status(
          'Logo drafts',
        );
        final c = await showView(tester, server);
        c.select('design-lead');
        await tester.pumpAndSettle();
        expect(card('design'), findsOneWidget);
        expect(card('lead'), findsNothing);
        expect(plain(tester, statusText()), 'Logo drafts');
      },
    );

    testWidgets('access lost while the card is open hides it at once', (
      tester,
    ) async {
      final server = swarm()..ask(['Ship how?']);
      final c = await showView(tester, server);
      expect(needs('decision-1'), findsOneWidget);
      c.revokeAccess('You no longer have access to this Swarm.');
      await tester.pump();
      expect(card('lead'), findsNothing);
      expect(find.textContaining('Ship how?'), findsNothing);
      expect(find.textContaining('Memory engine'), findsNothing);
    });

    testWidgets(
      'losing the project drops its card, and a changed audience drops Needs you rows before the new list arrives',
      (tester) async {
        final server = swarm();
        (server.state['conversations'] as List).add({
          ...conversationFixture('plans', 'Plans'),
          'projectId': 'lead',
        });
        server.ask(['Ship how?'], conversationId: 'plans');
        final c = await showView(tester, server);
        expect(needs('decision-1'), findsOneWidget);

        // The reader loses the workgroup; the new list is slow to come.
        final slow = server.holdDecisions = Completer<void>();
        await change(tester, server, c, () {
          (server.state['conversations'] as List).removeWhere(
            (g) => (g as Map)['id'] == 'plans',
          );
          server.hideDecision('decision-1');
          server.parts.epoch++;
        });
        expect(needs('decision-1'), findsNothing);
        expect(find.textContaining('Ship how?'), findsNothing);
        server.holdDecisions = null;
        slow.complete();
        await tester.pumpAndSettle();
        expect(needs('decision-1'), findsNothing);

        // The project itself goes: no card, no text left behind.
        await change(tester, server, c, () {
          (server.state['projects'] as List).removeAt(0);
        });
        expect(card('lead'), findsNothing);
        expect(find.textContaining('Memory engine'), findsNothing);
      },
    );

    testWidgets(
      'a failed first decisions read shows the report alone, and the rows once a read succeeds',
      (tester) async {
        final server = swarm()..ask(['Ship how?']);
        server.failDecisions = true;
        final c = await showView(tester, server);
        expect(card('lead'), findsOneWidget);
        expect(needs('decision-1'), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);

        server.failDecisions = false;
        await change(tester, server, c, () {
          (server.state['projects'] as List)[0]['status'] = _status('Later');
        });
        expect(needs('decision-1'), findsOneWidget);
      },
    );

    testWidgets('a report at the limit scrolls inside the card', (
      tester,
    ) async {
      final long = List.filled(40, 'Line of progress ' * 3).join('\n');
      final text = long.substring(0, SuperTabProjectStatus.maxText);
      await showView(tester, swarm(status: _status(text)));
      expect(tester.getSize(card('lead')).height, lessThan(320));
      expect(
        find.descendant(
          of: card('lead'),
          matching: find.byType(SingleChildScrollView),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    for (final brightness in Brightness.values) {
      testWidgets('screenshot, ${brightness.name}', (tester) async {
        final server = swarm()..ask(['Model keys for live runs?']);
        final c = await showView(tester, server, brightness: brightness);
        expect(card('lead'), findsOneWidget);
        await shot(tester, 'project-status-${brightness.name}');
        await tester.tap(fold('lead'));
        await tester.pumpAndSettle();
        await shot(tester, 'project-status-folded-${brightness.name}');
        await c.flush();
      });
    }
  });
}
