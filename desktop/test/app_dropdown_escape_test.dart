import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/widgets/finder_context_menu.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/widgets/harness_agent_picker.dart';

import 'support/focus_in.dart';

/// Escape closes a dropdown, however it was opened, and the control that opened
/// it has focus again (anh Dee, 2026-11-09). A click opens a menu without moving
/// focus into it, so the menu's own Escape never heard the key.
void main() {
  const opener = ValueKey('opener');
  var picked = 0;

  Widget app({FocusNode? controlFocus}) => MaterialApp(
    theme: buildAppTheme(brightness: Brightness.light),
    home: Scaffold(
      body: Column(
        children: [
          const TextField(key: ValueKey('field')),
          AppDropdown(
            childFocusNode: controlFocus,
            children: [
              AppMenuItem(label: 'One', onPressed: () => picked++),
              AppMenuItem(label: 'Two', onPressed: () => picked++),
            ],
            builder: (context, controller, _) => InkWell(
              key: opener,
              focusNode: controlFocus,
              onTap: () =>
                  controller.isOpen ? controller.close() : controller.open(),
              child: const Padding(
                padding: EdgeInsets.all(8),
                child: Text('Open'),
              ),
            ),
          ),
        ],
      ),
    ),
  );

  setUp(() => picked = 0);

  testWidgets(
    'Escape closes a dropdown a click opened, and focus is on its control',
    (tester) async {
      await tester.pumpWidget(app());
      // A person typing, who then clicks the control.
      await tester.tap(find.byKey(const ValueKey('field')));
      await tester.pump();
      await tester.tap(find.byKey(opener));
      await tester.pumpAndSettle();
      expect(find.text('One'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();

      expect(find.text('One'), findsNothing);
      expect(focusIsIn(find.byKey(opener)), isTrue);
      expect(picked, 0);

      // From there the keyboard works the control: Enter opens the menu again.
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('One'), findsOneWidget);
    },
  );

  testWidgets('Escape closes it every time it is opened', (tester) async {
    await tester.pumpWidget(app());
    for (var i = 0; i < 3; i++) {
      await tester.tap(find.byKey(opener));
      await tester.pumpAndSettle();
      expect(find.text('One'), findsOneWidget, reason: 'open $i');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('One'), findsNothing, reason: 'closed $i');
    }
  });

  testWidgets('Escape with the menu closed is left to whoever else takes it', (
    tester,
  ) async {
    var escaped = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Focus(
            autofocus: true,
            onKeyEvent: (_, event) {
              if (event.logicalKey == LogicalKeyboardKey.escape) escaped++;
              return KeyEventResult.ignored;
            },
            child: AppDropdown(
              children: [AppMenuItem(label: 'One', onPressed: () {})],
              builder: (context, controller, _) => TextButton(
                key: opener,
                onPressed: controller.open,
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    // A key down and its key up.
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    expect(escaped, 2);
    await tester.tap(find.byKey(opener));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('One'), findsNothing);
    // The keypress that closed the menu, down and up, closed only the menu.
    expect(escaped, 2);
  });

  testWidgets(
    'a control that brings its own focus node keeps it, and Escape closes from there',
    (tester) async {
      final control = FocusNode(debugLabel: 'control');
      addTearDown(control.dispose);
      await tester.pumpWidget(app(controlFocus: control));
      await tester.tap(find.byKey(opener));
      await tester.pumpAndSettle();
      expect(find.text('One'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('One'), findsNothing);
      expect(control.hasPrimaryFocus, isTrue);
    },
  );

  testWidgets('picking a row still runs it and closes the menu', (
    tester,
  ) async {
    await tester.pumpWidget(app());
    await tester.tap(find.byKey(opener));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Two'));
    await tester.pumpAndSettle();
    expect(picked, 1);
    expect(find.text('Two'), findsNothing);
  });

  testWidgets('the Finder\'s right-click menu closes on Escape', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: FinderContextMenu(
            items: () => [AppMenuItem(label: 'Rename', onPressed: () {})],
            child: const SizedBox(width: 200, height: 40, child: Text('a row')),
          ),
        ),
      ),
    );
    await tester.tap(find.text('a row'), buttons: kSecondaryButton);
    await tester.pumpAndSettle();
    expect(find.text('Rename'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Rename'), findsNothing);
  });

  testWidgets('the agent picker closes on Escape', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Center(
            child: HarnessAgentPicker(
              engine: 'claude',
              onSelected: (_) {},
              triggerKey: const ValueKey('trigger'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('trigger')));
    await tester.pumpAndSettle();
    expect(find.text('Codex'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Codex'), findsNothing);
  });

  testWidgets(
    'a person typing who picks a row goes on typing where they were',
    (tester) async {
      await tester.pumpWidget(app());
      await tester.tap(find.byKey(const ValueKey('field')));
      await tester.pump();
      expect(focusIsIn(find.byKey(const ValueKey('field'))), isTrue);
      await tester.tap(find.byKey(opener));
      await tester.pumpAndSettle();
      expect(focusIsIn(find.byKey(opener)), isTrue);

      await tester.tap(find.text('Two'));
      await tester.pumpAndSettle();
      expect(picked, 1);
      expect(find.text('Two'), findsNothing);
      expect(focusIsIn(find.byKey(const ValueKey('field'))), isTrue);
    },
  );

  testWidgets('a click away closes it, and focus is back where it was', (
    tester,
  ) async {
    await tester.pumpWidget(app());
    await tester.tap(find.byKey(const ValueKey('field')));
    await tester.pump();
    await tester.tap(find.byKey(opener));
    await tester.pumpAndSettle();
    expect(focusIsIn(find.byKey(opener)), isTrue);
    await tester.tapAt(const Offset(700, 500));
    await tester.pumpAndSettle();
    expect(find.text('One'), findsNothing);
    expect(focusIsIn(find.byKey(const ValueKey('field'))), isTrue);
  });

  testWidgets(
    'a control with other buttons beside it: focus goes to the anchor, and Enter presses none of them',
    (tester) async {
      var beside = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: AppDropdown(
              children: [AppMenuItem(label: 'One', onPressed: () {})],
              builder: (context, controller, _) => Row(
                children: [
                  InkWell(
                    key: opener,
                    onTap: () => controller.isOpen
                        ? controller.close()
                        : controller.open(),
                    child: const Padding(
                      padding: EdgeInsets.all(8),
                      child: Text('Open'),
                    ),
                  ),
                  TextButton(
                    key: const ValueKey('beside'),
                    onPressed: () => beside++,
                    child: const Text('Beside'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(opener));
      await tester.pumpAndSettle();
      expect(find.text('One'), findsOneWidget);
      expect(focusIsIn(find.byKey(const ValueKey('beside'))), isFalse);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(beside, 0);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('One'), findsNothing);
      expect(beside, 0);
    },
  );

  testWidgets(
    'a menu with a search keeps focus in its search, and Escape from there closes it and returns to the control',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: AppDropdown(
                searchAfter: 2,
                children: [
                  for (final label in ['One', 'Two', 'Three', 'Four'])
                    AppMenuItem(label: label, onPressed: () {}),
                ],
                builder: (context, controller, _) => InkWell(
                  key: opener,
                  onTap: () => controller.isOpen
                      ? controller.close()
                      : controller.open(),
                  child: const Padding(
                    padding: EdgeInsets.all(8),
                    child: Text('Open'),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(opener));
      await tester.pumpAndSettle();
      final search = find.byKey(const Key('app-menu-search'));
      expect(search, findsOneWidget);
      expect(focusIsIn(search), isTrue);
      await tester.enterText(search, 'Tw');
      await tester.pumpAndSettle();
      expect(find.text('Four'), findsNothing);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('app-menu-search')), findsNothing);
      expect(focusIsIn(find.byKey(opener)), isTrue);
    },
  );
}
