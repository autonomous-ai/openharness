import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_button.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_fakes.dart';

void main() {
  late AppNotifier app;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late List<(String, Object)> sent;

  setUp(() {
    sent = [];
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    session =
        TerminalSession(
            machineId: 'm',
            agentId: 'a',
            agentName: 'Agent',
            engineId: 'opencode',
            send: (type, payload) async {
              sent.add((type, payload));
              return true;
            },
            sendBinary: (frame) async {
              sent.add(('keys', String.fromCharCodes(frame.bytes)));
              return true;
            },
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream';
    app.adoptSessionForTest(session);
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
    app.dispose();
  });

  Future<void> open(
    WidgetTester tester, {
    String? line,
    String agent = 'a',
  }) async {
    if (line != null) {
      app.firstSessionLine = (machineId: 'm', agentId: agent, text: line);
    }
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: app,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  testWidgets(
    'first session offers the shared ideas and sends exactly one, then spends them',
    (tester) async {
      await open(tester, line: OnboardingCopy.micSayWhat);
      expect(find.text('Say what to build, or tap one:'), findsOneWidget);
      for (final text in [
        'Explain this project to me',
        'Find a bug and fix it',
        'Run the tests',
      ]) {
        expect(find.text(text), findsOneWidget);
      }
      await tester.tap(find.text('Run the tests'));
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();
      expect(
        sent
            .where((e) => e.$1 == 'message')
            .map((e) => (e.$2 as Map)['content']),
        ['Run the tests'],
      );
      expect(app.firstSessionLine, isNull);
      expect(find.text('Explain this project to me'), findsNothing);
      expect(
        tester.widget<VoiceMicButton>(find.byType(VoiceMicButton)).face,
        VoiceMicFace.sent,
      );
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpWidget(const SizedBox());
      await open(tester);
      expect(find.text('Run the tests'), findsNothing);
    },
  );

  for (final line in [null, OnboardingCopy.micTalk, OnboardingCopy.micPickUp]) {
    testWidgets('no ideas outside the fresh hand-over: $line', (tester) async {
      await open(tester, line: line);
      expect(find.text('Run the tests'), findsNothing);
    });
  }
  testWidgets('another session does not inherit the first-session chips', (
    tester,
  ) async {
    await open(tester, line: OnboardingCopy.micSayWhat, agent: 'other');
    expect(find.text('Run the tests'), findsNothing);
  });
  for (final picked in [
    'make a small web page that shows today\'s date',
    'Run the tests',
  ]) {
    testWidgets(
      'pre-typed OpenCode task is first; choosing $picked clears before submitting',
      (tester) async {
        const typed = "make a small web page that shows today's date";
        session.terminal.resize(88, 30);
        session.terminal.write(
          '       ┃\r\n       ┃  $typed\r\n       ┃\r\n       ┃  Build · Claude\x1b[2;54H',
        );
        await open(tester, line: OnboardingCopy.micSendIt);
        expect(find.text(typed), findsOneWidget);
        expect(
          tester.getTopLeft(find.text(typed)).dy,
          lessThan(tester.getTopLeft(find.text('Run the tests')).dy),
        );
        await tester.tap(find.text(picked));
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pump();
        final message = sent.indexWhere((e) => e.$1 == 'message');
        expect(message, greaterThan(0));
        expect(
          sent
              .take(message)
              .where((e) => e.$1 == 'keys')
              .map((e) => e.$2)
              .join(),
          contains('\x15'),
        );
        expect((sent[message].$2 as Map)['content'], picked);
        expect(app.firstSessionLine, isNull);
        expect(find.text('Run the tests'), findsNothing);
        await tester.pump(const Duration(seconds: 1));
      },
    );
  }
}
