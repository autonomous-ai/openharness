import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/privacy_section.dart';

void main() {
  Future<void> show(
    WidgetTester tester,
    UsagePreferenceRequest request, {
    bool compact = false,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProductUsagePreference(
            request: request,
            compact: compact,
            feedback: (_, _) async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('one-row sharing keeps failed saves honest and can reload', (
    tester,
  ) async {
    await show(tester, ({bool? enabled}) async {
      if (enabled != null) throw StateError('PRIVATE_CANARY');
      return {'enabled': enabled ?? true};
    }, compact: true);
    expect(find.byType(Switch), findsOneWidget);
    expect(find.text('Share product usage data'), findsOneWidget);
    expect(find.text('See what’s shared'), findsNothing);
    expect(find.text('How did your latest task go?'), findsNothing);
    expect(find.text('Rate task outcome'), findsNothing);
    // A row like Experimental's others: its one line of what it does, without the page's rating and receipts.
    expect(find.textContaining('Help improve'), findsOneWidget);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(find.byType(Switch), findsNothing);
    expect(find.text('Unavailable'), findsOneWidget);
    expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
    await tester.tap(find.text('Reload'));
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('offers task feedback directly from the privacy controls', (
    tester,
  ) async {
    await show(
      tester,
      ({bool? enabled}) async => {'enabled': true, 'revision': 0},
    );
    await tester.tap(find.text('Rate task outcome'));
    await tester.pumpAndSettle();
    expect(find.text('Did you finish what you wanted?'), findsOneWidget);
    expect(find.text('Partly completed'), findsOneWidget);
    expect(
      find.textContaining('without your task or its contents'),
      findsWidgets,
    );
  });

  testWidgets(
    'shows the saved preference and turns sharing off for the account',
    (tester) async {
      final changes = <bool>[];
      await show(tester, ({bool? enabled}) async {
        if (enabled != null) changes.add(enabled);
        return {'enabled': enabled ?? true, 'revision': 1};
      });
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
      expect(find.text('How did your latest task go?'), findsOneWidget);
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(changes, [false]);
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
      expect(find.text('How did your latest task go?'), findsNothing);
      expect(find.textContaining('every computer and app'), findsOneWidget);
      await tester.tap(find.text('See what’s shared'));
      await tester.pumpAndSettle();
      expect(find.textContaining('random report receipt'), findsOneWidget);
      expect(find.textContaining('kept 10 days'), findsOneWidget);
      // A keyed code can be recomputed from the account id (that is how opt-out deletes it): pseudonymous, not anonymous.
      expect(find.textContaining('anonymous code'), findsNothing);
      expect(
        find.textContaining('coded ID instead of your account'),
        findsWidgets,
      );
      expect(find.textContaining('sign-up day'), findsOneWidget);
      expect(
        find.textContaining('New reports create no per-person history'),
        findsNothing,
      );
      expect(
        find.textContaining('are not stored with the combined totals'),
        findsOneWidget,
      );
      expect(
        find.textContaining('does not tell us whether your task succeeded'),
        findsOneWidget,
      );
    },
  );
  testWidgets(
    'does not pretend an ambiguous save succeeded or retained its old value',
    (tester) async {
      await show(tester, ({bool? enabled}) async {
        if (enabled != null) throw StateError('PRIVATE_CANARY');
        return {'enabled': true};
      });
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(find.byType(Switch), findsNothing);
      expect(find.text('Unavailable'), findsOneWidget);
      expect(find.textContaining('Couldn’t confirm'), findsOneWidget);
      expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
    },
  );
  testWidgets('keeps the control unavailable until a real preference arrives', (
    tester,
  ) async {
    final pending = Completer<Map<String, dynamic>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ProductUsagePreference(
            request: ({bool? enabled}) => pending.future,
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(Switch), findsNothing);
    pending.complete({'enabled': false});
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });
}
