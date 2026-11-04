import 'package:clock/clock.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/identity_card.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'support/super_tab_fixture.dart';

/// Huy (11-04): hovering a name or avatar in the chat shows who it is. A
/// person: name, status, local time. An agent: engine and model, machine,
/// and its task, which opens that task's chat.
final _now = DateTime.utc(2026, 11, 4, 8, 42);
final _card = find.byKey(const ValueKey('super-identity-card'));

const _dee = {'kind': 'person', 'id': 'dee', 'name': 'dee@example.com'};
const _shrike = {'kind': 'agent', 'id': 'shrike2', 'name': 'Shrike2'};

ConversationServer _server({bool assigned = true}) {
  final server = ConversationServer();
  final state = server.state;
  (state['people'] as List).add({
    'id': 'dee',
    'email': 'dee@example.com',
    'role': 'collaborator',
    'name': 'Dee Tran',
    'status': {'text': 'Out of office', 'emoji': '🌴'},
    'timeZone': 'Asia/Ho_Chi_Minh',
  });
  (state['agents'] as List).add({
    'id': 'shrike2',
    'name': 'Shrike2',
    'machineId': 'm',
    'harnessId': 'h',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude', 'model': 'claude-opus-5-5'},
  });
  state['machines'] = [
    {
      'machineId': 'm',
      'name': 'MacbookPro.local',
      'observation': {
        'resources': {'deviceType': 'MacBook Pro'},
      },
    },
  ];
  final task = (state['conversations'] as List)[1] as Map;
  task['number'] = 2605;
  task['agentIds'] = ['shrike2'];
  if (assigned) {
    task['assignment'] = {
      'id': 'w1',
      'agentId': 'shrike2',
      'status': 'working',
    };
  }
  return server;
}

void _say(ConversationServer server, String text, Map<String, Object> author) {
  server.append(text);
  server.messages.last
    ..['author'] = author
    ..['createdAt'] = _now.toIso8601String();
}

Future<SuperTabController> _open(
  WidgetTester tester,
  ConversationServer server,
) async {
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  await tester.binding.setSurfaceSize(const Size(1280, 860));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<TestGesture> _hover(WidgetTester tester, Finder target) async {
  final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
  await mouse.addPointer(location: Offset.zero);
  addTearDown(mouse.removePointer);
  await mouse.moveTo(tester.getCenter(target));
  await tester.pump(SuperTabHoverCard.openDelay);
  await tester.pump();
  return mouse;
}

Finder _inRow(String messageId, Finder matching) => find.descendant(
  of: find.byKey(ValueKey('super-message-$messageId')),
  matching: matching,
);

void main() {
  setUpAll(superTabLoadZones);

  testWidgets('hovering a person’s name shows their card with local time', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = _server();
      _say(server, 'Can the card show where the agent runs?', _dee);
      await _open(tester, server);
      final id = server.messages.last['id'] as String;
      await _hover(tester, _inRow(id, find.text('Dee Tran')));
      expect(_card, findsOneWidget);
      final card = find.descendant(of: _card, matching: find.byType(Text));
      final words = tester.widgetList<Text>(card).map((t) => t.data).toList();
      expect(words, contains('Out of office'));
      expect(words, contains('3:42 PM local time'));
    });
  });

  testWidgets(
    'hovering an agent’s avatar shows its machine, model and task, and the task opens its chat',
    (tester) async {
      final server = _server();
      _say(
        server,
        'Yes: its machine, engine and model, and its task.',
        _shrike,
      );
      final c = await _open(tester, server);
      final id = server.messages.last['id'] as String;
      await _hover(tester, _inRow(id, find.byType(SuperTabAvatar)));
      expect(_card, findsOneWidget);
      expect(
        find.descendant(of: _card, matching: find.text('Claude Opus 5.5')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: _card, matching: find.text('MacbookPro')),
        findsOneWidget,
      );
      final task = find.byKey(const ValueKey('super-identity-card-task'));
      expect(
        find.descendant(
          of: task,
          matching: find.textContaining('#2605 Offline editing'),
        ),
        findsOneWidget,
      );
      await tester.tap(task);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
      expect(_card, findsNothing);
    },
  );

  testWidgets(
    'Tab from an agent’s name in the chat reaches its task line, and Enter opens the task (Osprey, test step)',
    (tester) async {
      final server = _server();
      _say(server, 'Keyboard, please.', _shrike);
      final c = await _open(tester, server);
      // Tab through the chat until the name's card opens.
      for (var tabs = 0; _card.evaluate().isEmpty && tabs < 80; tabs++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      expect(_card, findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      await tester.pump(SuperTabHoverCard.openDelay);
      expect(_card, findsOneWidget, reason: 'Tab from the name closed it');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
    },
  );

  testWidgets('Shift-Tab from the task line returns to the name', (
    tester,
  ) async {
    final server = _server();
    _say(server, 'Keyboard, please.', _shrike);
    await _open(tester, server);
    for (var tabs = 0; _card.evaluate().isEmpty && tabs < 80; tabs++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
    }
    final name = FocusManager.instance.primaryFocus;
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(FocusManager.instance.primaryFocus, isNot(name));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();
    expect(FocusManager.instance.primaryFocus, name);
    expect(_card, findsOneWidget);
  });

  testWidgets('a grouped line has no card', (tester) async {
    final server = _server();
    _say(server, 'First line', _dee);
    _say(server, 'Second line', _dee);
    await _open(tester, server);
    final id = server.messages.last['id'] as String;
    expect(_inRow(id, find.byType(SuperTabHoverCard)), findsNothing);
  });

  testWidgets('no task line without a readable task', (tester) async {
    final server = _server(assigned: false);
    _say(server, 'Idle for now.', _shrike);
    await _open(tester, server);
    final id = server.messages.last['id'] as String;
    await _hover(tester, _inRow(id, find.byType(SuperTabAvatar)));
    expect(_card, findsOneWidget);
    expect(
      find.byKey(const ValueKey('super-identity-card-task')),
      findsNothing,
    );
  });
}
