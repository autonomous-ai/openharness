import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/notifications.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'super_tab_decisions_test.dart' show swarm;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show MemoryStore;

/// What would have reached the operating system.
class ShownNotices implements SystemNotifier {
  final shown = <({String title, String body})>[];
  final routes = <(String, String)>[];
  @override
  bool get supported => true;
  @override
  bool get clickOpensAgent => false;
  @override
  String get deniedAdvice => '';
  @override
  Future<NotificationPermission> authorize() async =>
      NotificationPermission.granted;
  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) async {
    shown.add((title: title, body: body));
    routes.add((machineId, agentId));
    return NotificationPermission.granted;
  }

  @override
  Future<void> withdraw(String id) async {}
  @override
  set onTap(void Function(String machineId, String agentId)? handler) {}
}

Map<String, dynamic> messageRow({Object? mentions}) => {
  'id': 'm1',
  'conversationId': 'lead',
  'sequence': 1,
  'text': 'Please confirm the release.',
  'author': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'mentions': ?mentions,
};

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_MENTION_SHOTS'];
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

Future<SuperTabController> showView(
  WidgetTester tester,
  ConversationServer server,
) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
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
  addTearDown(c.dispose);
  return c;
}

String minutesAgo(int minutes) => DateTime.now()
    .toUtc()
    .subtract(Duration(minutes: minutes))
    .toIso8601String();

/// The styles of every run of [text] painted in the tree.
List<TextStyle?> runsOf(WidgetTester tester, String text) => [
  for (final rich in tester.widgetList<RichText>(find.byType(RichText)))
    ..._runs(rich.text, null, text),
];

Iterable<TextStyle?> _runs(
  InlineSpan span,
  TextStyle? inherited,
  String text,
) sync* {
  if (span is! TextSpan) return;
  final style = inherited?.merge(span.style) ?? span.style;
  if (span.text == text) yield style;
  for (final child in span.children ?? const <InlineSpan>[]) {
    yield* _runs(child, style, text);
  }
}

Future<void> showText(WidgetTester tester, String text, List<String> names) =>
    tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(body: SuperTabMessageText(text, mentions: names)),
      ),
    );

