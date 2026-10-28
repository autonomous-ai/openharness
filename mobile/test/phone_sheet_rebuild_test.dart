import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// A sheet whose rows wait on an answer asked as it opens — a computer's Harness OS status, which
/// brings its GitHub and SSH rows: they show while it is open, not only the next time.
void main() {
  testWidgets('a sheet reads its rows again when what they come from changes', (
    tester,
  ) async {
    final answered = ValueNotifier(false);
    addTearDown(answered.dispose);
    PhoneSheetAction row(String label) =>
        PhoneSheetAction(icon: LucideIcons.wifi300, label: label, onTap: () {});
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showPhoneSheet(
              context,
              title: 'Harness-BD19',
              rebuildOn: answered,
              rows: () => (
                actions: [
                  row('Rename…'),
                  if (answered.value) ...[row('GitHub'), row('SSH')],
                ],
                sections: const [],
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Rename…'), findsOneWidget);
    expect(find.text('GitHub'), findsNothing);

    answered.value = true;
    await tester.pumpAndSettle();
    expect(find.text('GitHub'), findsOneWidget);
    expect(find.text('SSH'), findsOneWidget);
  });
}
