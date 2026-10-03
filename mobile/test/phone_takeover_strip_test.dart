import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart' show TerminalView;

import 'voice_fakes.dart';

/// Another client took this terminal: there is nothing to read or find — a tap on it (or a
/// scroll) takes it back. The owner's call: "as long as I tap or scroll it should auto take
/// control".
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late List<String> opens;
  late List<(String, Map<String, dynamic>)> sent;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    opens = [];
    sent = [];
    session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'Agent',
      engineId: 'claude',
      send: (type, payload) async {
        if (type == 'terminal_open') opens.add(type);
        sent.add((type, payload));
        return true;
      },
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
  });

  tearDown(() {
    voice.dispose();
    language.dispose();
    notifier.dispose();
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: notifier,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  testWidgets(
    'a terminal taken elsewhere shows no strip and no Take control to find',
    (tester) async {
      await pump(tester);
      await session.handleFrame('terminal_closed', {
        'streamId': 's',
        'code': 'TERMINAL_TAKEN_OVER',
        'reason': 'another client connected',
        'takenBy': {'kind': 'desktop', 'name': 'Mac mini'},
      });
      await tester.pump();
      // No strip and no button to find: the terminal is still the terminal.
      expect(find.byKey(const ValueKey('phone-takeover-strip')), findsNothing);
      expect(find.text('Take control'), findsNothing);
      // A tap on it goes to `_takeControl` (TerminalPanel's `onInputTap` while blocked) — which
      // reopens through the notifier's connection, absent here.
      await tester.tap(find.byType(TerminalView));
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets(
    'a take finished after the desktop took the terminal takes it back and lands',
    (tester) async {
      await pump(tester);
      // The desktop took it while the take was being spoken (the log of 2026-09-27: 14:17:43).
      await session.handleFrame('terminal_closed', {
        'streamId': 's',
        'code': 'TERMINAL_TAKEN_OVER',
        'reason': 'another client connected',
        'takenBy': {'kind': 'desktop', 'name': 'M2'},
      });
      await tester.pump();
      expect(session.acceptsInput, isFalse);

      final delivered = session.voiceDeliver!('run the tests again');
      await tester.pump(const Duration(milliseconds: 300));
      // Not "not sent": it waits for the terminal it asked back for. Here the reopen is
      // answered by hand — there is no machine behind this notifier.
      session.status = TerminalSessionStatus.controlling;
      session.streamId = 's2';
      await tester.pump(const Duration(milliseconds: 200));

      expect(await delivered, isTrue);
      expect(
        sent
            .where((frame) => frame.$1 == 'message')
            .map((f) => f.$2['content']),
        ['run the tests again'],
      );
    },
  );
}
