import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/app_menu.dart';

/// A pointer over [AppSubmenuItem], as Slack and macOS menus treat it: pointing
/// at a sibling row closes the open submenu and clears the parent row's
/// highlight, while crossing into the submenu keeps it open.
void main() {
  const notifyKey = ValueKey('notify-row');
  final menu = MenuController();

  Future<TestGesture> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: AppDropdown(
              controller: menu,
              width: 200,
              children: [
                AppMenuItem(label: 'Status', onPressed: () {}),
                AppSubmenuItem(
                  itemKey: notifyKey,
                  label: 'Notifications',
                  menuChildren: [
                    AppMenuItem(label: 'All new messages', onPressed: () {}),
                    AppMenuItem(label: 'Muted', onPressed: () {}),
                  ],
                ),
                AppMenuItem(label: 'Sharing', onPressed: () {}),
              ],
              builder: (context, controller, _) => TextButton(
                onPressed: controller.open,
                child: const Text('Open menu'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open menu'));
    await tester.pumpAndSettle();
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: const Offset(800, 600));
    await tester.pump();
    return mouse;
  }

  bool submenuOpen(WidgetTester tester) =>
      find.text('All new messages').evaluate().isNotEmpty;

  bool rowHighlighted(WidgetTester tester) =>
      tester.widget<AppMenuItem>(find.byKey(notifyKey)).highlighted;

  testWidgets('pointing at a sibling row closes the submenu and clears the '
      'highlight', (tester) async {
    final mouse = await open(tester);
    await mouse.moveTo(tester.getCenter(find.text('Notifications')));
    await tester.pumpAndSettle();
    expect(submenuOpen(tester), isTrue);
    expect(rowHighlighted(tester), isTrue);

    await mouse.moveTo(tester.getCenter(find.text('Sharing')));
    await tester.pumpAndSettle();

    expect(submenuOpen(tester), isFalse);
    expect(rowHighlighted(tester), isFalse);
  });

  testWidgets('pointing at a row above closes it too', (tester) async {
    final mouse = await open(tester);
    await mouse.moveTo(tester.getCenter(find.text('Notifications')));
    await tester.pumpAndSettle();

    await mouse.moveTo(tester.getCenter(find.text('Status')));
    await tester.pumpAndSettle();

    expect(submenuOpen(tester), isFalse);
    expect(rowHighlighted(tester), isFalse);
  });

  testWidgets('moving into the submenu keeps it open', (tester) async {
    final mouse = await open(tester);
    final row = tester.getCenter(find.text('Notifications'));
    await mouse.moveTo(row);
    await tester.pumpAndSettle();

    final choice = tester.getCenter(find.text('All new messages'));
    // Across the gap between the panels, as a hand crosses it.
    await mouse.moveTo(Offset(choice.dx - 60, row.dy));
    await tester.pump(const Duration(milliseconds: 30));
    await mouse.moveTo(choice);
    await tester.pump(const Duration(seconds: 1));

    expect(submenuOpen(tester), isTrue);
    expect(rowHighlighted(tester), isTrue);
  });

  testWidgets('cutting across a sibling row on the way in keeps it open', (
    tester,
  ) async {
    final mouse = await open(tester);
    await mouse.moveTo(tester.getCenter(find.text('Notifications')));
    await tester.pumpAndSettle();

    // A diagonal path clips the row below before it reaches the submenu.
    await mouse.moveTo(tester.getCenter(find.text('Sharing')));
    await tester.pump(const Duration(milliseconds: 30));
    await mouse.moveTo(tester.getCenter(find.text('All new messages')));
    await tester.pump(const Duration(seconds: 1));

    expect(submenuOpen(tester), isTrue);
  });

  testWidgets('coming back to the row after leaving it keeps it open', (
    tester,
  ) async {
    final mouse = await open(tester);
    final row = tester.getCenter(find.text('Notifications'));
    await mouse.moveTo(row);
    await tester.pumpAndSettle();

    await mouse.moveTo(tester.getCenter(find.text('Sharing')));
    await tester.pump(const Duration(milliseconds: 30));
    await mouse.moveTo(row);
    await tester.pump(const Duration(seconds: 1));

    expect(submenuOpen(tester), isTrue);
  });
}
