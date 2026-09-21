import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_fakes.dart';

/// Another client took this terminal: the page says who, in one line under
/// the header, with the way back beside it. A status dot alone was easy to
/// miss, and the person was about to wonder why typing did nothing.
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late List<String> opens;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    opens = [];
    session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'Agent',
      engineId: 'claude',
      send: (type, _) async {
        if (type == 'terminal_open') opens.add(type);
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

  final strip = find.byKey(const ValueKey('phone-takeover-strip'));

  testWidgets(
    'the strip names the taker and is absent while this phone drives',
    (tester) async {
      await pump(tester);
      expect(strip, findsNothing);
      await session.handleFrame('terminal_closed', {
        'streamId': 's',
        'code': 'TERMINAL_TAKEN_OVER',
        'reason': 'another client connected',
        'takenBy': {'kind': 'desktop', 'name': 'Mac mini'},
      });
      await tester.pump();
      expect(strip, findsOneWidget);
      expect(
        find.text('Mac mini took control of this terminal'),
        findsOneWidget,
      );
      // One way back, on the strip; the header's own button stands down.
      expect(find.text('Take control'), findsOneWidget);
    },
  );

  testWidgets('without a name it is another app', (tester) async {
    await pump(tester);
    await session.handleFrame('terminal_closed', {
      'streamId': 's',
      'code': 'TERMINAL_TAKEN_OVER',
    });
    await tester.pump();
    expect(
      find.text('Another app took control of this terminal'),
      findsOneWidget,
    );
  });
}
