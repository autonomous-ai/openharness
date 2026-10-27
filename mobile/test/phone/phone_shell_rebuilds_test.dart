import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_home_root.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';

import '../widget_rebuilds.dart';
import 'devices_fixture.dart';

/// The page stack is rebuilt from the shell only while a page that counts on
/// it is up. Swarm's pages listen for themselves, so with one of them pushed
/// an app update (an agent synced on any machine, a turn starting) rebuilds
/// nothing under it, and neither does the push itself.
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

  /// Frames enough for a page to slide in, and for the shell to hear that the
  /// stack moved. Not pumpAndSettle: Swarm keeps a poll running.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
  }

  Future<void> open(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await frames(tester);
  }

  BuildContext home(WidgetTester tester) =>
      tester.element(find.byType(SwarmPage));

  /// Three app updates, each with a frame after it.
  Future<void> ticks(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      app.notifyListeners();
      await tester.pump();
    }
  }

  testWidgets('with a Swarm chat pushed, app updates rebuild nothing of the '
      'root under it', (tester) async {
    await open(tester);
    openSwarmConversation(home(tester), 'tab-b', 'g9');
    await frames(tester);
    expect(find.byType(SwarmConversationPage), findsOneWidget);

    final rebuilt = countRebuildsUnder<SwarmHomeRoot>();
    await ticks(tester);

    expect(rebuilt(), 0);
  });

  testWidgets('pushing a Swarm chat does not build Swarm Home again', (
    tester,
  ) async {
    await open(tester);

    final rebuilt = countRebuildsOf({SwarmHomeRoot, SwarmPage});
    openSwarmConversation(home(tester), 'tab-b', 'g9');
    await frames(tester);
    tester.state<NavigatorState>(find.byType(Navigator).last).pop();
    await frames(tester);

    expect(find.byType(SwarmConversationPage), findsNothing);
    expect(rebuilt(), 0, reason: 'its scroll and rows stay as they were');
  });

  group('Harness out of sight under Swarm Home', () {
    /// Harness from the drawer, then back to Swarm Home: the terminal home
    /// is built, and kept out of sight.
    Future<void> hideHarness(WidgetTester tester) async {
      await open(tester);
      await tester.tap(find.byKey(const ValueKey('swarm-menu')));
      await frames(tester);
      await tester.tap(find.byKey(const ValueKey('swarm-drawer-harness')));
      await frames(tester);
      await tester.binding.handlePopRoute();
      await frames(tester);
      expect(find.byType(AgentHome), findsNothing);
      expect(find.byType(AgentHome, skipOffstage: false), findsOneWidget);
    }

    testWidgets('builds nothing on app updates', (tester) async {
      await hideHarness(tester);

      final rebuilt = countRebuildsUnder<AgentHome>();
      await ticks(tester);

      expect(rebuilt(), 0);
    });

    testWidgets('builds nothing on app updates with a page over Swarm Home '
        'that is rebuilt on them', (tester) async {
      await hideHarness(tester);
      unawaited(
        Navigator.of(home(tester))
            .push(phoneRoute((_) => const Text('reads the app in build'))),
      );
      await frames(tester);

      final rebuilt = countRebuildsUnder<AgentHome>();
      await ticks(tester);

      expect(rebuilt(), 0);
    });
  });

  testWidgets('a page that does not listen for itself is rebuilt on every app '
      'update, as before', (tester) async {
    await open(tester);
    var built = 0;
    unawaited(
      Navigator.of(home(tester)).push(
        phoneRoute((_) {
          built++;
          return const Text('reads the app in build');
        }),
      ),
    );
    await frames(tester);
    final before = built;

    await ticks(tester);

    expect(built - before, 3);
  });
}
