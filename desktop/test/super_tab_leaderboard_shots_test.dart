import 'dart:io';

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
      await captureWindow(tester, shots, 'members-$name');
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null);
}
