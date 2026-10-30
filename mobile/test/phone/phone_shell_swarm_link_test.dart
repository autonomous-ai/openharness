import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';

import 'devices_fixture.dart';

/// A message link (Desktop's Copy link to message) opened on the phone: the
/// native side holds each until the app takes it, and the shell opens the
/// chat at that message over the Swarm page.
void main() {
  const channel = MethodChannel('harness/links');
  late DevicesApp app;
  late List<String> waiting;
  late int takes;

  setUp(() {
    app = _LinkApp()
      ..currentUser = const CurrentUserProfile(
        id: 'person-me',
        email: 'me@example.com',
      );
    experimentalFeaturesStore.value = {PhoneExperiment.swarm};
    waiting = [];
    takes = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method != 'take') return null;
          takes++;
          final taken = List.of(waiting);
          waiting.clear();
          return taken;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    experimentalFeaturesStore.value = const {};
    app.dispose();
  });

  /// The native side saying a link arrived while the app runs.
  Future<void> arrive(WidgetTester tester, String url) async {
    waiting.add(url);
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(const MethodCall('arrived')),
      (_) {},
    );
    await tester.pump();
    // The route transitions finish, as for a tapped notice.
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> start(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();
    // The route transitions finish, as for a tapped notice.
    await tester.pump(const Duration(seconds: 1));
  }

  void expectOpened(WidgetTester tester, (String, String, String) at) {
    final page = tester.widget<SwarmConversationPage>(
      find.byType(SwarmConversationPage),
    );
    expect((page.swarmId, page.conversationId, page.messageId), at);
    expect(find.byType(SwarmPage, skipOffstage: false), findsOneWidget);
  }

  testWidgets('a link that arrives opens its chat at the message, over the '
      'Swarm page', (tester) async {
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');

    expectOpened(tester, ('tab-b', 'g9', 'm7'));
  });

  testWidgets('a link that launched the app, or came before sign-in, opens '
      'once the shell is up', (tester) async {
    waiting.add('harness://swarm/tab-b/g9/m7');
    await start(tester);

    expectOpened(tester, ('tab-b', 'g9', 'm7'));
    expect(waiting, isEmpty, reason: 'taken once');
  });

  testWidgets('a second link replaces the first chat, not stacks on it', (
    tester,
  ) async {
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');
    await arrive(tester, 'harness://swarm/tab-b/g2/m1');

    expectOpened(tester, ('tab-b', 'g2', 'm1'));
    expect(find.byType(SwarmConversationPage), findsOneWidget);
  });

  testWidgets('what is not a message link opens nothing', (tester) async {
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9');
    await arrive(tester, 'harness://swarm/tab-b/g9/m7?x=1');

    expect(find.byType(SwarmConversationPage), findsNothing);
  });

  testWidgets('with Swarm off, a link says to turn it on and opens nothing', (
    tester,
  ) async {
    experimentalFeaturesStore.value = const {};
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');

    expect(find.byType(SwarmConversationPage), findsNothing);
    expect(find.byType(AgentHome), findsOneWidget);
    expect(
      find.text('Turn on Swarm in Settings to open this link.'),
      findsOneWidget,
    );
  });

  testWidgets('after the shell is gone (signed out) a link is left for the '
      'next one', (tester) async {
    await start(tester);
    await tester.pumpWidget(const SizedBox());
    final before = takes;
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');

    expect(takes, before, reason: 'nobody took it');
    expect(waiting, ['harness://swarm/tab-b/g9/m7']);
  });
}

class _LinkApp extends DevicesApp {
  @override
  void handleAppResumed() {}
}
