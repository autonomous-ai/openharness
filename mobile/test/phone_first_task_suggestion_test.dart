import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart' show TerminalKey, TerminalView;
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/first_task_suggestion.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_button.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_fakes.dart';

void main() {
  late AppNotifier app;
  late TerminalSession session;
  late VoiceInputController voice;
  late ValueNotifier<String> language;
  late FakeTranscriber transcriber;
  late FakeVoiceRecorder recorder;
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
    transcriber = FakeTranscriber();
    recorder = FakeVoiceRecorder();
    voice = VoiceInputController(
      transcriber: transcriber.call,
      recorder: recorder,
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
    String page = 'a',
  }) async {
    if (line != null) {
      app.firstSessionLine = (machineId: 'm', agentId: agent, text: line);
    }
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: app,
          machineId: 'm',
          agentId: page,
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  /// Takes the page away and lets the pane settle: the first session raises the keyboard, and the
  /// key bar rising resizes the terminal behind a short debounce.
  Future<void> leave(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 100));
  }

  final keyBar = find.byKey(const ValueKey('terminal-key-esc'));

  const typed = "make a small web page that shows today's date";
  const ideas = [
    'Explain this project to me',
    'Find a bug and fix it',
    'Run the tests',
  ];
  final sendButton = find.byKey(FirstSessionSuggestion.sendKey);

  List<Object?> messages() => [
    for (final (type, payload) in sent)
      if (type == 'message') (payload as Map)['content'],
  ];

  /// Lets the send's awaited steps (clear, flush, message frame) run.
  Future<void> settleSend(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();
  }

  /// Lets the send finish without drawing a frame.
  Future<void> settleSendWithoutFrame(WidgetTester tester) async {
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    }
  }

  /// OpenCode's box with the starter Desktop typed into it, at phone width.
  void typeStarter() {
    session.terminal.resize(88, 30);
    session.terminal.write(
      '       ┃\r\n       ┃  $typed\r\n       ┃\r\n       ┃  Build · Claude\x1b[2;54H',
    );
  }

  /// OpenCode answering a send: its box emptied, the cursor where the placeholder starts — written
  /// after the tick, as the session writes output.
  void emptyBox() {
    session.outputTicks.value++;
    session.terminal.write('\x1b[2;1H\x1b[2K       ┃  \x1b[2;11H');
  }

  /// A spoken message through the real mic button and controller; only the recognizer is a fake.
  Future<void> speak(WidgetTester tester, String words) async {
    transcriber.replies.add(words);
    await tester.tap(find.byType(VoiceMicButton));
    await settleSend(tester);
    expect(voice.status, VoiceInputStatus.listening);
    await tester.tap(find.byType(VoiceMicButton));
    for (var i = 0; i < 4; i++) {
      await settleSend(tester);
    }
  }

  testWidgets(
    'the first session offers one suggestion with a Send, not three chips',
    (tester) async {
      await open(tester, line: OnboardingCopy.micSayWhat);
      expect(find.text('Say what to build, or send this:'), findsOneWidget);
      expect(find.text(ideas.first), findsOneWidget);
      expect(sendButton, findsOneWidget);
      expect(find.text('Send'), findsOneWidget);
      for (final other in ideas.skip(1)) {
        expect(find.text(other), findsNothing);
      }
      // The mic stays as the other way in.
      expect(find.byType(VoiceMicButton), findsOneWidget);
      expect(
        tester
            .widget<FirstSessionSuggestion>(find.byType(FirstSessionSuggestion))
            .onSend,
        isNotNull,
      );
    },
  );

  testWidgets(
    'Send sends exactly the suggestion once, then the suggestion goes',
    (tester) async {
      await open(tester, line: OnboardingCopy.micSayWhat);
      // A second tap while the first is on its way sends nothing more.
      await tester.tap(sendButton);
      await tester.tap(sendButton, warnIfMissed: false);
      await settleSend(tester);
      expect(messages(), [ideas.first]);
      expect(app.firstSessionLine, isNull);
      expect(sendButton, findsNothing);
      expect(find.text(ideas.first), findsNothing);
      expect(
        tester.widget<VoiceMicButton>(find.byType(VoiceMicButton)).face,
        VoiceMicFace.sent,
      );
      await tester.pump(const Duration(seconds: 1));
      // Said once: coming back to the session shows nothing.
      await tester.pumpWidget(const SizedBox());
      await open(tester);
      expect(find.text(ideas.first), findsNothing);
      expect(sendButton, findsNothing);
      expect(messages(), [ideas.first]);
    },
  );

  testWidgets(
    'a second tap in the frame after the send landed sends nothing more',
    (tester) async {
      await open(tester, line: OnboardingCopy.micSayWhat);
      await tester.tap(sendButton);
      // The send is over and the line spent, but the page has not drawn that yet: the button is still
      // there under the finger. (Seen on the iPhone: the transport answered inside one frame.)
      await settleSendWithoutFrame(tester);
      expect(app.firstSessionLine, isNull);
      await tester.tap(sendButton, warnIfMissed: false);
      await settleSendWithoutFrame(tester);
      expect(messages(), [ideas.first]);
      await tester.pump(const Duration(seconds: 1));
      await leave(tester);
    },
  );

  testWidgets(
    'Send is disabled while the session does not take input, and wakes with it',
    (tester) async {
      session.status = TerminalSessionStatus.opening;
      await open(tester, line: OnboardingCopy.micSayWhat);
      expect(sendButton, findsOneWidget);
      expect(
        tester
            .widget<FirstSessionSuggestion>(find.byType(FirstSessionSuggestion))
            .onSend,
        isNull,
      );
      await tester.tap(sendButton, warnIfMissed: false);
      await settleSend(tester);
      expect(messages(), isEmpty);
      expect(app.firstSessionLine, isNotNull);
      session.status = TerminalSessionStatus.controlling;
      session.notifyListeners();
      await tester.pump();
      expect(
        tester
            .widget<FirstSessionSuggestion>(find.byType(FirstSessionSuggestion))
            .onSend,
        isNotNull,
      );
      await tester.tap(sendButton);
      await settleSend(tester);
      expect(messages(), [ideas.first]);
    },
  );

  for (final line in [null, OnboardingCopy.micTalk, OnboardingCopy.micPickUp]) {
    testWidgets('no suggestion outside the fresh hand-over: $line', (
      tester,
    ) async {
      await open(tester, line: line);
      expect(sendButton, findsNothing);
      expect(find.text(ideas.first), findsNothing);
    });
  }

  testWidgets('another session does not inherit the suggestion', (
    tester,
  ) async {
    await open(tester, line: OnboardingCopy.micSayWhat, agent: 'other');
    expect(sendButton, findsNothing);
  });

  testWidgets('a pane of an engine that cannot be cleared offers no Send', (
    tester,
  ) async {
    final other =
        TerminalSession(
            machineId: 'm',
            agentId: 'g',
            agentName: 'Agent',
            engineId: 'gemini',
            send: (type, payload) async => true,
            sendBinary: (frame) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream';
    app.adoptSessionForTest(other);
    app.firstSessionLine = (
      machineId: 'm',
      agentId: 'g',
      text: OnboardingCopy.micSayWhat,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: app,
          machineId: 'm',
          agentId: 'g',
          voice: voice,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    expect(sendButton, findsNothing);
    expect(find.text('Say what to build, or send this:'), findsOneWidget);
  });

  group('a starter Desktop typed into OpenCode', () {
    testWidgets(
      'is the one suggestion, and Send clears the box before sending it',
      (tester) async {
        typeStarter();
        await open(tester, line: OnboardingCopy.micSendIt);
        expect(find.text(typed), findsOneWidget);
        expect(find.text(ideas.first), findsNothing);
        await tester.tap(sendButton);
        await settleSend(tester);
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
        expect(messages(), [typed]);
        expect(app.firstSessionLine, isNull);
        expect(sendButton, findsNothing);
        await tester.pump(const Duration(seconds: 1));
        await leave(tester);
      },
    );

    testWidgets('a box emptied on the keyboard still sends Desktop\'s starter, '
        'never a task the screen did not show', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      session.terminal.write('\x1b[2;1H\x1b[2K       ┃  \x1b[2;11H');
      await tester.tap(sendButton);
      await settleSend(tester);
      expect(messages(), [typed]);
      await leave(tester);
    });

    testWidgets(
      'a paste the box shows as a marker goes by Return as it stands',
      (tester) async {
        typeStarter();
        await open(tester, line: OnboardingCopy.micSendIt);
        session.terminal.write(
          '\x1b[2;1H\x1b[2K       ┃  read [Pasted text #1 +12 lines]\x1b[2;43H',
        );
        await tester.tap(sendButton);
        await settleSend(tester);
        expect(messages(), isEmpty);
        final keys = sent.where((e) => e.$1 == 'keys').map((e) => e.$2).join();
        expect(keys, contains('\r'));
        expect(
          keys,
          isNot(contains('\x15')),
          reason: 'the paste is not cleared',
        );
        await leave(tester);
      },
    );

    testWidgets('a pretend take does not follow a swipe to another page', (
      tester,
    ) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await tester.tap(find.byType(VoiceMicButton));
      await settleSend(tester);
      expect(voice.pretending, isTrue);

      await tester.pumpWidget(
        MaterialApp(
          home: TerminalPage(
            notifier: app,
            machineId: 'm',
            agentId: 'a',
            voice: voice,
            isActive: false,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(voice.pretending, isFalse);
      expect(voice.isIdle, isTrue);
      await leave(tester);
    });

    testWidgets('Send sends the box as it was last changed', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      // Changed on the keyboard since the suggestion was drawn.
      session.terminal.write(
        '\x1b[2;1H\x1b[2K       ┃  make a clock\x1b[2;23H',
      );
      await tester.tap(sendButton);
      await settleSend(tester);
      expect(messages(), ['make a clock']);
      await leave(tester);
    });

    testWidgets('a take over it records nothing, and sends the box as it '
        'stands, replacing it', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await speak(tester, 'add a login page');
      final message = sent.indexWhere((e) => e.$1 == 'message');
      expect(message, greaterThan(0));
      expect(
        sent.take(message).where((e) => e.$1 == 'keys').map((e) => e.$2).join(),
        contains('\x15'),
      );
      expect(messages(), [typed]);
      expect(recorder.starts, 0, reason: 'no microphone is opened');
      expect(transcriber.calls, isEmpty);
      expect(sendButton, findsNothing);
      await tester.pump(const Duration(seconds: 1));
      await leave(tester);
    });

    testWidgets('a take is heard as the box when it ends, changes included', (
      tester,
    ) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await tester.tap(find.byType(VoiceMicButton));
      await settleSend(tester);
      expect(voice.status, VoiceInputStatus.listening);
      session.terminal.write(
        '\x1b[2;1H\x1b[2K       ┃  make a clock\x1b[2;23H',
      );
      await tester.tap(find.byType(VoiceMicButton));
      for (var i = 0; i < 4; i++) {
        await settleSend(tester);
      }
      expect(messages(), ['make a clock']);
      await leave(tester);
    });
  });

  group('the keyboard', () {
    testWidgets('is up as the first session opens over its task, and put '
        'away, stays away', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await tester.pump();
      expect(tester.testTextInput.isVisible, isTrue);
      // The keyboard arrives: its key bar comes with it.
      tester.view.viewInsets = const FakeViewPadding(bottom: 900);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump(const Duration(seconds: 1));
      expect(keyBar, findsOneWidget);

      await tester.tap(
        find.byKey(const ValueKey('terminal-key-Hide keyboard')),
      );
      tester.view.viewInsets = FakeViewPadding.zero;
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(tester.testTextInput.isVisible, isFalse);
      expect(keyBar, findsNothing);
      // Send and the mic are there instead.
      expect(sendButton, findsOneWidget);
      expect(find.byType(VoiceMicButton), findsOneWidget);
      await leave(tester);
    });

    testWidgets('goes once Return sends the task, and stays up for the next '
        'Return', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await tester.pump();
      expect(tester.testTextInput.isVisible, isTrue);

      session.terminal.keyInput(TerminalKey.enter);
      await settleSend(tester);
      expect(app.firstSessionLine, isNull);
      // Up until the harness has taken the task: its box empties.
      expect(tester.testTextInput.isVisible, isTrue);
      emptyBox();
      await settleSend(tester);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.testTextInput.isVisible, isFalse);

      // Raised again by hand, a tap on the prompt: Return in a session at work keeps it up.
      final terminal = tester.getRect(find.byType(TerminalView));
      final screen =
          tester.view.physicalSize.height / tester.view.devicePixelRatio;
      final bottom = terminal.bottom < screen ? terminal.bottom : screen - 40;
      await tester.tapAt(Offset(terminal.left + 30, bottom - 8));
      await settleSend(tester);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.testTextInput.isVisible, isTrue);
      session.terminal.keyInput(TerminalKey.enter);
      await settleSend(tester);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.testTextInput.isVisible, isTrue);
      await leave(tester);
    });

    testWidgets('stays down while it slides away, through a keyframe that '
        'lands meanwhile', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await tester.pump();
      tester.view.viewInsets = const FakeViewPadding(bottom: 900);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump(const Duration(seconds: 1));
      expect(tester.testTextInput.isVisible, isTrue);

      session.terminal.keyInput(TerminalKey.enter);
      await settleSend(tester);
      // Still sliding down — the inset is not gone yet — when the harness redraws in a keyframe.
      tester.view.viewInsets = const FakeViewPadding(bottom: 500);
      await tester.pump(const Duration(milliseconds: 50));
      unawaited(
        session.handleBinary(
          TerminalBinaryFrame(
            kind: TerminalBinaryKind.keyframe,
            streamId: 'stream',
            seq: 0,
            bytes: Uint8List.fromList(
              utf8.encode('       ┃\r\n       ┃  \r\n       ┃\x1b[2;11H'),
            ),
            compressed: false,
            cols: 88,
            rows: 30,
          ),
        ),
      );
      await settleSend(tester);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      expect(session.terminal.buffer.lines[1].getText(), contains('┃'));
      expect(tester.testTextInput.isVisible, isFalse);

      tester.view.viewInsets = FakeViewPadding.zero;
      // Past the wait the keyframe started for the pane's own resize.
      await tester.pump(const Duration(seconds: 2));
      expect(tester.testTextInput.isVisible, isFalse);
      await leave(tester);
    });

    testWidgets('goes once Send sends the task', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await tester.pump();
      expect(tester.testTextInput.isVisible, isTrue);

      await tester.tap(sendButton);
      await settleSend(tester);
      emptyBox();
      await settleSend(tester);
      await tester.pump(const Duration(seconds: 1));
      expect(messages(), [typed]);
      expect(tester.testTextInput.isVisible, isFalse);
      await leave(tester);
    });

    testWidgets('stays up after a Return that sent nothing: the prompt still '
        'holds its text', (tester) async {
      typeStarter();
      await open(tester, line: OnboardingCopy.micSendIt);
      await tester.pump();

      // A file picked from a menu, say: the box redraws with its text still in it.
      session.terminal.keyInput(TerminalKey.enter);
      await settleSend(tester);
      session.outputTicks.value++;
      session.terminal.write('\x1b[2;1H\x1b[2K       ┃  $typed\x1b[2;54H');
      await settleSend(tester);
      await tester.pump(const Duration(seconds: 4));
      expect(tester.testTextInput.isVisible, isTrue);
      await leave(tester);
    });

    for (final line in [
      null,
      OnboardingCopy.micTalk,
      OnboardingCopy.micPickUp,
    ]) {
      testWidgets('is not raised outside the fresh hand-over: $line', (
        tester,
      ) async {
        await open(tester, line: line);
        await tester.pump();
        expect(tester.testTextInput.isVisible, isFalse);
        await leave(tester);
      });
    }
  });

  group('a fresh Claude Code', () {
    late TerminalSession claude;

    setUp(() {
      claude =
          TerminalSession(
              machineId: 'm',
              agentId: 'c',
              agentName: 'Agent',
              engineId: 'claude',
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
      app.adoptSessionForTest(claude);
    });

    String keys() => sent.where((e) => e.$1 == 'keys').map((e) => e.$2).join();

    /// Claude Code's prompt between its rules, with [typed] in it and the cursor after it — written
    /// as the session writes output: the tick first, then the text.
    void drawPrompt([String typed = '']) {
      claude.terminal.resize(60, 20);
      claude.outputTicks.value++;
      claude.terminal.write(
        '\x1b[H\x1b[2J${'─' * 60}\r\n❯ $typed\r\n${'─' * 60}'
        '\x1b[2;${3 + typed.length}H',
      );
    }

    /// Claude Code asking first, its cursor on the answer: a dialog where the prompt will be.
    void drawQuestion() {
      claude.terminal.resize(60, 20);
      claude.outputTicks.value++;
      claude.terminal.write(
        '\x1b[H\x1b[2J${'─' * 60}\r\n Do you want to proceed?\r\n'
        '❯ 1. Yes\r\n  2. No\r\n\r\n Esc to cancel · Enter to select'
        '\x1b[3;3H',
      );
    }

    testWidgets('a prompt that arrives in a keyframe gets the idea too', (
      tester,
    ) async {
      await open(
        tester,
        line: OnboardingCopy.micSayWhat,
        agent: 'c',
        page: 'c',
      );
      await settleSend(tester);
      expect(keys(), isNot(contains(ideas.first)));

      // A keyframe swaps the screen and notifies the session; no output tick.
      claude.terminal.resize(60, 20);
      claude.terminal.write('${'─' * 60}\r\n❯ \r\n${'─' * 60}\x1b[2;3H');
      claude.notifyListeners();
      await settleSend(tester);
      expect(keys(), contains(ideas.first));
      expect(tester.testTextInput.isVisible, isTrue);
      await leave(tester);
    });

    testWidgets('a question first: no keyboard over it, the mic records an '
        'answer, and the prompt after it gets the idea', (tester) async {
      drawQuestion();
      await open(
        tester,
        line: OnboardingCopy.micSayWhat,
        agent: 'c',
        page: 'c',
      );
      await settleSend(tester);
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.testTextInput.isVisible, isFalse);
      expect(keys(), isNot(contains(ideas.first)));

      await tester.tap(find.byType(VoiceMicButton));
      await settleSend(tester);
      expect(voice.status, VoiceInputStatus.listening);
      expect(recorder.starts, 1, reason: 'an answer is spoken, not pretended');
      voice.clear();
      await settleSend(tester);

      // Answered on the computer: the prompt is drawn.
      drawPrompt();
      await settleSend(tester);
      await tester.pump(const Duration(milliseconds: 300));
      expect(keys(), contains(ideas.first));
      expect(tester.testTextInput.isVisible, isTrue);
      await leave(tester);
    });

    testWidgets('gets the first idea typed into its prompt, unsent, once the '
        'prompt is drawn', (tester) async {
      await open(
        tester,
        line: OnboardingCopy.micSayWhat,
        agent: 'c',
        page: 'c',
      );
      await settleSend(tester);
      expect(keys(), isNot(contains(ideas.first)), reason: 'nothing drawn yet');

      drawPrompt();
      await settleSend(tester);
      expect(keys(), contains(ideas.first));
      expect(keys(), isNot(contains('\r')));
      expect(messages(), isEmpty);
      expect(tester.testTextInput.isVisible, isTrue);
      await leave(tester);
    });

    testWidgets('a prompt somebody typed into first is left alone', (
      tester,
    ) async {
      drawPrompt('my own words');
      await open(
        tester,
        line: OnboardingCopy.micSayWhat,
        agent: 'c',
        page: 'c',
      );
      await settleSend(tester);
      expect(keys(), isNot(contains(ideas.first)));
      await leave(tester);
    });

    testWidgets('Send and the mic send its prompt as last changed', (
      tester,
    ) async {
      drawPrompt();
      await open(
        tester,
        line: OnboardingCopy.micSayWhat,
        agent: 'c',
        page: 'c',
      );
      await settleSend(tester);
      // Claude Code echoes the idea, and it is changed on the keyboard.
      drawPrompt('Explain this repo');
      await tester.tap(find.byType(VoiceMicButton));
      await settleSend(tester);
      await tester.tap(find.byType(VoiceMicButton));
      for (var i = 0; i < 4; i++) {
        await settleSend(tester);
      }
      expect(messages(), ['Explain this repo']);
      expect(recorder.starts, 0);
      await leave(tester);
    });
  });

  group('the mic stays the other way in', () {
    testWidgets(
      'a take sends the task, asks for no microphone, and the suggestion goes',
      (tester) async {
        recorder.permitted = false;
        await open(tester, line: OnboardingCopy.micSayWhat);
        await speak(tester, 'add a login page');
        expect(messages(), [ideas.first]);
        expect(recorder.starts, 0);
        expect(transcriber.calls, isEmpty);
        expect(app.firstSessionLine, isNull);
        expect(sendButton, findsNothing);
        expect(find.text(ideas.first), findsNothing);
        await tester.pump(const Duration(seconds: 1));
        await leave(tester);
      },
    );

    testWidgets('after the first send, a take is a recording again', (
      tester,
    ) async {
      await open(tester, line: OnboardingCopy.micSayWhat);
      await speak(tester, 'add a login page');
      expect(messages(), [ideas.first]);
      await tester.pump(const Duration(seconds: 3));
      transcriber.replies.clear();

      await speak(tester, 'now add a test');
      expect(recorder.starts, 1);
      expect(messages(), [ideas.first, 'now add a test']);
      await tester.pump(const Duration(seconds: 1));
      await leave(tester);
    });

    for (final starter in [false, true]) {
      testWidgets('while a take is on, the suggestion and its line step aside, and are back when the take is dropped'
          '${starter ? ' (a starter Desktop typed)' : ''}', (tester) async {
        final line = starter
            ? OnboardingCopy.micSendIt
            : OnboardingCopy.micSayWhat;
        if (starter) typeStarter();
        await open(tester, line: line);
        expect(find.text(line), findsOneWidget);
        expect(sendButton, findsOneWidget);
        await tester.tap(find.byType(VoiceMicButton));
        await settleSend(tester);
        expect(voice.status, VoiceInputStatus.listening);
        // The line is not left standing over an empty row.
        expect(sendButton, findsNothing);
        expect(find.text(line), findsNothing);
        expect(find.byKey(const ValueKey('first-session-line')), findsNothing);
        // The take is thrown away, nothing was said: both are the way to start again.
        voice.clear();
        await tester.pump(const Duration(seconds: 3));
        await settleSend(tester);
        expect(sendButton, findsOneWidget);
        expect(find.text(line), findsOneWidget);
        expect(app.firstSessionLine, isNotNull);
        await leave(tester);
      });
    }
  });
}
