import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/decisions_page.dart';
import 'package:harness/super_tabs/message_row.dart'
    show SuperTabMessageHighlight;
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';
import 'super_tab_tasks_view_test.dart' show tasksServer;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_NEEDS_YOU_SHOTS'];
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

/// The "needs you" bar under a chat and the Tasks count in its header
/// (task #3017: Leo's "can't be clicked", Dee's badge on the icon's corner).
/// The reader is `owner`; the task is the fixture's `offline` group.
Finder bar() => find.byKey(const ValueKey('super-needs-human-builder'));
Finder row(String id) => find.byKey(ValueKey('super-message-$id'));

ConversationServer server({
  String status = 'needs_human',
  String? askedOf,
  Map<String, dynamic>? liveness,
}) {
  final server = ConversationServer();
  server.state['agents'] = [
    {
      'id': 'builder',
      'name': 'Builder',
      'machineId': 'host',
      'harnessId': 'session',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  final group = (server.state['conversations'] as List)[1] as Map;
  group['agentIds'] = ['builder'];
  group['assignment'] = {
    'id': 'attempt',
    'agentId': 'builder',
    'status': status,
    'result': 'Which device should I test?',
    'askedOf': ?askedOf,
  };
  if (liveness != null) group['liveness'] = liveness;
  return server;
}

/// The agent's own question as a message, then enough chat after it that
/// opening it has to scroll.
void asked(ConversationServer server, {int notes = 60}) {
  server.append('Which device should I test?', conversationId: 'offline');
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'builder',
    'name': 'Builder',
  };
  for (var i = 0; i < notes; i++) {
    server.append('Note $i', conversationId: 'offline');
  }
}

Future<SuperTabController> show(
  WidgetTester tester,
  ConversationServer server, {
  ValueChanged<SuperTabAgent>? onOpenTerminal,
  Brightness brightness = Brightness.light,
  bool terminalsVisible = false,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  addTearDown(c.dispose);
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => RepaintBoundary(key: _picture, child: child),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: onOpenTerminal ?? (_) {},
          terminalsVisible: terminalsVisible,
          terminal: terminalsVisible
              ? const ColoredBox(color: Colors.black, child: SizedBox.expand())
              : null,
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  if (c.snapshot?.conversation('offline') != null) {
    c.select('offline');
    await tester.pumpAndSettle();
  }
  return c;
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  group('who the bar shows for', () {
    testWidgets('a task blocked on CI shows no bar', (tester) async {
      await show(tester, server(status: 'blocked'));
      expect(bar(), findsNothing);
    });

    testWidgets('a task blocked on the reader by name shows no bar either', (
      tester,
    ) async {
      // Blocked is a wait on CI, a review or a machine, never a question.
      await show(tester, server(status: 'blocked', askedOf: 'owner'));
      expect(bar(), findsNothing);
    });

    testWidgets('a question to another person shows no bar', (tester) async {
      await show(tester, server(askedOf: 'peer'));
      expect(bar(), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await show(
        tester,
        server(
          liveness: {'state': 'waiting', 'why': 'person', 'personId': 'peer'},
        ),
      );
      expect(bar(), findsNothing);
    });

    testWidgets('a question to the reader shows the bar', (tester) async {
      await show(tester, server(askedOf: 'owner'));
      expect(find.text('Builder needs you'), findsOneWidget);
    });

    for (final brightness in Brightness.values) {
      testWidgets('looks right in ${brightness.name}', (tester) async {
        await show(tester, server(askedOf: 'owner'), brightness: brightness);
        await shot(tester, 'needs-you-bar-${brightness.name}');
      });
    }

    testWidgets('a question nobody is named for, from an older backend, '
        'still shows it', (tester) async {
      await show(tester, server());
      expect(find.text('Builder needs you'), findsOneWidget);
    });

    testWidgets('a decision asked of the reader shows it while the agent '
        'keeps working', (tester) async {
      final s = server(status: 'working');
      s.ask(['Ship how?'], conversationId: 'offline');
      await show(tester, s);
      expect(find.text('Builder needs you'), findsOneWidget);
    });
  });

  group('the click', () {
    testWidgets('opens the question in the chat, lit', (tester) async {
      final s = server(askedOf: 'owner');
      asked(s);
      final opened = <String>[];
      await show(tester, s, onOpenTerminal: (a) => opened.add(a.id));
      expect(row('message-1').hitTestable(), findsNothing);
      await tester.tap(bar());
      await tester.pumpAndSettle();
      expect(row('message-1').hitTestable(), findsOneWidget);
      expect(
        tester
            .widget<SuperTabMessageHighlight>(
              find.ancestor(
                of: row('message-1'),
                matching: find.byType(SuperTabMessageHighlight),
              ),
            )
            .on,
        isTrue,
      );
      expect(opened, isEmpty);
    });

    testWidgets('lights the message that says the question, not the agent’s '
        'later ones', (tester) async {
      final s = server(askedOf: 'owner');
      asked(s, notes: 30);
      // The agent goes on talking after it asked.
      s.append('Still working on the build.', conversationId: 'offline');
      s.messages.last['author'] = {
        'kind': 'agent',
        'id': 'builder',
        'name': 'Builder',
      };
      for (var i = 0; i < 25; i++) {
        s.append('More $i', conversationId: 'offline');
      }
      await show(tester, s);
      await tester.tap(bar());
      await tester.pumpAndSettle();
      expect(row('message-1').hitTestable(), findsOneWidget);
      expect(
        tester
            .widget<SuperTabMessageHighlight>(
              find.ancestor(
                of: row('message-1'),
                matching: find.byType(SuperTabMessageHighlight),
              ),
            )
            .on,
        isTrue,
      );
    });

    testWidgets('a terminal already open says where the question is', (
      tester,
    ) async {
      final opened = <String>[];
      await show(
        tester,
        server(askedOf: 'owner'),
        onOpenTerminal: (a) => opened.add(a.id),
        terminalsVisible: true,
      );
      await tester.tap(bar());
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      expect(
        find.descendant(
          of: find.byType(SnackBar),
          matching: find.textContaining('question is in its terminal'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a decision opens where decisions are answered', (
      tester,
    ) async {
      final s = server(status: 'working');
      s.ask(['Ship how?'], conversationId: 'offline');
      await show(tester, s);
      await tester.tap(bar());
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabDecisionsPage), findsOneWidget);
      expect(find.text('Ship how?'), findsWidgets);
    });

    testWidgets('with only a terminal to go to, it opens that terminal', (
      tester,
    ) async {
      final opened = <String>[];
      await show(
        tester,
        server(askedOf: 'owner'),
        onOpenTerminal: (a) => opened.add(a.id),
      );
      await tester.tap(bar());
      await tester.pumpAndSettle();
      expect(opened, ['builder']);
    });
  });

  group('the Tasks count', () {
    Future<void> tasks(WidgetTester tester, Brightness brightness) async {
      await show(tester, tasksServer(), brightness: brightness);
    }

    for (final brightness in Brightness.values) {
      testWidgets('sits on the icon’s top-right corner in ${brightness.name}, '
          'with its tooltip', (tester) async {
        await tasks(tester, brightness);
        final icon = tester.getRect(find.byKey(const ValueKey('super-tasks')));
        final badge = tester.getRect(
          find.byKey(const ValueKey('super-tasks-badge')),
        );
        expect(badge.center.dx, greaterThan(icon.center.dx));
        expect(badge.center.dy, lessThan(icon.center.dy));
        expect(badge.left, lessThan(icon.right));
        expect(badge.right, greaterThan(icon.right - 4));
        expect(badge.top, lessThan(icon.top + 6));
        await shot(tester, 'tasks-badge-${brightness.name}');
        expect(
          tester
              .widget<SuperTabCountBadge>(
                find.byKey(const ValueKey('super-tasks-badge')),
              )
              .tooltip,
          '1 task needs you',
        );
      });
    }
  });
}
