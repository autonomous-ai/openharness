// Where the paired daemon lives in the phone's terminal page: at the right end
// of the title that floats over the terminal, and a tap there opens its sheet
// rather than the harness's menu the rest of the title opens.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/daemon_scope.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import '../voice_fakes.dart';
import 'zoo_fixture.dart';

void main() {
  late AppNotifier notifier;
  late VoiceInputController voice;
  late ValueNotifier<String> language;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'Agent',
      engineId: 'claude',
      send: (type, payload) async => true,
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 's';
    session.terminal.write('output line\r\n');
    notifier.adoptSessionForTest(session);
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: FakeTranscriber().call,
      recorder: FakeVoiceRecorder(),
      language: language,
    );
  });

  tearDown(() {
    voice.dispose();
    language.dispose();
    // Disposes the session too: it was adopted as a pane.
    notifier.dispose();
  });

  Future<void> pumpPage(WidgetTester tester, {required bool host}) async {
    final page = TerminalPage(
      notifier: notifier,
      machineId: 'm',
      agentId: 'a',
      voice: voice,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: host ? DaemonHost(notifier: notifier, child: page) : page,
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  testWidgets('the chip sits at the right end of the title, and opens the '
      'sheet', (tester) async {
    notifier.api = ZooApi(FakeZooBackend());
    notifier.zoo.ensure();
    await pumpPage(tester, host: true);

    final chip = find.byKey(const ValueKey('daemon-chip'));
    final title = find.byKey(const ValueKey('terminal-title'));
    expect(chip, findsOneWidget);
    expect(find.descendant(of: title, matching: chip), findsOneWidget);
    expect(
      tester.getRect(title).right - tester.getRect(chip).right,
      lessThanOrEqualTo(13),
    );

    await tester.tap(chip);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const ValueKey('daemon-sheet')), findsOneWidget);
  });

  testWidgets('outside the signed-in shell the title has no daemon', (
    tester,
  ) async {
    await pumpPage(tester, host: false);
    expect(find.byKey(const ValueKey('terminal-title')), findsOneWidget);
    expect(find.byKey(const ValueKey('daemon-chip')), findsNothing);
  });
}
