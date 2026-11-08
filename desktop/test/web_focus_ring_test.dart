// The web shell's keyboard focus ring: an accent outline around the control
// Tab reached, only after a key moved focus, gone on the next click or touch,
// never around a terminal. Audit finding P8; Desktop's frame does not draw it.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/desktop_workspace.dart' as desktop;
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/shell/web_focus_ring.dart';
import 'package:xterm/xterm.dart';

final _ring = find.byKey(const Key('web-focus-ring'));

Future<void> _show(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(1440, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    WebFocusRing(
      child: MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: home,
      ),
    ),
  );
  await tester.pump();
}

Future<void> _tab(WidgetTester tester) async {
  await tester.sendKeyEvent(LogicalKeyboardKey.tab);
  await tester.pump();
  await tester.pump();
}

/// The ring's outline, in the window's coordinates.
Rect _ringRect(WidgetTester tester) => tester.getRect(_ring);

/// The ring sits just outside [target], on every side.
void _around(WidgetTester tester, Finder target) {
  final ring = _ringRect(tester);
  final box = tester.getRect(target);
  expect(ring.contains(box.topLeft), isTrue, reason: '$ring around $box');
  expect(ring.contains(box.bottomRight - const Offset(.1, .1)), isTrue);
  expect(ring.width - box.width, lessThanOrEqualTo(8));
}

Widget _buttons() => Scaffold(
  body: Column(
    children: [
      FilledButton(
        autofocus: true,
        onPressed: () {},
        child: const Text('First'),
      ),
      OutlinedButton(onPressed: () {}, child: const Text('Second')),
      TextButton(onPressed: () {}, child: const Text('Third')),
    ],
  ),
);

void main() {
  testWidgets('no ring at rest, though a button holds focus', (tester) async {
    await _show(tester, _buttons());
    expect(FocusManager.instance.primaryFocus?.context, isNotNull);
    expect(_ring, findsNothing);
  });

  testWidgets('Tab draws it around the control it reached', (tester) async {
    await _show(tester, _buttons());
    await _tab(tester);
    expect(_ring, findsOneWidget);
    _around(tester, find.widgetWithText(OutlinedButton, 'Second'));
    await _tab(tester);
    _around(tester, find.widgetWithText(TextButton, 'Third'));
  });

  testWidgets('a click or a touch hides it', (tester) async {
    for (final kind in [PointerDeviceKind.mouse, PointerDeviceKind.touch]) {
      await _show(tester, _buttons());
      await _tab(tester);
      expect(_ring, findsOneWidget);
      final gesture = await tester.startGesture(
        const Offset(1000, 800),
        kind: kind,
      );
      await gesture.up();
      await tester.pump();
      expect(_ring, findsNothing, reason: '$kind');
    }
  });

  testWidgets('never around a terminal, which takes Tab itself', (
    tester,
  ) async {
    final terminal = Terminal();
    await _show(
      tester,
      Scaffold(
        body: Column(
          children: [
            TextButton(
              autofocus: true,
              onPressed: () {},
              child: const Text('Before'),
            ),
            SizedBox(
              width: 600,
              height: 300,
              child: TerminalView(terminal),
            ),
          ],
        ),
      ),
    );
    await _tab(tester);
    expect(
      FocusManager.instance.primaryFocus?.context
          ?.findAncestorWidgetOfExactType<TerminalView>(),
      isNotNull,
      reason: 'Tab reached the terminal',
    );
    expect(_ring, findsNothing);
  });

  testWidgets('it follows the focused row as its list scrolls', (
    tester,
  ) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await _show(
      tester,
      Scaffold(
        body: ListView(
          controller: scroll,
          children: [
            for (var i = 0; i < 40; i++)
              ListTile(
                autofocus: i == 0,
                title: Text('Row $i'),
                onTap: () {},
              ),
          ],
        ),
      ),
    );
    await _tab(tester);
    final row = find.widgetWithText(ListTile, 'Row 1');
    _around(tester, row);
    scroll.jumpTo(30);
    await tester.pump();
    await tester.pump();
    _around(tester, row);
  });

  testWidgets('it follows focus into a dialog', (tester) async {
    await _show(
      tester,
      Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            autofocus: true,
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => AlertDialog(
                actions: [
                  TextButton(onPressed: () {}, child: const Text('Cancel')),
                  FilledButton(onPressed: () {}, child: const Text('Stop')),
                ],
              ),
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await _tab(tester);
    await _tab(tester);
    final focused = FocusManager.instance.primaryFocus!.context!;
    final button = find.ancestor(
      of: find.byWidget(focused.widget),
      matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
    );
    expect(button, findsOneWidget);
    expect(
      find.ancestor(of: button, matching: find.byType(AlertDialog)),
      findsOneWidget,
    );
    _around(tester, button);
  });

  testWidgets('Desktop\'s frame has no ring: its controls keep their own focus', (
    tester,
  ) async {
    await tester.pumpWidget(
      desktop.appFrame(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: _buttons(),
        ),
      ),
    );
    await _tab(tester);
    expect(find.byType(WebFocusRing), findsNothing);
    expect(_ring, findsNothing);
  });
}
