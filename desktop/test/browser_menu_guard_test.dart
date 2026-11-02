import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/browser_menu_guard.dart';

void main() {
  late List<bool> told;

  setUp(() {
    told = [];
    BrowserMenuGuard.debugWeb = true;
    BrowserMenuGuard.debugSink = (off) async => told.add(off);
  });
  tearDown(BrowserMenuGuard.debugReset);

  test(
    'the browser menu is off while anyone holds it, back when all let go',
    () {
      final a = Object(), b = Object();
      BrowserMenuGuard.hold(a);
      BrowserMenuGuard.hold(b);
      BrowserMenuGuard.hold(b);
      expect(told, [true]);
      BrowserMenuGuard.release(a);
      expect(BrowserMenuGuard.isOff, isTrue);
      BrowserMenuGuard.release(b);
      BrowserMenuGuard.release(b);
      expect(BrowserMenuGuard.isOff, isFalse);
      expect(told, [true, false]);
    },
  );

  test('a computer has no browser menu to switch', () {
    BrowserMenuGuard.debugWeb = false;
    BrowserMenuGuard.hold(Object());
    expect(told, isEmpty);
    expect(BrowserMenuGuard.isOff, isFalse);
  });

  testWidgets('off over the child, on again when the pointer leaves', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: BrowserMenuOff(
              active: true,
              child: SizedBox(key: ValueKey('row'), width: 100, height: 40),
            ),
          ),
        ),
      ),
    );
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: const Offset(400, 400));
    await tester.pump();
    expect(told, isEmpty);
    await mouse.moveTo(tester.getCenter(find.byKey(const ValueKey('row'))));
    await tester.pump();
    expect(told, [true]);
    await mouse.moveTo(const Offset(400, 400));
    await tester.pump();
    expect(told, [true, false]);
  });

  testWidgets('a finger held down keeps it off, and lifting restores it', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: BrowserMenuOff(
              active: true,
              child: SizedBox(key: ValueKey('row'), width: 100, height: 40),
            ),
          ),
        ),
      ),
    );
    final finger = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('row'))),
      kind: PointerDeviceKind.touch,
    );
    await tester.pump();
    expect(told, [true]);
    await finger.up();
    await tester.pump();
    expect(told, [true, false]);
  });

  testWidgets('a row that goes away under the pointer gives the menu back', (
    tester,
  ) async {
    Widget app(bool show) => MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: show
              ? const BrowserMenuOff(
                  active: true,
                  child: SizedBox(key: ValueKey('row'), width: 100, height: 40),
                )
              : const SizedBox(),
        ),
      ),
    );
    await tester.pumpWidget(app(true));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: const Offset(20, 20));
    await tester.pump();
    expect(told, [true]);
    await tester.pumpWidget(app(false));
    expect(told, [true, false]);
  });

  testWidgets('an inactive child leaves the browser menu alone', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: BrowserMenuOff(
              active: false,
              child: SizedBox(key: ValueKey('row'), width: 100, height: 40),
            ),
          ),
        ),
      ),
    );
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: const Offset(20, 20));
    await tester.pump();
    expect(told, isEmpty);
  });
}
