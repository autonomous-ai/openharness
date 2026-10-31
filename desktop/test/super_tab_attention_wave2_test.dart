import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:flutter/services.dart';
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's wave 2 pictures there.
final shots = Platform.environment['SUPER_TAB_ATTENTION_SHOTS'];

final shotsOn = shots != null;

Map<String, dynamic> _conversation(ConversationServer server, String id) =>
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == id);

void _fromLead(ConversationServer server, String text, String id) {
  server.append(text, conversationId: id);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

Map<String, dynamic> _root(String id, String text, String at) => {
  'id': id,
  'sequence': 1,
  'author': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'text': text,
  'createdAt': at,
  'attachments': 0,
};

/// A Swarm with something for the reader: a tag in one workgroup, a decision
/// in another, plain news in a third, and threads with new replies.
ConversationServer _swarm() {
  final server = ConversationServer()..threads = true;
  server.state['projects'] = [
    projectFixture('lead', 'openharness', 'lead'),
    projectFixture('web', 'website', 'web-lead'),
  ];
  final groups = server.state['conversations'] as List;
  _conversation(server, 'offline')
    ..['projectId'] = 'lead'
    ..['number'] = 1600
    ..['title'] = 'Slack attention, wave 1';
  groups
    ..add({
      ...conversationFixture('routing', 'Routing goals piece 5'),
      'projectId': 'lead',
      'number': 1598,
    })
    ..add({
      ...conversationFixture('roster', 'Desktop roster'),
      'projectId': 'lead',
      'number': 1597,
    })
    ..add({...conversationFixture('web-lead', 'Lead'), 'projectId': 'web'});
  _fromLead(server, 'Release notes are up.', 'roster');
  server.markReadElsewhere('roster', server.revision);
  _fromLead(server, 'Mockup posted for review.', 'offline');
  server.tag('message-2', conversationId: 'offline');
  _fromLead(
    server,
    'Heavy CI is held while the account is at its limit.',
    'routing',
  );
  _fromLead(server, 'Which option should ship?', 'web-lead');
  server.ask(
    ['Ship it behind a flag?'],
    conversationId: 'web-lead',
    projectId: 'web',
  );
  server.tag('message-1', threadId: 'message-1');
  _fromLead(server, 'Weekly plan', 'lead');
  _fromLead(server, 'Looks right to me.', 'lead');
  server.messages.last['thread'] =
      server.messages[server.messages.length - 2]['id'];
  server.followedThreads = {
    'unread': [
      {
        'conversationId': 'lead',
        'rootId': server.messages[server.messages.length - 2]['id'],
        'root': _root(
          server.messages[server.messages.length - 2]['id'] as String,
          'Weekly plan: badges first, then the Threads view.',
          '2026-10-31T01:00:00Z',
        ),
        'lastReplyAt': '2026-10-31T02:00:00Z',
        'lastReplySequence': server.revision,
        'lastReplier': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
        'unreadReplies': 1,
        'follow': null,
      },
    ],
    'read': [
      {
        'conversationId': 'routing',
        'rootId': 'message-old',
        'root': _root(
          'message-old',
          'Should heavy CI wait while the account is at its job limit?',
          '2026-10-30T01:00:00Z',
        ),
        'replies': 12,
        'lastReplyAt': '2026-10-30T09:15:00Z',
        'lastReplySequence': 4,
        'lastReplier': null,
        'follow': null,
      },
    ],
    'more': false,
  };
  return server;
}

Map<String, dynamic> _item(
  String id,
  String kind,
  String chat,
  String title,
  String text,
  String at, {
  String? emoji,
  bool read = false,
}) => {
  'id': id,
  'kind': kind,
  'conversationId': chat,
  'conversationTitle': title,
  'projectName': 'openharness',
  'messageId': 'message-1',
  'messageSequence': 1,
  'threadId': null,
  'actor': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'emoji': emoji,
  'text': text,
  'createdAt': at,
  'read': read,
};

/// The attention Swarm with Activity rows, and Desktop roster muted.
ConversationServer _wave2() {
  final server = _swarm();
  server.state['activityDigest'] = 'd1';
  server.activity = {
    'items': [
      _item(
        'r1',
        'reply',
        'offline',
        'Slack attention, wave 1',
        'Fixed in 3f2a1c, ready again.',
        '2026-10-31T10:50:00.000Z',
      ),
      _item(
        'x1',
        'reaction',
        'routing',
        'Routing goals piece 5',
        'Merged after the combined CI.',
        '2026-10-31T09:00:00.000Z',
        emoji: 'check',
        read: true,
      ),
    ],
    'more': false,
  };
  _fromLead(server, 'Muted chatter.', 'roster');
  server.state['chatSettings'] = {
    'owner': {'roster': 'muted'},
  };
  return server;
}

Future<(SuperTabController, GlobalKey)> _show(
  WidgetTester tester,
  Brightness brightness, {
  String selected = 'web-lead',
}) async {
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  tester.view.devicePixelRatio = 2;
  tester.view.physicalSize = const Size(2400, 1400);
  addTearDown(tester.view.reset);
  final app = createApp(connected: true);
  addTearDown(app.dispose);
  final server = _wave2();
  final c = server.controller(
    initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': selected},
  );
  await c.refresh();
  final attention = SuperTabAttention.of(c);
  await attention.mentions.load();
  await attention.decisions.load();
  await attention.load();
  await SuperTabActivity.of(c).load();
  await c.select(selected);
  if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
  final picture = GlobalKey();
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: RepaintBoundary(
        key: picture,
        child: Scaffold(
          body: SuperTabView(
            controller: c,
            app: app,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewProject: () {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (c, picture);
}

Future<void> _done(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

Future<void> _keys(
  WidgetTester tester,
  List<LogicalKeyboardKey> held,
  LogicalKeyboardKey key,
) async {
  for (final k in held) {
    await tester.sendKeyDownEvent(k);
  }
  await tester.sendKeyEvent(key);
  for (final k in held.reversed) {
    await tester.sendKeyUpEvent(k);
  }
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  group('in the real Swarm view', () {
    testWidgets(
      'Option+Shift+Down opens the next unread chat in sidebar order, '
      'skipping the muted one; Up goes back',
      (tester) async {
        final (c, _) = await _show(tester, Brightness.dark, selected: 'lead');
        // Sidebar order: openharness (lead, offline 1600, routing 1598, roster
        // 1597 muted), then website (web-lead).
        final order = [
          for (final id in ['lead', 'offline', 'routing', 'roster', 'web-lead'])
            if (c.unreadShown(c.snapshot!.conversation(id)!)) id,
        ];
        expect(order, isNot(contains('roster')));
        await tester.tap(find.byKey(const ValueKey('super-group-lead')));
        await tester.pumpAndSettle();
        await _keys(tester, [
          LogicalKeyboardKey.altLeft,
          LogicalKeyboardKey.shiftLeft,
        ], LogicalKeyboardKey.arrowDown);
        expect(c.selectedId, 'offline');
        await _keys(tester, [
          LogicalKeyboardKey.altLeft,
          LogicalKeyboardKey.shiftLeft,
        ], LogicalKeyboardKey.arrowDown);
        expect(c.selectedId, 'routing');
        await _keys(tester, [
          LogicalKeyboardKey.altLeft,
          LogicalKeyboardKey.shiftLeft,
        ], LogicalKeyboardKey.arrowDown);
        // The muted Desktop roster is passed over.
        expect(c.selectedId, 'web-lead');
        await _keys(tester, [
          LogicalKeyboardKey.altLeft,
          LogicalKeyboardKey.shiftLeft,
        ], LogicalKeyboardKey.arrowUp);
        expect(c.selectedId, 'routing');
        await _done(tester, c);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'Option+Shift+Down and Up stop at the ends: nothing moves past the '
      'last unread chat or before the first',
      (tester) async {
        final (c, _) = await _show(tester, Brightness.dark, selected: 'lead');
        final order = [
          for (final id in ['lead', 'offline', 'routing', 'roster', 'web-lead'])
            if (c.unreadShown(c.snapshot!.conversation(id)!)) id,
        ];
        expect(order.length, greaterThan(1));
        Future<void> jump(LogicalKeyboardKey arrow) => _keys(tester, [
          LogicalKeyboardKey.altLeft,
          LogicalKeyboardKey.shiftLeft,
        ], arrow);

        // At the last unread chat, Down twice stays there.
        await tester.tap(find.byKey(ValueKey('super-group-${order.last}')));
        await tester.pumpAndSettle();
        expect(c.selectedId, order.last);
        await jump(LogicalKeyboardKey.arrowDown);
        expect(c.selectedId, order.last);
        await jump(LogicalKeyboardKey.arrowDown);
        expect(c.selectedId, order.last);

        // At the first, Up twice stays there.
        await tester.tap(find.byKey(ValueKey('super-group-${order.first}')));
        await tester.pumpAndSettle();
        expect(c.selectedId, order.first);
        await jump(LogicalKeyboardKey.arrowUp);
        expect(c.selectedId, order.first);
        await jump(LogicalKeyboardKey.arrowUp);
        expect(c.selectedId, order.first);
        await _done(tester, c);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets('Shift+Esc marks every chat read with an Undo toast; Undo puts '
        'them back', (tester) async {
      final (c, _) = await _show(tester, Brightness.dark);
      final unread = c.snapshot!.conversations.where(c.unreadShown).length;
      expect(unread, greaterThan(1));
      await tester.tap(find.byKey(const ValueKey('super-group-web-lead')));
      await tester.pumpAndSettle();
      await _keys(tester, [
        LogicalKeyboardKey.shiftLeft,
      ], LogicalKeyboardKey.escape);
      expect(c.snapshot!.conversations.where(c.unreadShown), isEmpty);
      expect(
        find.byKey(const ValueKey('super-mark-all-toast')),
        findsOneWidget,
      );
      await tester.tap(find.text('Undo'));
      await tester.pumpAndSettle();
      expect(c.snapshot!.conversations.where(c.unreadShown).length, unread);
      await _done(tester, c);
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

    testWidgets(
      'the chat menu\'s Notifications sets Muted, and the row greys',
      (tester) async {
        final (c, _) = await _show(
          tester,
          Brightness.dark,
          selected: 'offline',
        );
        await tester.tap(find.byKey(const ValueKey('super-group-options')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-notify-menu')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-notify-muted')));
        await tester.pumpAndSettle();
        expect(c.notifyOf('offline'), SuperTabNotify.muted);
        expect(
          find.byKey(const ValueKey('super-muted-offline')),
          findsOneWidget,
        );
        await _done(tester, c);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  });

  for (final brightness in Brightness.values) {
    for (final scene in ['sidebar', 'activity', 'filter', 'menu', 'toast']) {
      testWidgets('wave 2: $scene in ${brightness.name}', (tester) async {
        if (!shotsOn) return;
        final (c, picture) = await _show(tester, brightness);
        switch (scene) {
          case 'activity':
            await tester.tap(find.byKey(const ValueKey('super-activity')));
            await tester.pumpAndSettle();
          case 'filter':
            await tester.tap(find.byKey(const ValueKey('super-unread-only')));
            await tester.pumpAndSettle();
          case 'menu':
            await tester.tap(find.byKey(const ValueKey('super-group-options')));
            await tester.pumpAndSettle();
            await tester.tap(find.byKey(const ValueKey('super-notify-menu')));
            await tester.pumpAndSettle();
          case 'toast':
            await tester.tap(
              find.byKey(const ValueKey('super-group-web-lead')),
            );
            await tester.pumpAndSettle();
            await _keys(tester, [
              LogicalKeyboardKey.shiftLeft,
            ], LogicalKeyboardKey.escape);
        }
        if (scene == 'menu') {
          // The menu is a route of its own, outside the screen's boundary.
          await captureWindow(tester, shots, 'wave2-$scene-${brightness.name}');
        } else {
          await captureBoundary(
            tester,
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            shots,
            'wave2-$scene-${brightness.name}',
          );
        }
        await _done(tester, c);
      }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
    }
  }
}
