import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/new_agent_chooser.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';

void main() {
  Future<void> open(
    WidgetTester tester, {
    int count = 3,
    bool autofocusSearch = false,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showNewAgentChooser<int>(
                context,
                title: 'Agent',
                hint: 'Search agents',
                autofocusSearch: autofocusSearch,
                items: [
                  for (var i = 0; i < count; i++)
                    ChooserItem(value: i, title: 'Agent $i'),
                ],
              ),
              child: const Text('Choose'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Choose'));
    await tester.pumpAndSettle();
  }

  testWidgets('short chooser fits its rows and can be pulled down', (
    tester,
  ) async {
    await open(tester);
    expect(tester.getSize(find.byType(BottomSheet)).height, lessThan(400));
    expect(
      tester.getTopLeft(find.text('Agent')).dx,
      tester.getTopLeft(find.text('Agent 0', findRichText: true)).dx,
    );
    await tester.drag(find.text('Agent'), const Offset(0, 500));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
  });

  testWidgets('the full chooser scrolls to its last choice without more', (
    tester,
  ) async {
    await open(tester, count: 20);
    expect(find.text('more', findRichText: true), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Agent 19', findRichText: true),
      250,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.tap(find.text('Agent 19', findRichText: true));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a short searchable chooser accepts typing on entry', (
    tester,
  ) async {
    await open(tester, autofocusSearch: true);
    expect(tester.testTextInput.isVisible, isTrue);
    tester.testTextInput.updateEditingValue(const TextEditingValue(text: '2'));
    await tester.pumpAndSettle();
    expect(find.text('Agent 2', findRichText: true), findsOneWidget);
    expect(find.text('Agent 0', findRichText: true), findsNothing);
  });

  testWidgets('search choices remain above the keyboard', (tester) async {
    await open(tester, count: 20);
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.enterText(find.byType(TextField), '19');
    await tester.pumpAndSettle();
    final choice = find.text('Agent 19', findRichText: true);
    expect(tester.getBottomLeft(choice).dy, lessThan(544));
    expect(tester.takeException(), isNull);
    await tester.tap(choice);
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
  });

  testWidgets('placeholder clears normal-text contrast on its field', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    late Color background;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) {
              background = ttyRaised(Tty.of(context));
              return TtyField(
                controller: controller,
                hint: 'What should it do?',
              );
            },
          ),
        ),
      ),
    );
    final ink = tester
        .widget<TextField>(find.byType(TextField))
        .decoration!
        .hintStyle!
        .color!;
    final a = ink.computeLuminance();
    final b = background.computeLuminance();
    final contrast = ((a > b ? a : b) + .05) / ((a > b ? b : a) + .05);
    expect(contrast, greaterThanOrEqualTo(4.5));
  });
}
