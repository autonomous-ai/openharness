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
import 'package:harness_mobile/swarm/swarm_drawer.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import 'devices_fixture.dart';

/// With Swarm on, the app opens on Swarm Home, full screen, with Settings in
/// its drawer and no way to Harness there: Settings ▸ Swarm off is the way
/// back to it. With it off, the app opens on the terminal, as it always has.
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

  /// An agent opened from its notice: the terminal at the root, over Swarm
  /// Home.
  Future<void> toHarness(WidgetTester tester) async {
    app.agentNotices.system.opened.value = (
      machineId: 'mac-1',
      agentId: 'agent-1',
    );
    await frames(tester);
  }

  /// The Swarm switch in Settings ▸ Experimental, scrolled to and tapped.
  Future<void> tapSwarmSwitch(WidgetTester tester) async {
    final row = key('settings-experiment-swarm');
    await tester.scrollUntilVisible(
      row,
      200,
      scrollable: find
          .descendant(
            of: find.byType(SettingsPage),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(row);
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

  testWidgets('with Swarm on, the drawer has no Harness: its models, then '
      'Settings at its foot', (tester) async {
    await open(tester);
    await tester.tap(key('swarm-menu'));
    await frames(tester);

    final drawer = find.byType(SwarmDrawer);
    expect(key('swarm-drawer-models'), findsOneWidget);
    expect(key('swarm-drawer-settings'), findsOneWidget);
    expect(key('swarm-drawer-harness'), findsNothing);
    expect(
      find.descendant(of: drawer, matching: find.text('Harness')),
      findsNothing,
      reason: 'Settings ▸ Swarm off is the way back to Harness',
    );
  });

  testWidgets('an agent opened from its notice puts the terminal at the root; '
      'back goes to Swarm Home; each keeps the other out of sight', (
    tester,
  ) async {
    await open(tester);

    await toHarness(tester);
    expect(find.byType(AgentHome), findsOneWidget);
    expect(find.byType(SwarmPage), findsNothing);
    expect(
      find.byType(SwarmPage, skipOffstage: false),
      findsOneWidget,
      reason: 'Home waits out of sight, as it was left',
    );

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
    await toHarness(tester);

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
    await toHarness(tester);
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

  testWidgets('Settings ▸ Swarm off, from the drawer, is the way to Harness: '
      'back from Settings is the terminal; Swarm on again from its Settings is '
      'Swarm Home', (tester) async {
    await open(tester);

    await drawerTo(tester, 'swarm-drawer-settings');
    await tapSwarmSwitch(tester);
    expect(experimentalFeaturesStore.isOn(PhoneExperiment.swarm), isFalse);
    expect(find.byType(SettingsPage), findsOneWidget, reason: 'still open');

    await tester.binding.handlePopRoute();
    await frames(tester);
    expect(find.byType(SettingsPage), findsNothing);
    expect(find.byType(AgentHome), findsOneWidget);
    expect(find.byType(SwarmPage, skipOffstage: false), findsNothing);

    // The terminal's Settings (its menu, Find), as the person reaches it.
    openPhoneSettings(tester.element(find.byType(AgentHome)), app);
    await frames(tester);
    await tapSwarmSwitch(tester);
    await tester.tap(find.text('Turn on Swarm'));
    await frames(tester);
    expect(experimentalFeaturesStore.isOn(PhoneExperiment.swarm), isTrue);
    expect(find.byType(SettingsPage), findsOneWidget, reason: 'back in it');

    await tester.binding.handlePopRoute();
    await frames(tester);
    expect(find.byType(SwarmPage), findsOneWidget);
    expect(key('swarm-menu'), findsOneWidget, reason: 'the root, not pushed');
    expect(find.byType(AgentHome), findsNothing);
  });
}
