import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/terminal_title.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_home_root.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import '../voice_fakes.dart';

/// A terminal opened from Swarm has a way back to Swarm on screen.
///
/// Opening an agent makes its terminal the ROOT page, so it has no page under it to pop to and
/// iOS has no system back: the only way out was a small dim mark in the title, which folds away
/// while the history is read. The header now carries a back chevron to Swarm, always drawn, and on
/// iOS the left edge goes back too. Android's system back is the shell's, as before.
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late ExperimentalFeaturesStore features;
  late SwarmHomeChoice home;
  late int toSwarm;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'Agent',
      engineId: 'claude',
      send: (type, payload) async => true,
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 's';
    for (var line = 0; line < 400; line++) {
      session.terminal.write('output line $line\r\n');
    }
    notifier.adoptSessionForTest(session);
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: FakeTranscriber().call,
      recorder: FakeVoiceRecorder(),
      language: language,
    );
    features = ExperimentalFeaturesStore(storage: null)
      ..value = {PhoneExperiment.swarm};
    home = SwarmHomeChoice(features);
    toSwarm = 0;
  });

  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    voice.dispose();
    language.dispose();
    home.dispose();
    features.dispose();
    notifier.dispose();
  });

  Widget terminal({bool inShell = true}) {
    final page = TerminalPage(
      notifier: notifier,
      machineId: 'm',
      agentId: 'a',
      voice: voice,
    );
    return MaterialApp(
      home: inShell
          ? PhoneShellScope(
              onMachineLinked: (_) {},
              onOpenAgent: (_, _) {},
              onShowSwarm: () => toSwarm++,
              home: home,
              child: page,
            )
          : page,
    );
  }

  Finder back() => find.byKey(const ValueKey('tty-back'));

  testWidgets('a terminal opened from Swarm has a back chevron, and tapping it '
      'goes to Swarm with no system back event', (tester) async {
    home.showHarness();
    await tester.pumpWidget(terminal());
    await tester.pump(const Duration(milliseconds: 100));

    expect(back().hitTestable(), findsOneWidget);
    await tester.tap(back());
    await tester.pump();
    expect(toSwarm, 1);
  });

  testWidgets('the chevron stays on screen while the history is read back and '
      'the title has folded away', (tester) async {
    home.showHarness();
    await tester.pumpWidget(terminal());
    await tester.pump(const Duration(milliseconds: 100));

    await tester.drag(find.byType(TerminalPage), const Offset(0, 160));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.drag(find.byType(TerminalPage), const Offset(0, -80));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byType(TerminalTitle).hitTestable(), findsNothing);
    expect(back().hitTestable(), findsOneWidget);
  });

  testWidgets('no chevron without Swarm behind the terminal: Swarm off, or '
      'Swarm Home is what shows', (tester) async {
    await tester.pumpWidget(terminal());
    await tester.pump(const Duration(milliseconds: 100));
    expect(back(), findsNothing, reason: 'Swarm Home is the root');

    features.value = const {};
    home.showHarness();
    await tester.pump();
    expect(
      back(),
      findsNothing,
      reason: 'Swarm off: the terminal is all there is',
    );

    await tester.pumpWidget(terminal(inShell: false));
    await tester.pump(const Duration(milliseconds: 100));
    expect(back(), findsNothing, reason: 'outside the shell, nowhere to go');
  });

  testWidgets('the chevron follows Swarm Home coming and going behind the '
      'terminal', (tester) async {
    await tester.pumpWidget(terminal());
    await tester.pump(const Duration(milliseconds: 100));
    expect(back(), findsNothing);

    home.showHarness();
    await tester.pump();
    expect(back(), findsOneWidget);

    home.showSwarm();
    await tester.pump();
    expect(back(), findsNothing);
  });

  testWidgets('on iOS, a swipe from the left edge goes back to Swarm', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    home.showHarness();
    await tester.pumpWidget(terminal());
    await tester.pump(const Duration(milliseconds: 100));

    await tester.dragFrom(const Offset(2, 300), const Offset(220, 0));
    await tester.pump();
    expect(toSwarm, 1);
  });

  testWidgets('a swipe that does not start at the edge is not back, and '
      'Android has no edge swipe: its system back is the shell\'s', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    home.showHarness();
    await tester.pumpWidget(terminal());
    await tester.pump(const Duration(milliseconds: 100));
    await tester.dragFrom(const Offset(120, 300), const Offset(220, 0));
    await tester.pump(const Duration(milliseconds: 300));
    expect(toSwarm, 0);

    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await tester.pumpWidget(terminal());
    await tester.pump(const Duration(milliseconds: 100));
    await tester.dragFrom(const Offset(2, 300), const Offset(220, 0));
    await tester.pump(const Duration(milliseconds: 300));
    expect(toSwarm, 0);
  });
}
