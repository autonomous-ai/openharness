import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';

import 'devices_fixture.dart';

/// A tapped Swarm notice opens the conversation it was about, over the Swarm
/// page — also when the tap is what launched the app.
void main() {
  late DevicesApp app;

  setUp(() {
    app = _NoticeApp()
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

  for (final on in [true, false]) {
    for (final start in ['foreground', 'background', 'cold']) {
      for (final kind in ['project', 'pm', 'group', 'decision', 'work']) {
        testWidgets('$kind notice Swarm=$on $start', (tester) async {
          experimentalFeaturesStore.value = on ? {PhoneExperiment.swarm} : {};
          final target = (
            swarmId: 'tab-b',
            conversationId: kind == 'pm'
                ? 'private-pm'
                : kind == 'project'
                ? 'project-chat'
                : 'g9',
            messageId: const ['project', 'pm', 'group'].contains(kind)
                ? 'm7'
                : null,
            decisionId: kind == 'decision' ? 'd1' : null,
          );
          if (start == 'cold') notices().openedSwarm.value = target;
          await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
          await tester.pump();
          if (start == 'background') {
            for (final state in [
              AppLifecycleState.inactive,
              AppLifecycleState.hidden,
              AppLifecycleState.paused,
            ]) {
              tester.binding.handleAppLifecycleStateChanged(state);
            }
          }
          if (start != 'cold') notices().openedSwarm.value = target;
          if (start == 'background') {
            for (final state in [
              AppLifecycleState.hidden,
              AppLifecycleState.inactive,
              AppLifecycleState.resumed,
            ]) {
              tester.binding.handleAppLifecycleStateChanged(state);
            }
          }
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          if (on) {
            final page = tester.widget<SwarmConversationPage>(
              find.byType(SwarmConversationPage),
            );
            expect(page.conversationId, target.conversationId);
            expect(page.messageId, target.messageId);
            expect(page.decisionId, target.decisionId);
          } else {
            expect(find.byType(SwarmConversationPage), findsNothing);
            expect(find.byType(AgentHome), findsOneWidget);
          }
          expect(notices().openedSwarm.value, isNull);
          await tester.pumpWidget(const SizedBox());
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.resumed,
          );
        });
      }
    }
  }

  testWidgets('a tap opens its conversation over the Swarm page', (
    tester,
  ) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();

    notices().openedSwarm.value = (
      swarmId: 'tab-b',
      conversationId: 'g9',
      messageId: null,
      decisionId: null,
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expectOpened(tester);
  });

  testWidgets('a tap that launched the app opens it too', (tester) async {
    // Read before the shell exists, so no listener sees it change.
    notices().openedSwarm.value = (
      swarmId: 'tab-b',
      conversationId: 'g9',
      messageId: null,
      decisionId: null,
    );
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expectOpened(tester);
  });
}

class _NoticeApp extends DevicesApp {
  @override
  void handleAppResumed() {}
}
