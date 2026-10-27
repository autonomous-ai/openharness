import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_computers.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import 'devices_fixture.dart';

/// With Swarm on, the app opens on Swarm Home, full screen, with Harness and
/// Settings in its drawer. With it off, the app opens on the terminal, as it
/// always has.
void main() {
  late DevicesApp app;

  setUp(() {
    app = DevicesApp()
      ..currentUser = const CurrentUserProfile(
        id: 'person-me',
        email: 'me@example.com',
      );
    // In memory only: the value, not the store's write, so nothing reaches the state file.
    experimentalFeaturesStore.value = {PhoneExperiment.swarm};
  });
  tearDown(() {
    experimentalFeaturesStore.value = const {};
    app.dispose();
  });

  Finder key(String value) => find.byKey(ValueKey(value));

  /// Frames enough for a page to slide in or out, and for the shell to hear
  /// that the stack moved. Not pumpAndSettle: Swarm keeps a poll running.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
  }

  Future<void> open(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await frames(tester);
  }

  Future<void> drawerTo(WidgetTester tester, String row) async {
    await tester.tap(key('swarm-menu'));
    await frames(tester);
    await tester.tap(key(row));
    await frames(tester);
  }

  testWidgets('with Swarm on, it opens on Swarm Home, and builds no terminal '
      'until one is asked for', (tester) async {
    await open(tester);

    expect(find.byType(SwarmPage), findsOneWidget);
    expect(key('swarm-menu'), findsOneWidget);
    expect(key('tty-back'), findsNothing, reason: 'Home has nothing under it');
    expect(find.byType(AgentHome, skipOffstage: false), findsNothing);
  });

  testWidgets("the shell hands the app's computers to Swarm, for the start "
      'screens, and lets go of them with itself', (tester) async {
    await open(tester);

    final computers = tester
        .widget<SwarmScope>(find.byType(SwarmScope))
        .notifier!
        .computers;
    expect(computers, isA<AppSwarmComputers>());

    await tester.pumpWidget(const SizedBox());
    expect(
      () => computers!.addListener(() {}),
      throwsFlutterError,
      reason: 'disposed with the shell',
    );
  });

  testWidgets('with Swarm off, it opens on the terminal, as it always has', (
    tester,
  ) async {
    experimentalFeaturesStore.value = const {};
    await open(tester);

    expect(find.byType(AgentHome), findsOneWidget);
    expect(find.byType(SwarmPage, skipOffstage: false), findsNothing);
  });

  testWidgets('Harness in the drawer puts the terminal at the root; back goes '
      'to Swarm Home and keeps the terminal', (tester) async {
    await open(tester);

    await drawerTo(tester, 'swarm-drawer-harness');
    expect(find.byType(AgentHome), findsOneWidget);
    expect(find.byType(SwarmPage, skipOffstage: false), findsNothing);

    await tester.binding.handlePopRoute();
    await frames(tester);
    expect(find.byType(SwarmPage), findsOneWidget);
    expect(find.byType(AgentHome), findsNothing);
    expect(
      find.byType(AgentHome, skipOffstage: false),
      findsOneWidget,
      reason: 'the terminal waits out of sight, as it was left',
    );
  });

  testWidgets('Settings in the drawer opens over Swarm Home', (tester) async {
    await open(tester);

    await drawerTo(tester, 'swarm-drawer-settings');
    expect(find.byType(SettingsPage), findsOneWidget);

    await tester.binding.handlePopRoute();
    await frames(tester);
    expect(find.byType(SettingsPage), findsNothing);
    expect(find.byType(SwarmPage), findsOneWidget);
  });

  testWidgets('Swarm turned off puts the terminal at the root; turned on '
      'again, Swarm Home', (tester) async {
    await open(tester);
    await drawerTo(tester, 'swarm-drawer-harness');

    experimentalFeaturesStore.value = const {};
    await tester.pump();
    expect(find.byType(AgentHome), findsOneWidget);
    expect(find.byType(SwarmPage, skipOffstage: false), findsNothing);

    experimentalFeaturesStore.value = {PhoneExperiment.swarm};
    await frames(tester);
    expect(find.byType(SwarmPage), findsOneWidget);
    expect(find.byType(AgentHome), findsNothing);
  });

  testWidgets('Swarm asked for from the terminal (its mark, Find) closes '
      'every page and puts Swarm Home at the root', (tester) async {
    await open(tester);
    await drawerTo(tester, 'swarm-drawer-harness');
    final terminal = tester.element(find.byType(AgentHome));
    unawaited(
      Navigator.of(terminal).push(
        MaterialPageRoute<void>(builder: (_) => const Text('a page over it')),
      ),
    );
    await frames(tester);
    expect(find.text('a page over it'), findsOneWidget);

    PhoneShellScope.maybeOf(terminal)!.onShowSwarm!();
    await frames(tester);

    expect(find.text('a page over it'), findsNothing);
    expect(find.byType(SwarmPage), findsOneWidget);
    expect(key('swarm-menu'), findsOneWidget, reason: 'the root, not pushed');
    expect(find.byType(AgentHome), findsNothing);
    expect(find.byType(AgentHome, skipOffstage: false), findsOneWidget);
  });

  testWidgets('an agent opened from its notice opens on the terminal', (
    tester,
  ) async {
    await open(tester);

    app.agentNotices.system.opened.value = (
      machineId: 'mac-1',
      agentId: 'agent-1',
    );
    await frames(tester);

    expect(find.byType(AgentHome), findsOneWidget);
    expect(find.byType(SwarmPage, skipOffstage: false), findsNothing);
  });
}
