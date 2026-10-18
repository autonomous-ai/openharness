import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/product_feedback.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/measurement/task_feedback.dart';

void main() {
  testWidgets(
    'task outcome dialog emits fixed outcomes and exposure without task context',
    (tester) async {
      final answers = <String>[], reports = <Map<String, dynamic>>[];
      final measurement = ProductMeasurement(
        surface: 'desktop',
        automatic: false,
        context: ProductUsageContext(
          release: '1.2.77',
          platform: 'macos',
          production: true,
        ),
        sendSetup: (_) async => {},
      );
      addTearDown(measurement.dispose);
      measurement.account(
        'PRIVATE_ACCOUNT',
        choice: () async => {'enabled': true, 'revision': 0},
        send: (report) async {
          reports.add(report);
          return {'accepted': true};
        },
      );
      await measurement.flush();
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('Fixture'))),
      );
      final shown = showTaskFeedback(
        tester.element(find.text('Fixture')),
        choice: () async => {'enabled': true, 'revision': 0},
        send: (answer, _) async => answers.add(answer),
        measurement: measurement,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Completed'));
      await tester.pumpAndSettle();
      await measurement.flush();
      expect(answers, ['completed']);
      final counters = reports
          .expand((r) => (r['counters'] as Map).entries)
          .toList();
      expect(
        counters.any(
          (e) =>
              e.key == 'health_desktop_feedback_outcome_shown' && e.value == 1,
        ),
        true,
      );
      expect(
        counters.any(
          (e) =>
              e.key == 'health_desktop_feedback_outcome_answered' &&
              e.value == 1,
        ),
        true,
      );
      expect(reports.toString(), isNot(contains('PRIVATE')));
      Navigator.of(tester.element(find.text('Completed'))).pop();
      await tester.pumpAndSettle();
      await shown;
    },
  );
  testWidgets(
    'counts exposure, successful answer, and dismissal without task context',
    (tester) async {
      var shown = 0, answered = 0, dismissed = 0;
      Future<void> show() => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProductFeedback(
              send: (_, _) async {},
              onShown: () => shown++,
              onAnswered: () => answered++,
              onDismissed: () => dismissed++,
            ),
          ),
        ),
      );
      await show();
      await tester.pump();
      expect(shown, 1);
      expect(answered, 0);
      await tester.tap(find.text('Useful'));
      await tester.pumpAndSettle();
      expect(answered, 1);
      await tester.pumpWidget(const SizedBox());
      expect(dismissed, 0);
      await show();
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      expect(shown, 2);
      expect(dismissed, 1);
    },
  );
  testWidgets(
    'voluntary feedback sends only a fixed answer and retries the same receipt',
    (tester) async {
      final calls = <List<String>>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProductFeedback(
              send: (answer, receipt) async {
                calls.add([answer, receipt]);
                if (calls.length == 1) throw StateError('PRIVATE_CANARY');
              },
            ),
          ),
        ),
      );
      expect(calls, isEmpty);
      await tester.tap(find.text('Useful'));
      await tester.pumpAndSettle();
      expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
      expect(find.textContaining('Couldn’t confirm'), findsOneWidget);
      await tester.tap(find.text('Useful'));
      await tester.pumpAndSettle();
      expect(calls.length, 2);
      expect(calls[0], calls[1]);
      expect(calls[0][0], 'useful');
      expect(
        calls[0][1],
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
      expect(find.text('Feedback sent. Thank you.'), findsOneWidget);
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Useful'),
            )
            .onPressed,
        isNull,
      );
    },
  );
}
