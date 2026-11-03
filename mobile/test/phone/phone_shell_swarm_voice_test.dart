import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_input_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'devices_fixture.dart';

/// The shell hands its Swarm chats a mic: the terminal's speech-to-text, or
/// in sample mode the sample's own, which records nothing.
void main() {
  late DevicesApp app;

  setUp(() {
    app = _ShellApp()
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

  SwarmHost host(WidgetTester tester) =>
      tester.widget<SwarmScope>(find.byType(SwarmScope)).notifier!;

  testWidgets('a Swarm chat in the shell can be talked to', (tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();
    // The shell's first reads, on their timers, as a launch has them.
    await tester.pump(const Duration(seconds: 1));

    expect(host(tester).voice, isNotNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('in sample mode a Swarm chat hears through the sample', (
    tester,
  ) async {
    final sample = VoiceInputController(
      transcriber: (_, _) async => '',
      recorder: FakeVoiceRecorder(),
    );
    addTearDown(sample.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: VoiceInputScope(
          create: () => sample,
          child: PhoneShell(notifier: app),
        ),
      ),
    );
    await tester.pump();
    // The shell's first reads, on their timers, as a launch has them.
    await tester.pump(const Duration(seconds: 1));

    expect(host(tester).voice!(), same(sample));
    await tester.pumpWidget(const SizedBox());
  });
}

class _ShellApp extends DevicesApp {
  @override
  void handleAppResumed() {}
}