Finder notificationsEntry() =>
    find.byKey(const ValueKey('super-notifications'));

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  group('mention fields', () {
    test('a message names the people it tags', () {
      final message = SuperTabMessage.fromJson(
        messageRow(mentions: ['owner', 'dee']),
      );
      expect(message.mentions, ['owner', 'dee']);
    });

    test('a message from an older backend tags nobody', () {
      expect(SuperTabMessage.fromJson(messageRow()).mentions, isEmpty);
    });

    test('the tab state counts the reader\'s waiting tags', () {
      final server = ConversationServer();
      server.state['mentionsWaiting'] = 3;
      expect(SuperTabSnapshot.fromJson(server.state).mentionsWaiting, 3);
    });

    test('an older backend\'s state has no waiting tags', () {
      final server = ConversationServer();
      expect(SuperTabSnapshot.fromJson(server.state).mentionsWaiting, 0);
    });
  });

  group('notification list', () {
    /// [swarm] with a workgroup the reader is tagged in.
    ConversationServer taggedInPlans() {
      final server = swarm();
      (server.state['conversations'] as List).add({
        ...conversationFixture('plans', 'Plans'),
        'projectId': 'lead',
      });
      return server..tag('message-1', conversationId: 'plans', text: 'Private');
    }

    /// The reader loses the workgroup their tag is in, and the Lead tags them
    /// elsewhere: one still waits. Who may read what moved.
    void leaveChatTaggedElsewhere(ConversationServer server) {
      (server.state['conversations'] as List).removeWhere(
        (g) => (g as Map)['id'] == 'plans',
      );
      server.mentions.removeWhere((m) => m['conversationId'] == 'plans');
      server.state['mentionsWaiting'] =
          (server.state['mentionsWaiting'] as int) - 1;
      server.tag('message-2', text: 'Here instead');
      server.parts.epoch++;
    }

    test('drops the tags of a conversation the reader leaves at once, '
        'while the new list is slow to come', () async {
      final server = taggedInPlans();
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final mentions = SuperTabMentions.of(controller);
      await controller.refresh();
      await pumpEventQueue();
      expect(mentions.waiting.map((m) => m.text), ['Private']);

      leaveChatTaggedElsewhere(server);
      final slow = server.holdMentions = Completer<void>();
      await controller.refresh();
      await pumpEventQueue();
      expect(controller.snapshot!.mentionsWaiting, 1);
      expect(mentions.waiting, isEmpty);
      expect(mentions.earlier, isEmpty);

      server.holdMentions = null;
      slow.complete();
      await pumpEventQueue();
      expect(mentions.waiting.map((m) => m.text), ['Here instead']);
    });

    test('a tag the reader can no longer read stays gone when the new list '
        'fails', () async {
      final server = taggedInPlans();
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final mentions = SuperTabMentions.of(controller);
      await controller.refresh();
      await pumpEventQueue();
      expect(mentions.waiting, hasLength(1));

      leaveChatTaggedElsewhere(server);
      server.failMentions = true;
      await controller.refresh();
      await pumpEventQueue();
      expect(mentions.waiting, isEmpty);
      expect(mentions.error, isNotNull);
    });

    test('reads waiting and earlier tags, newest first', () async {
      final server = ConversationServer()
        ..tag('m1', text: 'First')
        ..tag('m2', text: 'Second')
        ..tag('m3', text: 'Third');
      server.mentions[0]
        ..['resolvedAt'] = '2026-10-24T05:30:00Z'
        ..['resolvedBy'] = 'reply';
      server.state['mentionsWaiting'] = 2;
      final controller = server.controller();
      final mentions = SuperTabMentions.of(controller);
      await controller.refresh();
      await mentions.load();
      expect(mentions.waiting.map((m) => m.text), ['Third', 'Second']);
      expect(mentions.earlier.map((m) => m.text), ['First']);
      final first = mentions.waiting.first;
      expect(first.projectName, 'web-project');
      expect(first.conversationTitle, 'Lead');
      expect(first.leadName, 'Wren');
      expect(first.messageId, 'm3');
      expect(first.createdAt, DateTime.utc(2026, 10, 24, 5));
      controller.dispose();
    });

    test('reports a new tag once, never the ones already waiting', () async {
      final server = ConversationServer()..tag('m1', text: 'Old');
      final controller = server.controller();
      final arrived = <String>[];
      SuperTabMentions.of(controller).onArrived = (m) => arrived.add(m.text);
      await controller.refresh();
      await pumpEventQueue();
      expect(arrived, isEmpty);
      server.tag('m2', text: 'New');
      await controller.refresh();
      await pumpEventQueue();
      await controller.refresh();
      await pumpEventQueue();
      expect(arrived, ['New']);
      controller.dispose();
    });

    test('a new tag is read even when the count stays the same', () async {
      final server = ConversationServer()..tag('m1', text: 'First');
      final controller = server.controller();
      final mentions = SuperTabMentions.of(controller);
      final arrived = <String>[];
      mentions.onArrived = (m) => arrived.add(m.text);
      await controller.refresh();
      await pumpEventQueue();
      // The first is answered and a second arrives between two reads: 1 → 1.
      server.mentions.single
        ..['resolvedAt'] = '2026-10-24T05:10:00Z'
        ..['resolvedBy'] = 'reply';
      server.tag('m2', text: 'Second');
      server.state['mentionsWaiting'] = 1;
      await controller.refresh();
      await pumpEventQueue();
      expect(arrived, ['Second']);
      expect(mentions.waiting.map((m) => m.text), ['Second']);
      expect(mentions.earlier.map((m) => m.text), ['First']);
      controller.dispose();
    });

    test('a change during a read is read once more after it', () async {
      final server = ConversationServer()..tag('m1', text: 'First');
      final controller = server.controller();
      final mentions = SuperTabMentions.of(controller);
      final hold = server.holdMentions = Completer<void>();
      await controller.refresh();
      await pumpEventQueue();
      final reads = server.mentionReads;
      server.tag('m2', text: 'Second');
      await controller.refresh();
      server.revision++;
      await controller.refresh();
      server.holdMentions = null;
      hold.complete();
      await pumpEventQueue();
      // The held read, then exactly one more (both lists each time).
      expect(server.mentionReads - reads, 2);
      expect(mentions.waiting.map((m) => m.text), ['Second', 'First']);
      controller.dispose();
    });

    test('a Swarm change that leaves the count and digest alone reads no '
        'tags and tells nobody', () async {
      final server = ConversationServer()..tag('m1', text: 'First');
      server.state['mentionsDigest'] = 'digest-1';
      final controller = server.controller();
      addTearDown(controller.dispose);
      final mentions = SuperTabMentions.of(controller);
      await controller.refresh();
      await pumpEventQueue();
      expect(mentions.waiting.map((m) => m.text), ['First']);
      final reads = server.mentionReads;
      var notified = 0;
      mentions.addListener(() => notified++);
      for (var i = 0; i < 5; i++) {
        final before = controller.lastChangedAt;
        server.append('Unrelated $i');
        await controller.refresh();
        await pumpEventQueue();
        expect(controller.lastChangedAt, isNot(before));
      }
      expect(server.mentionReads - reads, 0);
      expect(notified, 0);

      // One answered and another arrived: the count stays, the digest moves.
      server.mentions.single
        ..['resolvedAt'] = '2026-10-24T05:10:00Z'
        ..['resolvedBy'] = 'reply';
      server.tag('m2', text: 'Second');
      server.state['mentionsWaiting'] = 1;
      server.state['mentionsDigest'] = 'digest-2';
      await controller.refresh();
      await pumpEventQueue();
      // Waiting once and Earlier once.
      expect(server.mentionReads - reads, 2);
      expect(notified, 1);
      expect(mentions.waiting.map((m) => m.text), ['Second']);
      expect(mentions.earlier.map((m) => m.text), ['First']);
    });

    test('a failed read is tried again on the next Swarm change, digest or '
        'not', () async {
      final server = ConversationServer()..tag('m1', text: 'First');
      server.state['mentionsDigest'] = 'digest-1';
      server.failMentions = true;
      final controller = server.controller();
      addTearDown(controller.dispose);
      final mentions = SuperTabMentions.of(controller);
      await controller.refresh();
      await pumpEventQueue();
      expect(mentions.error, isNotNull);
      server.failMentions = false;
      server.append('Unrelated');
      await controller.refresh();
      await pumpEventQueue();
      expect(mentions.error, isNull);
      expect(mentions.waiting.map((m) => m.text), ['First']);
    });

    test('without a digest, every Swarm change while a tag waits reads the '
        'lists again, and the same lists tell nobody', () async {
      final server = ConversationServer()..tag('m1', text: 'First');
      final controller = server.controller();
      addTearDown(controller.dispose);
      final mentions = SuperTabMentions.of(controller);
      await controller.refresh();
      await pumpEventQueue();
      final reads = server.mentionReads;
      var notified = 0;
      mentions.addListener(() => notified++);
      server.append('Unrelated');
      await controller.refresh();
      await pumpEventQueue();
      expect(server.mentionReads - reads, 2);
      expect(notified, 0);
      expect(mentions.waiting.map((m) => m.text), ['First']);
    });

    test(
      'a backend without the list shows an empty list, not an error',
      () async {
        final server = ConversationServer()..mentionsMissing = true;
        final controller = server.controller();
        final mentions = SuperTabMentions.of(controller);
        await controller.refresh();
        await mentions.load();
        expect(mentions.error, isNull);
        expect(mentions.waiting, isEmpty);
        expect(mentions.earlier, isEmpty);
        controller.dispose();
      },
    );

    test(
      'a tag that expires empties an open list with no new revision',
      () async {
        final server = ConversationServer()..tag('m1', text: 'Old');
        final controller = server.controller();
        final mentions = SuperTabMentions.of(controller);
        await controller.refresh();
        await pumpEventQueue();
        expect(mentions.waiting, hasLength(1));
        // 30 days on, the backend drops it; the tab itself did not change.
        server.mentions.clear();
        server.state['mentionsWaiting'] = 0;
        await controller.refresh();
        await pumpEventQueue();
        expect(mentions.waiting, isEmpty);
        controller.dispose();
      },
    );

    test('a backend without tags is never asked for them', () async {
      final server = ConversationServer();
      final controller = server.controller();
      SuperTabMentions.of(controller);
      await controller.refresh();
      await pumpEventQueue();
      expect(server.mentionReads, 0);
      controller.dispose();
    });

    test('mark done sends the tag\'s done and moves it to earlier', () async {
      final server = ConversationServer()..tag('m1');
      final controller = server.controller();
      final mentions = SuperTabMentions.of(controller);
      await controller.refresh();
      await mentions.load();
      expect(await mentions.done(mentions.waiting.single), isTrue);
      expect(server.posts.last['command'], {
        'type': 'mention.done',
        'mentionId': 'mention-1',
      });
      expect(mentions.waiting, isEmpty);
      expect(mentions.earlier.single.resolvedBy, 'done');
      controller.dispose();
    });
  });

  group('notifications view', () {
    testWidgets('the entry counts what waits and lists Waiting and Earlier', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append('Earlier ask')
        ..append('Ship it?')
        ..tag('message-1', text: 'Earlier ask', createdAt: minutesAgo(90))
        ..tag('message-2', text: 'Ship it?', createdAt: minutesAgo(3));
      server.mentions[0]
        ..['resolvedAt'] = minutesAgo(80)
        ..['resolvedBy'] = 'reply';
      server.state['mentionsWaiting'] = 1;
      await showView(tester, server);
      expect(
        find.descendant(of: notificationsEntry(), matching: find.text('1')),
        findsOneWidget,
      );
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      final waiting = find.byKey(const ValueKey('super-mention-mention-2'));
      final earlier = find.byKey(const ValueKey('super-mention-mention-1'));
      expect(find.text('Waiting'), findsOneWidget);
      expect(find.text('Earlier'), findsOneWidget);
      expect(
        tester.getTopLeft(waiting).dy,
        lessThan(tester.getTopLeft(earlier).dy),
      );
      for (final text in [
        'web-project · Lead',
        'Wren',
        'Ship it?',
        '3 min ago',
      ]) {
        expect(
          find.descendant(of: waiting, matching: find.text(text)),
          findsOneWidget,
          reason: text,
        );
      }
      expect(
        find.descendant(of: earlier, matching: find.text('1 h ago')),
        findsOneWidget,
      );
    });

    testWidgets('a tag shows the Lead’s avatar beside its name', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append('Ship it?')
        ..tag('message-1', text: 'Ship it?', leadId: 'lead-agent');
      server.state['agents'] = [
        {
          'id': 'lead-agent',
          'name': 'Lead',
          'displayName': 'Wren',
          'machineId': 'm',
          'harnessId': 'h',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
          'avatar': {'kind': 'preset', 'key': 'owl'},
        },
      ];
      await showView(tester, server);
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('super-mention-mention-1'));
      expect(
        find.descendant(of: row, matching: find.text('🦉')),
        findsOneWidget,
      );
    });

    testWidgets('a person’s tag shows their avatar and username', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append('Ship it?')
        ..tag('message-1', text: 'Ship it?', leadId: 'dee');
      server.mentions.last['leadName'] = 'dee';
      server.state['people'] = [
        {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
        {
          'id': 'dee',
          'email': 'dee@example.com',
          'role': 'collaborator',
          'username': 'deedee',
          'avatar': {'kind': 'preset', 'key': 'fox'},
        },
      ];
      await showView(tester, server);
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('super-mention-mention-1'));
      expect(
        find.descendant(of: row, matching: find.text('🦊')),
        findsOneWidget,
      );
      // The name they go by now, though they were tagged under another.
      expect(
        find.descendant(of: row, matching: find.text('deedee')),
        findsOneWidget,
      );
    });

    testWidgets('mark done moves the tag to Earlier and clears the count', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append('Ship it?')
        ..tag('message-1', text: 'Ship it?', createdAt: minutesAgo(3));
      await showView(tester, server);
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mark done'));
      await tester.pumpAndSettle();
      expect(find.text('Mark done'), findsNothing);
      expect(find.text('Nothing waiting for you.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-mention-mention-1')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: notificationsEntry(), matching: find.text('1')),
        findsNothing,
      );
    });

    testWidgets('a tag too far back says so and stays on the list', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['conversations'] = [
        ...server.state['conversations'] as List,
        conversationFixture('group', 'Release'),
      ];
      // More than the 50 pages opening a tag reads back.
      for (var i = 1; i <= 5050; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      server.tag('message-1', conversationId: 'group', text: 'Note 1');
      final c = await showView(tester, server);
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-mention-mention-1')));
      await tester.pumpAndSettle();
      expect(
        find.text('This message is too far back to open.'),
        findsOneWidget,
      );
      expect(find.text('Waiting'), findsOneWidget);
      expect(c.selectedId, isNot('group'));
    });

    testWidgets('a tag newer than what was read earlier opens at its message', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['conversations'] = [
        ...server.state['conversations'] as List,
        conversationFixture('group', 'Release'),
      ];
      for (var i = 1; i <= 100; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      final c = await showView(tester, server);
      // Read earlier up to 100, then 100 more arrived while away.
      await c.loadMessages('group');
      expect(c.messages('group').last.id, 'message-100');
      for (var i = 101; i <= 200; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      server.tag('message-150', conversationId: 'group', text: 'Note 150');
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-mention-mention-1')));
      await tester.pumpAndSettle();
      expect(
        find.text('This message is no longer in the conversation.'),
        findsNothing,
      );
      expect(c.selectedId, 'group');
      expect(
        find.byKey(const ValueKey('super-message-message-150')).hitTestable(),
        findsOneWidget,
      );
    });

    testWidgets('a tag among more than a page that arrived since opens too', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['conversations'] = [
        ...server.state['conversations'] as List,
        conversationFixture('group', 'Release'),
      ];
      for (var i = 1; i <= 100; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      final c = await showView(tester, server);
      await c.loadMessages('group');
      // More than a page since: the latest page (151..250) replaces what is
      // held, and the tag is on the page before it.
      for (var i = 101; i <= 250; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      server.tag('message-120', conversationId: 'group', text: 'Note 120');
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-mention-mention-1')));
      await tester.pumpAndSettle();
      expect(
        find.text('This message is no longer in the conversation.'),
        findsNothing,
      );
      expect(c.selectedId, 'group');
      expect(
        find.byKey(const ValueKey('super-message-message-120')).hitTestable(),
        findsOneWidget,
      );
    });

    testWidgets('a tag far past a reader scrolled up opens at its message', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['conversations'] = [
        ...server.state['conversations'] as List,
        conversationFixture('group', 'Release'),
      ];
      for (var i = 1; i <= 100; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      final c = await showView(tester, server);
      await c.loadMessages('group');
      // The reader had scrolled up there, then 600 arrived: more than the
      // pages that join below them.
      c.readingBack('group', true);
      for (var i = 101; i <= 700; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      server.tag('message-650', conversationId: 'group', text: 'Note 650');
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-mention-mention-1')));
      await tester.pumpAndSettle();
      expect(
        find.text('This message is no longer in the conversation.'),
        findsNothing,
      );
      expect(c.selectedId, 'group');
      expect(
        find.byKey(const ValueKey('super-message-message-650')).hitTestable(),
        findsOneWidget,
      );
    });

    testWidgets(
      'a tag opened while a poll reads the rows held below a reader scrolled '
      'up still opens at its message',
      (tester) async {
        final server = ConversationServer();
        server.state['conversations'] = [
          ...server.state['conversations'] as List,
          conversationFixture('group', 'Release'),
        ];
        for (var i = 1; i <= 100; i++) {
          server.append('Note $i', conversationId: 'group');
        }
        final c = await showView(tester, server);
        await c.loadMessages('group');
        c.readingBack('group', true);
        for (var i = 101; i <= 700; i++) {
          server.append('Note $i', conversationId: 'group');
        }
        // Three pages join below the reader; newer ones wait.
        for (var poll = 0; poll < 3; poll++) {
          await c.loadMessages('group');
        }
        expect(c.hasNewer('group'), isTrue);
        server.tag('message-650', conversationId: 'group', text: 'Note 650');
        await tester.tap(notificationsEntry());
        await tester.pumpAndSettle();
        // A background poll is reading the rows held when the tag opens.
        final held = server.holdReads = Completer<void>();
        final poll = c.loadMessages('group');
        await tester.tap(find.byKey(const ValueKey('super-mention-mention-1')));
        await tester.pump();
        server.holdReads = null;
        held.complete();
        await poll;
        await tester.pumpAndSettle();
        expect(
          find.text('This message is no longer in the conversation.'),
          findsNothing,
        );
        expect(c.selectedId, 'group');
        expect(
          find.byKey(const ValueKey('super-message-message-650')).hitTestable(),
          findsOneWidget,
        );
      },
    );

    testWidgets('opening a tag shows its message with the reply box on it', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['conversations'] = [
        ...server.state['conversations'] as List,
        conversationFixture('group', 'Release'),
      ];
      // Two pages back, and far from either end of what is loaded.
      for (var i = 1; i <= 250; i++) {
        server.append('Note $i', conversationId: 'group');
      }
      server.tag(
        'message-100',
        conversationId: 'group',
        text: 'Note 100',
        createdAt: minutesAgo(3),
      );
      final c = await showView(tester, server);
      await tester.tap(notificationsEntry());
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-mention-mention-1')));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'group');
      expect(find.text('Replying to owner'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-message-message-100')).hitTestable(),
        findsOneWidget,
      );
      expect(find.text('Waiting'), findsNothing);
    });
  });

  group('tags in messages', () {
    testWidgets('a tagged name reads highlighted where the text says it', (
      tester,
    ) async {
      await showText(tester, 'Please @dee confirm, not @bob.', ['dee']);
      final dee = runsOf(tester, '@dee').single;
      expect(dee?.color, grid.AppPalette.accentOnSurface);
      expect(dee?.backgroundColor, isNotNull);
      // One paragraph: the name does not break the line it is in.
      expect(
        find.text('Please @dee confirm, not @bob.', findRichText: true),
        findsOneWidget,
      );
      final bob = runsOf(tester, '@bob');
      expect(bob.every((s) => s?.backgroundColor == null), isTrue);
    });

    testWidgets('a name ending a sentence is still the name', (tester) async {
      await showText(tester, 'Over to @dee.', ['dee']);
      expect(runsOf(tester, '@dee').single?.backgroundColor, isNotNull);
      expect(find.text('Over to @dee.', findRichText: true), findsOneWidget);
      // Not shown again before the text, as if the text had not said it.
      expect(find.text('@dee', findRichText: true), findsNothing);
    });

    testWidgets('a full address is the same person', (tester) async {
      await showText(tester, 'Ask @dee@example.com first.', ['dee']);
      expect(
        runsOf(tester, '@dee@example.com').single?.backgroundColor,
        isNotNull,
      );
    });

    testWidgets('a tag the text does not say is shown before it', (
      tester,
    ) async {
      await showText(tester, 'Please confirm the release.', ['dee']);
      expect(runsOf(tester, '@dee').single?.backgroundColor, isNotNull);
      expect(
        find.textContaining('Please confirm the release.'),
        findsOneWidget,
      );
    });

    testWidgets('a tag in code stays code', (tester) async {
      await showText(tester, 'Run `ping @dee` now.', ['dee']);
      expect(runsOf(tester, 'ping @dee'), isNotEmpty);
    });

    testWidgets('the conversation highlights the people a message tags', (
      tester,
    ) async {
      final server = ConversationServer()..append('Can you confirm?');
      server.messages.last['mentions'] = ['owner'];
      await showView(tester, server);
      expect(runsOf(tester, '@owner').single?.backgroundColor, isNotNull);
    });
  });

  group('tab and system notice', () {
    test('only Desktop hands a new tag to the operating system', () async {
      final notices = ShownNotices();
      final store = DesktopNotificationStore(storage: MemoryStore());
      await store.set(true);
      final system = SystemNotifications(store: store, notifier: notices);
      expect(superTabMentionNotice(system, web: true), isNull);
      final server = ConversationServer()..tag('message-1', text: 'Ship it?');
      superTabMentionNotice(system, web: false)!(
        'tab-1',
        SuperTabMention.fromJson(server.mentions.single),
      );
      await pumpEventQueue();
      expect(notices.shown, [
        (title: 'Wren tagged you', body: 'web-project · Lead: Ship it?'),
      ]);
      // A click opens that tag in that Swarm (swarm_screen.dart).
      expect(notices.routes, [
        (SystemNotifications.mentionNoticeMachine, 'tab-1/mention-1'),
      ]);
    });

    test('the client hands each new tag of an open Swarm over', () async {
      final server = ConversationServer()..tag('message-1', text: 'Old');
      final arrived = <String>[];
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: (method, path, {body}) =>
            server.request(method, path, body: body),
        discoveryInterval: Duration.zero,
        onMention: (tab, mention) => arrived.add('$tab: ${mention.text}'),
      );
      addTearDown(client.dispose);
      client.bind('owner');
      final c = await client.open('tab');
      await c.refresh();
      await pumpEventQueue();
      server.tag('message-2', text: 'New');
      await c.refresh();
      await pumpEventQueue();
      expect(arrived, ['tab: New']);
    });

    test('a Swarm tab not opened yet counts and announces new tags', () async {
      final server = ConversationServer()..tag('message-1', text: 'Old');
      final arrived = <String>[];
      var counted = 0;
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: (method, path, {body}) async =>
            path == '/api/super-tabs/list'
            ? {
                'tabs': [
                  {'id': 'tab', 'name': 'Pilot'},
                ],
                'next': null,
              }
            : server.request(method, path, body: body),
        discoveryInterval: Duration.zero,
        onTabs: (_, _) {},
        onMention: (tab, mention) => arrived.add('$tab: ${mention.text}'),
        onTagCounts: () => counted++,
      );
      addTearDown(client.dispose);
      client.bind('owner');
      await client.refreshTabs();
      expect(client.waitingTags('tab'), 1);
      expect(arrived, isEmpty);
      expect(counted, 1);
      server.tag('message-2', text: 'New');
      await client.refreshTabs();
      expect(client.waitingTags('tab'), 2);
      expect(arrived, ['tab: New']);
      // Opened, the Swarm's own state counts, and nothing is announced twice.
      final c = await client.open('tab');
      await c.refresh();
      await pumpEventQueue();
      final reads = server.mentionReads;
      await client.refreshTabs();
      expect(server.mentionReads, reads);
      expect(client.waitingTags('tab'), 2);
      expect(arrived, ['tab: New']);
    });

    test(
      'one Swarm without the list does not stop the others, and is asked again',
      () async {
        final server = ConversationServer()..tag('message-1', text: 'Here');
        var goneMissing = true;
        final client = SuperTabClient(
          storage: MemoryStore(),
          transport: (method, path, {body}) async {
            if (path == '/api/super-tabs/list') {
              return {
                'tabs': [
                  {'id': 'gone', 'name': 'Older'},
                  {'id': 'tab', 'name': 'Pilot'},
                ],
                'next': null,
              };
            }
            if (path.startsWith('/api/super-tabs/gone/')) {
              if (goneMissing) {
                throw const SuperTabFailure(
                  'NOT_FOUND',
                  'Not found.',
                  statusCode: 404,
                );
              }
              return {'mentions': server.mentions.reversed.toList()};
            }
            return server.request(method, path, body: body);
          },
          discoveryInterval: Duration.zero,
          onTabs: (_, _) {},
        );
        addTearDown(client.dispose);
        client.bind('owner');
        await client.refreshTabs();
        expect(client.waitingTags('tab'), 1);
        expect(client.waitingTags('gone'), 0);
        // Its backend is updated during the session.
        goneMissing = false;
        server.tag('message-2', text: 'There');
        await client.refreshTabs();
        expect(client.waitingTags('tab'), 2);
        expect(client.waitingTags('gone'), 2);
      },
    );

    test('a Swarm tab with waiting tags asks for its person', () async {
      final f = SuperTabLaunchFixture(local: true);
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      final tab = f.app.activeSwarm;
      expect(tabMentionsWaiting(f.app, tab), 0);
      expect(tabActivity(f.app, tab), isNot(HarnessActivity.needsInput));
      f.connection.server.tag('message-1');
      await c.refresh();
      expect(tabMentionsWaiting(f.app, tab), 1);
      expect(tabActivity(f.app, tab), HarnessActivity.needsInput);
    });
  });

  testWidgets('screenshots for review', (tester) async {
    final server = ConversationServer();
    server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
    server.state['people'] = [
      {'id': 'owner', 'email': 'ken@example.com', 'role': 'owner'},
    ];
    server.state['conversations'] = [
      conversationFixture('lead', 'Lead'),
      {
        ...conversationFixture('group', 'Mentions: Desktop + web'),
        'projectId': 'lead',
        'number': 162,
      },
    ];
    Map<String, dynamic> wren(String text, String group) {
      server.append(text, conversationId: group);
      return server.messages.last
        ..['author'] = {
          'kind': 'agent',
          'id': 'lead-agent',
          'name': 'Lead',
          'displayName': 'Wren',
        };
    }

    wren('The backend part is merged.', 'group');
    wren(
      'The Desktop build is ready. Can you try it on your Mac and confirm?',
      'group',
    )['mentions'] = [
      'owner',
    ];
    wren(
      '@ken please approve the release window for Monday.',
      'lead',
    )['mentions'] = [
      'owner',
    ];
    server
      ..tag(
        'message-2',
        conversationId: 'group',
        text: 'The Desktop build is ready. Can you try it on your Mac and confirm?',
        createdAt: minutesAgo(4),
      )
      ..tag(
        'message-3',
        text: '@ken please approve the release window for Monday.',
        createdAt: minutesAgo(52),
      );
    server.mentions[0]['conversationTitle'] = '#162 Mentions: Desktop + web';
    server.mentions[1]
      ..['resolvedAt'] = minutesAgo(40)
      ..['resolvedBy'] = 'reply';
    server.state['mentionsWaiting'] = 1;
    await showView(tester, server);
    await tester.tap(notificationsEntry());
    await tester.pumpAndSettle();
    await shot(tester, 'notifications');
    await tester.tap(find.byKey(const ValueKey('super-mention-mention-1')));
    await tester.pumpAndSettle();
    expect(find.text('Replying to Wren'), findsOneWidget);
    await shot(tester, 'opened-at-message');
  }, skip: shots == null);

  for (final native in [false, true]) {
    testWidgets('a Swarm tab behind another counts its waiting tags '
        '(native=$native)', (tester) async {
      final updates = <Map>[];
      const channel = MethodChannel('harness/swarm_tabs');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final f = SuperTabLaunchFixture(local: true);
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final swarm = f.app.activeSwarm;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      f.connection.server
        ..tag('message-1')
        ..tag('message-2');
      await c.refresh();
      f.app.newSwarm(name: 'other');
      await mount(tester, f.app, nativeTabs: native);
      await tester.pump(const Duration(milliseconds: 100));
      if (native) {
        final tab = (updates.last['tabs'] as List).cast<Map>().singleWhere(
          (t) => t['id'] == swarm.id,
        );
        expect(tab['attention'], 2);
      } else {
        expect(
          tester
              .widget<Text>(find.byKey(ValueKey('tab-tags:${swarm.id}')))
              .data,
          '2',
        );
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      f.dispose();
    });
  }
}
