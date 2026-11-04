import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/day_jump.dart';
import 'package:harness/super_tabs/day_pill.dart';

const _pill = ValueKey('super-day-pill');

/// A list of 40 rows on Oct 20 and 21, 2026 under a sticky day that jumps
/// with [onJump], scrolled so its pill shows.
Future<void> _list(
  WidgetTester tester,
  ValueChanged<DateTime?> onJump,
) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: SizedBox(
          height: 400,
          child: SuperTabStickyDay(
            pillKey: _pill,
            onJump: onJump,
            child: ListView(
              children: [
                for (var i = 0; i < 40; i++)
                  SuperTabDayMark(
                    time: DateTime(2026, 10, i < 20 ? 20 : 21, 9, i),
                    child: SizedBox(height: 40, child: Text('Row $i')),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
  await tester.drag(find.byType(ListView), const Offset(0, -300));
  await tester.pumpAndSettle();
}

void main() {
  group('the time each choice starts at', () {
    final wednesday = DateTime(2026, 11, 4, 15, 30);

    test('Yesterday, Last week and Last month start at their midnight', () {
      expect(
        superTabJumpStart(SuperTabJumpTo.yesterday, wednesday),
        DateTime(2026, 11, 3),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastWeek, wednesday),
        DateTime(2026, 10, 28),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, wednesday),
        DateTime(2026, 10, 4),
      );
    });

    test('The very beginning has no time', () {
      expect(superTabJumpStart(SuperTabJumpTo.beginning, wednesday), isNull);
    });

    test('Last month from a day a shorter month lacks is its last day', () {
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, DateTime(2026, 3, 31, 9)),
        DateTime(2026, 2, 28),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, DateTime(2027, 1, 15, 9)),
        DateTime(2026, 12, 15),
      );
    });
  });

  group('the pill opens the Jump to menu', () {
    testWidgets('the pill is a button with a chevron', (tester) async {
      await _list(tester, (_) {});
      expect(find.byKey(_pill), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(_pill),
          matching: find.byIcon(AppIcons.chevronDown),
        ),
        findsOneWidget,
      );
      expect(
        tester.getSemantics(find.byKey(_pill)),
        matchesSemantics(
          isButton: true,
          hasTapAction: true,
          label: 'Jump to…',
          value: 'Tue, Oct 20',
        ),
      );
    });

    testWidgets('a click opens its choices, and each jumps from its time', (
      tester,
    ) async {
      DateTime? jumped;
      var calls = 0;
      await _list(tester, (at) {
        jumped = at;
        calls++;
      });
      for (final choice in SuperTabJumpTo.values) {
        await tester.tap(find.byKey(_pill));
        await tester.pumpAndSettle();
        for (final label in [
          'Jump to…',
          'Yesterday',
          'Last week',
          'Last month',
          'The very beginning',
          'Jump to a specific date',
        ]) {
          expect(find.text(label), findsOneWidget, reason: label);
        }
        final before = calls;
        await tester.tap(find.text(choice.label));
        await tester.pumpAndSettle();
        expect(calls, before + 1);
        expect(jumped, superTabJumpStart(choice, DateTime.now()));
        expect(find.text('Jump to…'), findsNothing);
      }
    });

    testWidgets('Jump to a specific date picks a day on a calendar', (
      tester,
    ) async {
      final jumped = <DateTime?>[];
      await _list(tester, jumped.add);
      await tester.tap(find.byKey(_pill));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Jump to a specific date'));
      await tester.pumpAndSettle();
      expect(find.byType(CalendarDatePicker), findsOneWidget);
      // It opens at the pill's month.
      expect(find.text('October 2026'), findsOneWidget);
      await tester.tap(find.text('15'));
      await tester.pumpAndSettle();
      expect(jumped, [DateTime(2026, 10, 15)]);
      expect(find.byType(CalendarDatePicker), findsNothing);
    });

    testWidgets('Esc closes the menu, and nothing jumps', (tester) async {
      final jumped = <DateTime?>[];
      await _list(tester, jumped.add);
      await tester.tap(find.byKey(_pill));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Jump to…'), findsNothing);
      expect(jumped, isEmpty);
    });
  });
}
