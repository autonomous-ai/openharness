import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/widgets/finder_context_menu.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/widgets/harness_agent_picker.dart';

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

  /// Whether the focus is on the control that opened the menu: its own node, or one inside it.
  bool controlHasFocus(WidgetTester tester) {
    final focus = FocusManager.instance.primaryFocus;
    final control = tester.element(find.byKey(opener));
    if (focus == null || focus is FocusScopeNode || focus.context == null) {
      return false;
    }
    var inside = focus.context == control;
    focus.context!.visitAncestorElements((e) {
      inside = inside || e == control;
      return !inside;
    });
    return inside;
  }

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
      expect(controlHasFocus(tester), isTrue);
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
              if (event is KeyDownEvent &&
                  event.logicalKey == LogicalKeyboardKey.escape) {
                escaped++;
              }
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
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    expect(escaped, 1);
    await tester.tap(find.byKey(opener));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('One'), findsNothing);
    // The key that closed the menu closed only the menu.
    expect(escaped, 1);
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

  testWidgets('Escape closes one level at a time: a submenu, then the menu', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: AppDropdown(
              width: 200,
              children: [
                AppMenuItem(label: 'Status', onPressed: () {}),
                AppSubmenuItem(
                  label: 'Notifications',
                  menuChildren: [
                    AppMenuItem(label: 'All new messages', onPressed: () {}),
                    AppMenuItem(label: 'Muted', onPressed: () {}),
                  ],
                ),
              ],
              builder: (context, controller, _) => InkWell(
                key: opener,
                onTap: () =>
                    controller.isOpen ? controller.close() : controller.open(),
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
    await tester.tap(find.text('Notifications'));
    await tester.pumpAndSettle();
    expect(find.text('Muted'), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Muted'), findsNothing);
    expect(find.text('Status'), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Status'), findsNothing);
  });
}
