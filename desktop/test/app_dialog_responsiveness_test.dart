import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_dialog.dart';

void main() {
  testWidgets(
    'dialogs open fully on the first frame and dismiss without a fade',
    (tester) async {
      ModalRoute<dynamic>? route;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAppDialog<void>(
                context: context,
                builder: (context) {
                  route = ModalRoute.of(context);
                  return const Center(
                    child: Material(child: Text('Ready dialog')),
                  );
                },
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump();
      expect(find.text('Ready dialog'), findsOneWidget);
      expect(route!.animation!.isCompleted, isTrue);
      expect(find.byType(BackdropFilter), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.pump();
      expect(find.text('Ready dialog'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
