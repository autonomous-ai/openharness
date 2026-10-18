import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/privacy_page.dart';

void main() {
  testWidgets('the phone can turn off sharing for the whole account', (
    tester,
  ) async {
    final changes = <bool>[];
    await tester.pumpWidget(
      MaterialApp(
        home: PrivacyPage(
          feedback: (_, _) async {},
          request: ({bool? enabled}) async {
            if (enabled != null) changes.add(enabled);
            return {'enabled': enabled ?? true};
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('How did your latest task go?'), findsOneWidget);
    await tester.tap(find.text('Useful'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('See what’s shared'));
    await tester.pumpAndSettle();
    // Opening the shared fields above the feedback keeps the answer already sent.
    expect(find.text('Feedback sent. Thank you.'), findsOneWidget);
    await tester.tap(find.text('Hide shared fields'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(changes, [false]);
    expect(find.text('How did your latest task go?'), findsNothing);
    expect(find.textContaining('every computer and app'), findsOneWidget);
    await tester.tap(find.text('See what’s shared'));
    await tester.pumpAndSettle();
    expect(find.textContaining('random retry receipt'), findsOneWidget);
    expect(find.textContaining('kept 10 days'), findsOneWidget);
    // A keyed code can be recomputed from the account id (that is how opt-out deletes it): pseudonymous, not anonymous.
    expect(find.textContaining('anonymous code'), findsNothing);
    expect(find.textContaining('coded ID instead of your account'), findsWidgets);
    expect(find.textContaining('sign-up day'), findsOneWidget);
    expect(find.textContaining('New reports create no per-person history'), findsNothing);
    expect(find.textContaining('are not stored with the combined totals'), findsOneWidget);
  });
  testWidgets(
    'a failed write leaves an unavailable switch and a reload action',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: PrivacyPage(
            request: ({bool? enabled}) async {
              if (enabled != null) throw StateError('PRIVATE_CANARY');
              return {'enabled': true};
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(find.byType(Switch), findsNothing);
      expect(find.text('Setting unavailable'), findsOneWidget);
      expect(find.text('Reload'), findsOneWidget);
      expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
    },
  );
}
