import 'package:clock/clock.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/identity_card.dart';
import 'package:harness/super_tabs/profile_model.dart';
import 'package:harness/super_tabs/zone_time.dart';

/// Huy (11-04): hovering a name or avatar shows a small card, like Slack's.
final _now = DateTime.utc(2026, 11, 4, 8, 42);

const _status = SuperTabPersonStatus(text: 'Out of office', emoji: '🌴');

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: Padding(padding: const EdgeInsets.all(40), child: child),
    ),
  ),
);

final _card = find.byKey(const ValueKey('super-identity-card'));

/// A name that takes focus, as the chat's names do, under a hover card.
Widget _anchor(
  SuperTabIdentityFacts facts, {
  FocusNode? focus,
  VoidCallback? onTap,
}) => _host(
  Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SuperTabHoverCard(
        facts: () => facts,
        child: InkWell(
          focusNode: focus,
          onTap: onTap ?? () {},
          child: const Text('Huy Pham', key: ValueKey('name')),
        ),
      ),
      const SizedBox(height: 400),
      const Text('elsewhere', key: ValueKey('elsewhere')),
    ],
  ),
);

Future<TestGesture> _mouse(WidgetTester tester) async {
  final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
  await mouse.addPointer(location: Offset.zero);
  addTearDown(mouse.removePointer);
  return mouse;
}

void main() {
  setUpAll(superTabLoadZones);

  testWidgets('a person’s card shows name, status and local time', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      await tester.pumpWidget(
        _host(
          const SuperTabIdentityCard(
            facts: SuperTabPersonFacts(
              'Huy Pham',
              status: _status,
              timeZone: 'Asia/Ho_Chi_Minh',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    });
    expect(find.text('Huy Pham'), findsOneWidget);
    expect(find.text('Out of office'), findsOneWidget);
    expect(find.text('🌴'), findsOneWidget);
    expect(find.text('3:42 PM local time'), findsOneWidget);
  });

  testWidgets('a person’s card leaves out a time it does not know', (
    tester,
  ) async {
    for (final zone in [null, 'Mars/Base']) {
      await tester.pumpWidget(
        _host(
          SuperTabIdentityCard(
            facts: SuperTabPersonFacts('Huy Pham', timeZone: zone),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Huy Pham'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-identity-card-time')),
        findsNothing,
      );
    }
  });

  testWidgets('an agent’s card shows engine and model, machine and task', (
    tester,
  ) async {
    var opened = 0;
    await tester.pumpWidget(
      _host(
        SuperTabIdentityCard(
          facts: SuperTabAgentFacts(
            'Shrike2',
            engine: 'claude',
            model: 'Opus 5.5',
            machine: 'MacbookPro.local',
            task: 'Working on #2605 Chat: a card',
            onOpenTask: () => opened++,
          ),
        ),
      ),
    );
    expect(find.text('Shrike2'), findsOneWidget);
    expect(find.text('Claude Opus 5.5'), findsOneWidget);
    expect(find.text('MacbookPro.local'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('super-identity-card-task')));
    expect(opened, 1);
  });

  testWidgets('opens after the hover delay, not before', (tester) async {
    await tester.pumpWidget(_anchor(const SuperTabPersonFacts('Huy Pham')));
    final mouse = await _mouse(tester);
    await mouse.moveTo(tester.getCenter(find.byKey(const ValueKey('name'))));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_card, findsNothing);
    await tester.pump(const Duration(milliseconds: 150));
    expect(_card, findsOneWidget);
  });

  testWidgets('closes when the pointer leaves', (tester) async {
    await tester.pumpWidget(_anchor(const SuperTabPersonFacts('Huy Pham')));
    final mouse = await _mouse(tester);
    await mouse.moveTo(tester.getCenter(find.byKey(const ValueKey('name'))));
    await tester.pump(SuperTabHoverCard.openDelay);
    expect(_card, findsOneWidget);
    await mouse.moveTo(
      tester.getCenter(find.byKey(const ValueKey('elsewhere'))),
    );
    await tester.pump(SuperTabHoverCard.closeDelay);
    await tester.pump();
    expect(_card, findsNothing);
  });

  testWidgets('stays open while the pointer crosses into the card', (
    tester,
  ) async {
    await tester.pumpWidget(_anchor(const SuperTabPersonFacts('Huy Pham')));
    final mouse = await _mouse(tester);
    await mouse.moveTo(tester.getCenter(find.byKey(const ValueKey('name'))));
    await tester.pump(SuperTabHoverCard.openDelay);
    // Through the gap under the name, then onto the card.
    final name = tester.getRect(find.byKey(const ValueKey('name')));
    await mouse.moveTo(name.bottomLeft + const Offset(4, 3));
    await tester.pump(const Duration(milliseconds: 50));
    await mouse.moveTo(tester.getCenter(_card));
    await tester.pump(const Duration(seconds: 1));
    expect(_card, findsOneWidget);
  });

  testWidgets('keyboard focus opens it and Escape closes it, focus kept', (
    tester,
  ) async {
    final focus = FocusNode();
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      _anchor(const SuperTabPersonFacts('Huy Pham'), focus: focus),
    );
    focus.requestFocus();
    await tester.pump();
    expect(_card, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(_card, findsNothing);
    expect(focus.hasPrimaryFocus, isTrue);
  });

  testWidgets('Tab reaches the task line and Enter opens the task', (
    tester,
  ) async {
    final focus = FocusNode();
    addTearDown(focus.dispose);
    var opened = 0;
    await tester.pumpWidget(
      _anchor(
        SuperTabAgentFacts(
          'Shrike2',
          engine: 'claude',
          task: 'Working on #2605 Chat: a card',
          onOpenTask: () => opened++,
        ),
        focus: focus,
      ),
    );
    focus.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    // The task line holds focus: Enter on it, not on the name, opens it.
    expect(focus.hasPrimaryFocus, isFalse);
    expect(_card, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(opened, 1);
  });
}
