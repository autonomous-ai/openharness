import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_UNREAD_SHOTS'];
final _picture = GlobalKey();

const _line = ValueKey('super-new-messages-line');
const _jump = ValueKey('super-jump-unread');
const _buddyChat = 'buddy-peer-lead';

const _updates = [
  'Reading the offline queue before the reconnect.',
  'The reconnect keeps every queued edit in order.',
  'Two devices editing at once settle on the newest edit.',
  'Pushed the branch; the checks are running.',
];

Future<void> _shot(WidgetTester tester, String name) async {
  if (shots == null) return;
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1.5);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

/// A Swarm read by the peer: the Lead chat and the peer's own Buddy chat,
/// each with 60 messages from an agent, read on another device up to 20.
ConversationServer _swarm() {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'scholes@example.com', 'role': 'collaborator'},
  ];
  server.state['conversations'] = [
    conversationFixture('lead', 'Lead'),
    {
      ...conversationFixture(_buddyChat, "scholes's Buddy"),
      'projectId': 'lead',
      'kind': 'buddy',
      'buddyOwnerId': 'peer',
    },
  ];
  for (final (chat, author) in [
    ('lead', {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'}),
    (_buddyChat, {'kind': 'agent', 'id': 'buddy-agent', 'name': 'Buddy'}),
  ]) {
    for (var i = 1; i <= 60; i++) {
      server.append(
        '${_updates[i % _updates.length]} ($i)',
        conversationId: chat,
      );
      server.messages.last['author'] = author;
    }
  }
  server
    ..markReadElsewhere('lead', 20, reader: 'peer')
    ..markReadElsewhere(_buddyChat, 81, reader: 'peer');
  return server;
}

Future<SuperTabController> _show(
  WidgetTester tester,
  ConversationServer server,
  Brightness brightness,
) async {
  await tester.binding.setSurfaceSize(const Size(1200, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller(account: 'peer');
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
          onOpenTerminal: (_) {},
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Finder _list(String chat) =>
    find.byKey(PageStorageKey('super-messages-tab-$chat'));

ScrollPosition _scroll(WidgetTester tester, String chat) =>
    tester.widget<ScrollView>(_list(chat)).controller!.position;

/// Scrolls [chat]'s list by [by] in mouse-wheel steps, as a reader does.
Future<void> _wheel(WidgetTester tester, String chat, double by) async {
  final at = tester.getCenter(_list(chat));
  final step = by.sign * 100;
  for (var moved = 0.0; moved.abs() < by.abs(); moved += step) {
    tester.binding.handlePointerEvent(
      PointerScrollEvent(position: at, scrollDelta: Offset(0, step)),
    );
    await tester.pump();
  }
  await tester.pumpAndSettle();
}

/// The pill, when shown, is clear of the message list: it covers no message.
void _coversNoMessage(WidgetTester tester, String chat) {
  if (find.byKey(_jump).evaluate().isEmpty) return;
  final pill = tester.getRect(find.byKey(_jump));
  final list = tester.getRect(_list(chat));
  expect(pill.bottom, lessThanOrEqualTo(list.top));
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    final theme = brightness.name;

    testWidgets('project chat read past the line ($theme)', (tester) async {
      final server = _swarm();
      await _show(tester, server, brightness);
      final position = _scroll(tester, 'lead');
      await _wheel(tester, 'lead', 700);
      await _shot(tester, 'project-read-past-line-$theme');
      expect(find.byKey(_line).hitTestable(), findsNothing);
      expect(position.extentAfter, greaterThan(40));
      // Seen when the chat opened at it: reading on needs no way back.
      expect(find.byKey(_jump), findsNothing);
      _coversNoMessage(tester, 'lead');
    });

    testWidgets('project chat read back above the line ($theme)', (
      tester,
    ) async {
      final server = _swarm();
      await _show(tester, server, brightness);
      await _wheel(tester, 'lead', -900);
      await _shot(tester, 'project-read-above-line-$theme');
      expect(find.byKey(_line).hitTestable(), findsNothing);
      expect(find.byKey(_jump), findsNothing);
      _coversNoMessage(tester, 'lead');
    });

    testWidgets('Buddy chat with Decisions for you, read past the line '
        '($theme)', (tester) async {
      final server = _swarm()
        ..ask([
          'Ship the offline queue this week?',
        ], conversationId: _buddyChat);
      final c = await _show(tester, server, brightness);
      await c.select(_buddyChat);
      await tester.pumpAndSettle();
      expect(find.textContaining('Decisions for you'), findsOne);
      await _wheel(tester, _buddyChat, 700);
      await _shot(tester, 'buddy-read-past-line-$theme');
      expect(find.byKey(_line).hitTestable(), findsNothing);
      expect(find.byKey(_jump), findsNothing);
      _coversNoMessage(tester, _buddyChat);
    });

    testWidgets('Buddy chat opened at a linked message, with Decisions for '
        'you ($theme)', (tester) async {
      final server = _swarm()
        ..ask([
          'Ship the offline queue this week?',
        ], conversationId: _buddyChat);
      final c = await _show(tester, server, brightness);
      // The Buddy chat's newest message: its messages are 61 to 120.
      c.openMessageLink(
        const SwarmMessageLink(
          tabId: 'tab',
          conversationId: _buddyChat,
          messageId: 'message-118',
        ),
      );
      await tester.pumpAndSettle();
      await _shot(tester, 'buddy-opened-at-link-$theme');
      expect(c.selectedId, _buddyChat);
      expect(find.byKey(_jump), findsOne);
      final decisions = tester.getRect(
        find.byKey(const ValueKey('super-pm-decisions')),
      );
      final pill = tester.getRect(find.byKey(_jump));
      // Below Decisions for you, above the messages: covering neither.
      expect(pill.top, greaterThanOrEqualTo(decisions.bottom));
      _coversNoMessage(tester, _buddyChat);
      await tester.tap(find.byKey(_jump));
      await tester.pumpAndSettle();
      await _shot(tester, 'buddy-back-at-line-$theme');
      expect(find.byKey(_jump), findsNothing);
      expect(
        tester.getRect(find.byKey(const ValueKey('super-pm-decisions'))),
        decisions,
      );
    });
  }
}
