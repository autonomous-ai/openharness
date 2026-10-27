import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';

import 'devices_fixture.dart';

/// A tapped Swarm notice opens the conversation it was about, over the Swarm
/// page — also when the tap is what launched the app.
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

  SwarmNotices notices() => app.agentNotices.system as SwarmNotices;

  void expectOpened(WidgetTester tester) {
    final page = tester.widget<SwarmConversationPage>(
      find.byType(SwarmConversationPage),
    );
    expect((page.swarmId, page.conversationId), ('tab-b', 'g9'));
    expect(find.byType(SwarmPage, skipOffstage: false), findsOneWidget);
    expect(notices().openedSwarm.value, isNull, reason: 'the tap is spent');
  }

  testWidgets('a tap opens its conversation over the Swarm page', (
    tester,
  ) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();

    notices().openedSwarm.value = (swarmId: 'tab-b', conversationId: 'g9');
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expectOpened(tester);
  });

  testWidgets('a tap that launched the app opens it too', (tester) async {
    // Read before the shell exists, so no listener sees it change.
    notices().openedSwarm.value = (swarmId: 'tab-b', conversationId: 'g9');
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expectOpened(tester);
  });
}
