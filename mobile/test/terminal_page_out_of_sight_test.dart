import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_fakes.dart';
import 'widget_rebuilds.dart';

/// A terminal kept out of sight (Harness under Swarm Home) does no work for
/// the app's updates or for its own output, and is current again once shown.
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late ValueNotifier<bool> hidden;

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
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 's';
    session.terminal.write('output\r\n');
    notifier.adoptSessionForTest(session);
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: FakeTranscriber().call,
      recorder: FakeVoiceRecorder(),
      language: language,
    );
    hidden = ValueNotifier(false);
  });

  tearDown(() {
    hidden.dispose();
    voice.dispose();
    language.dispose();
    notifier.dispose();
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ValueListenableBuilder(
          valueListenable: hidden,
          builder: (context, isHidden, child) =>
              OutOfSight(hidden: isHidden, child: child!),
          child: TerminalPage(
            notifier: notifier,
            machineId: 'm',
            agentId: 'a',
            voice: voice,
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  Future<void> hide(WidgetTester tester, bool value) async {
    hidden.value = value;
    await tester.pump();
  }

  /// A fact the page draws from moves, and the app says so.
  Future<void> statusMoves(WidgetTester tester) async {
    session.status = session.status == TerminalSessionStatus.controlling
        ? TerminalSessionStatus.resyncing
        : TerminalSessionStatus.controlling;
    notifier.notifyListeners();
    await tester.pump();
  }

  testWidgets('out of sight, an app update it would draw rebuilds nothing', (
    tester,
  ) async {
    await pump(tester);
    await hide(tester, true);

    final rebuilt = countRebuildsUnder<TerminalPage>();
    await statusMoves(tester);
    await statusMoves(tester);

    expect(rebuilt(), 0);
  });

  testWidgets('out of sight, output rebuilds nothing; it stays in the '
      'terminal', (tester) async {
    await pump(tester);
    await hide(tester, true);

    final rebuilt = countRebuildsUnder<TerminalPage>();
    for (var i = 0; i < 60; i++) {
      session.terminal.write('line $i\r\n');
    }
    await tester.pump();

    expect(rebuilt(), 0);
    expect(
      session.terminal.buffer.lines[session.terminal.buffer.height - 2]
          .getText()
          .trim(),
      'line 59',
    );
  });

  testWidgets('shown again, it listens again', (tester) async {
    await pump(tester);
    await hide(tester, true);
    await statusMoves(tester);
    await hide(tester, false);

    final rebuilt = countRebuildsUnder<TerminalPage>();
    await statusMoves(tester);

    expect(rebuilt(), greaterThan(0));
  });
}
