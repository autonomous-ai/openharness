// Machine details, polished (Ken, 2026-10-28): each allowance window once, with its reset; no raw project folder.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/detail_dialog.dart';
import 'package:harness/super_tabs/machine_details.dart';
import 'package:harness/widgets/engine_identity.dart';

Future<void> _show(WidgetTester tester, Widget details) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(body: Center(child: details)),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  test('an allowance reads as one line per window, in either detail format, without the limiting-window line', () {
    // This computer's reading: the limiting window named, then each window.
    expect(
      superTabAllowanceWindows([
        'Limiting window: Session',
        'Read 3 min ago',
        'Session — 57% remaining · resets in 2h 1m',
        'Weekly — 65% remaining · resets in 6d 2h',
      ]),
      [
        (window: 'Session', left: '57% left', reset: 'resets in 2h 1m'),
        (window: 'Weekly', left: '65% left', reset: 'resets in 6d 2h'),
      ],
    );
    // Another machine's reading: the tightest window first, a window without a reset.
    expect(
      superTabAllowanceWindows([
        '5-hour: 44% remaining · resets in 2h 10m',
        'Weekly: 80% remaining',
      ]),
      [
        (window: '5-hour', left: '44% left', reset: 'resets in 2h 10m'),
        (window: 'Weekly', left: '80% left', reset: null),
      ],
    );
    expect(superTabAllowanceWindows(['Usage unavailable']), isEmpty);
  });

  testWidgets(
    'each window shows once with its reset; the account figure is not repeated above it',
    (tester) async {
      await _show(
        tester,
        const SuperTabMachineDetails(
          name: 'MacbookPro.local',
          status: 'Online',
          owner: 'ken@example.com',
          engines: ['claude'],
          accounts: [
            {
              'engine': 'claude',
              'account': 'ken@gmail.example',
              'remainingPercent': 57,
              'details': [
                'Limiting window: Session',
                'Session — 57% remaining · resets in 2h 1m',
                'Weekly — 65% remaining · resets in 6d 2h',
              ],
            },
          ],
        ),
      );
      expect(find.text('Session'), findsOneWidget);
      expect(find.text('57% left · resets in 2h 1m'), findsOneWidget);
      expect(find.text('65% left · resets in 6d 2h'), findsOneWidget);
      expect(find.textContaining('Limiting window'), findsNothing);
      expect(find.textContaining('57%'), findsOneWidget);
      expect(find.text('ken@gmail.example'), findsOneWidget);
      expect(find.text('Project folder'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('an account whose windows are not listed keeps its one figure', (
    tester,
  ) async {
    await _show(
      tester,
      const SuperTabMachineDetails(
        name: 'M2',
        status: 'Online',
        accounts: [
          {'engine': 'codex', 'remainingPercent': 95, 'details': <String>[]},
        ],
      ),
    );
    expect(find.text('95% left'), findsOneWidget);
  });

  testWidgets(
    'every account wears its own engine mark, Codex as Claude Code does',
    (tester) async {
      await _show(
        tester,
        const SuperTabMachineDetails(
          name: 'M2',
          status: 'Online',
          accounts: [
            {
              'engine': 'claude',
              'remainingPercent': 57,
              'details': ['Session — 57% remaining · resets in 2h 1m'],
            },
            {
              'engine': 'codex',
              'remainingPercent': 95,
              'details': ['Weekly — 95% remaining · resets in 6d 22h'],
            },
          ],
        ),
      );
      expect(
        [
          for (final mark in tester.widgetList<EngineMark>(
            find.byType(EngineMark),
          ))
            mark.engine,
        ],
        ['claude', 'codex'],
      );
      expect(
        tester.getTopLeft(find.text('Codex')).dx,
        tester.getTopLeft(find.text('Claude Code')).dx,
      );
    },
  );

  testWidgets(
    '5%, 5.0% and 100% read with the right ink: decimals are not taken for 100%',
    (tester) async {
      await _show(
        tester,
        const SuperTabMachineDetails(
          name: 'Mac',
          status: 'Online',
          accounts: [
            {
              'engine': 'claude',
              'remainingPercent': 5,
              'details': [
                'Session: 5% remaining',
                'Weekly: 5.0% remaining',
                'Monthly: 100% remaining',
              ],
            },
          ],
        ),
      );
      Color? ink(String text) =>
          tester.widget<Text>(find.text(text)).style!.color;
      expect(
        ink('5.0% left'),
        ink('5% left'),
        reason: 'both at the critical limit',
      );
      expect(ink('5% left'), isNot(ink('100% left')));
    },
  );

  testWidgets(
    'a narrow window with enlarged text stacks the allowance instead of overflowing',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: const Scaffold(
            body: Center(
              child: SuperTabDetailDialog(
                title: 'Mac',
                body: SuperTabMachineDetails(
                  name: 'Mac',
                  status: 'Online',
                  accounts: [
                    {
                      'engine': 'claude',
                      'account': 'someone.with.a.long.address@example.com',
                      'remainingPercent': 95,
                      'details': <String>[],
                    },
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('95% left'), findsOneWidget);
    },
  );
}
