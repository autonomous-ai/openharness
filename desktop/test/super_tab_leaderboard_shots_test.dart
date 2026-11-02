import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the Humans leaderboard's screenshots there: the
/// real right pane over the in-memory Swarm, never a backend or the live app.
final shots = Platform.environment['SUPER_TAB_LEADERBOARD_SHOTS'];

Future<void> showHumans(
  WidgetTester tester,
  Brightness brightness, {
  ConversationServer Function() swarm = humansSwarm,
  Size size = const Size(1300, 900),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  // The app sets the design tokens' brightness from its theme at startup.
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
  final c = swarm().controller(
    account: 'peer',
    initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
  );
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  testWidgets('screenshots for review', (tester) async {
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      await showHumans(tester, brightness);
      await captureWindow(tester, shots, 'humans-$name');
      await tester.tap(find.byKey(const ValueKey('super-person-peer')));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'person-$name');
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null);

  testWidgets('member list and Models screenshots for review', (tester) async {
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      await showHumans(
        tester,
        brightness,
        swarm: () => modelsSwarm(membersSwarm()),
        size: const Size(1300, 1000),
      );
      // Codex's mark is a picture, which a test decodes only when asked.
      await tester.runAsync(
        () => precacheImage(
          const AssetImage('assets/engine-icons/codex.png'),
          tester.element(find.byKey(const ValueKey('super-models-heading'))),
        ),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'members-$name');
      // A Models row's hover line.
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(
        tester.getCenter(find.byKey(const ValueKey('super-model-Opus 5.5'))),
      );
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await captureWindow(tester, shots, 'models-hover-$name');
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null);

  testWidgets('sidebar Models screenshots, expanded and collapsed', (
    tester,
  ) async {
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      await showHumans(
        tester,
        brightness,
        swarm: modelsSwarm,
        size: const Size(1300, 1000),
      );
      await tester.runAsync(
        () => precacheImage(
          const AssetImage('assets/engine-icons/codex.png'),
          tester.element(find.byKey(const ValueKey('super-models-heading'))),
        ),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'sidebar-models-$name');
      // The heading's hover line.
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(
        tester.getCenter(
          find.descendant(
            of: find.byKey(const ValueKey('super-models-heading')),
            matching: find.text('Models'),
          ),
        ),
      );
      await tester.pumpAndSettle(const Duration(seconds: 2));
      await captureWindow(tester, shots, 'sidebar-models-hover-$name');
      await mouse.removePointer();
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('super-models-heading')),
          matching: find.text('Models'),
        ),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'sidebar-models-collapsed-$name');
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null);
}
