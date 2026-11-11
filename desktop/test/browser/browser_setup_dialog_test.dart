import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_setup_dialog.dart';

/// Set up Browser, as a person sees it: asked once, at the computer being set up.
void main() {
  Future<Future<bool>> open(
    WidgetTester tester, {
    bool ownMachine = false,
  }) async {
    late Future<bool> answer;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => answer = showBrowserSetupDialog(
              context,
              ownMachine: ownMachine,
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    return answer;
  }

  testWidgets('says what Install does; Install is yes and Cancel is no', (
    tester,
  ) async {
    var answer = await open(tester);
    expect(find.text('Set up Browser'), findsOneWidget);
    expect(
      find.text(
        'Installs Podman on this computer to run the agent\'s Chrome. Asks '
        'for your password once. About 15 minutes, 3 GB.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Install'));
    await tester.pumpAndSettle();
    expect(await answer, isTrue);
    expect(find.text('Set up Browser'), findsNothing);

    answer = await open(tester);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(await answer, isFalse);
  });

  testWidgets('a Podman machine that will not start gets its own line', (
    tester,
  ) async {
    const line =
        'Podman on this computer won\'t start. Harness will set up its own.';
    await open(tester);
    expect(find.text(line), findsNothing);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await open(tester, ownMachine: true);
    expect(find.text(line), findsOneWidget);
  });
}
