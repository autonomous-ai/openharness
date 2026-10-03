import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/terminal_key_bar.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/voice_bar_line.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_action.dart';
import 'package:harness_mobile/phone/voice_mic_button.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/phone/voice_mic_fab.dart';
import 'package:harness_mobile/phone/voice_notice.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart';

import '../voice_fakes.dart';
import 'edge_fixture.dart';

/// The controls under a thumb on Focus: the mic in each of its moments, the take behind it when
/// the microphone misbehaves, the line above it, and the key strip over the keyboard.
void main() {
  group('a take the microphone will not give', () {
    late ValueNotifier<String> language;
    setUp(() => language = ValueNotifier('en'));
    tearDown(() => language.dispose());

    VoiceInputController voice(
      VoiceRecorder recorder, [
      FakeTranscriber? stt,
    ]) => VoiceInputController(
      transcriber: (stt ?? FakeTranscriber()).call,
      recorder: recorder,
      language: language,
    );

    test('a microphone that cannot start says so', () async {
      final controller = voice(_Recorder(startFails: true));
      await controller.startListening();
      expect(controller.status, VoiceInputStatus.idle);
      expect(controller.notice, VoiceNotice.couldNotStart);
      controller.dispose();
    });

    test('a permission check that throws reads as no microphone', () async {
      final controller = voice(_Recorder(allowedThrows: true));
      await controller.startListening();
      expect(controller.status, VoiceInputStatus.unavailable);
      controller.dispose();
    });

    test(
      'stopped while the permission prompt is up: nothing records',
      () async {
        final recorder = FakeVoiceRecorder()..pendingPermission = Completer();
        final controller = voice(recorder);
        unawaited(controller.startListening());
        await pumpEventQueue();
        expect(controller.status, VoiceInputStatus.starting);
        await controller.stopListening();
        expect(controller.status, VoiceInputStatus.idle);
        recorder.pendingPermission!.complete(true);
        await pumpEventQueue();
        expect(recorder.starts, 0);
        controller.dispose();
      },
    );

    test(
      'a take as short as "yes" is still heard, the mic being tapped',
      () async {
        final recorder = FakeVoiceRecorder()
          ..captured = (
            wav: Uint8List(4),
            length: const Duration(milliseconds: 50),
            peak: 9000,
          );
        final stt = FakeTranscriber()..replies.add('yes');
        final controller = voice(recorder, stt);
        await controller.startListening();
        await controller.stopListening();
        expect(controller.transcript, 'yes');
        expect(controller.notice, isNull);
        controller.dispose();
      },
    );

    test('a send that throws keeps the words for the next tap', () async {
      final stt = FakeTranscriber()..replies.add('deploy it');
      final controller = voice(FakeVoiceRecorder(), stt);
      await controller.startListening();
      await controller.submit((_) async => throw StateError('socket gone'));
      expect(controller.transcript, 'deploy it');
      expect(controller.isSending, isFalse);
      expect(controller.notice, VoiceNotice.notSent);
      controller.dispose();
    });
  });

  group('the mic', () {
    late ValueNotifier<String> language;
    late FakeTranscriber stt;
    late VoiceInputController voice;
    late TerminalSession session;

    setUp(() {
      language = ValueNotifier('en');
      stt = FakeTranscriber();
      voice = VoiceInputController(
        transcriber: stt.call,
        recorder: FakeVoiceRecorder(),
        language: language,
      );
      session = TerminalSession(
        machineId: 'm',
        agentId: 'a',
        agentName: 'a',
        engineId: 'claude',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      )..streamId = 's';
    });

    tearDown(() {
      voice.dispose();
      language.dispose();
      session.dispose();
    });

    Future<void> pumpMic(WidgetTester tester) async {
      setPhone(tester, largePhone);
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: Center(
              child: VoiceMicFab(voice: voice, session: session),
            ),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('a swipe down while recording throws the take away', (
      tester,
    ) async {
      session.status = TerminalSessionStatus.controlling;
      await pumpMic(tester);
      await tester.tap(find.byType(VoiceMicCore));
      await frames(tester);
      expect(voice.status, VoiceInputStatus.listening);
      await tester.drag(find.byType(VoiceMicCore), const Offset(0, 80));
      await frames(tester);
      expect(voice.status, VoiceInputStatus.idle);
      expect(voice.transcript, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('held: the voice language, to choose from', (tester) async {
      session.status = TerminalSessionStatus.controlling;
      await pumpMic(tester);
      await tester.longPress(find.byType(VoiceMicCore));
      await frames(tester);
      expect(find.text('Voice input language'), findsOneWidget);
      // Put away without choosing: a choice writes the real preferences file.
      await tester.tapAt(const Offset(20, 80));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('a terminal that cannot take input leaves the mic dead', (
      tester,
    ) async {
      session.status = TerminalSessionStatus.takenOver;
      await pumpMic(tester);
      final mic = tester.widget<VoiceMicButton>(find.byType(VoiceMicButton));
      expect(mic.onPressed, isNull);
      expect(find.bySemanticsLabel('Talk to the harness'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    test('each moment of a take, as a face and a press', () async {
      session.status = TerminalSessionStatus.controlling;
      expect(voiceMicAction(voice, session).face, VoiceMicFace.talk);

      final recorder = FakeVoiceRecorder()..pendingPermission = Completer();
      final opening = VoiceInputController(
        transcriber: stt.call,
        recorder: recorder,
        language: language,
      );
      unawaited(opening.startListening());
      await pumpEventQueue();
      final starting = voiceMicAction(opening, session);
      expect(starting.face, VoiceMicFace.starting);
      starting.onPressed!();
      await pumpEventQueue();
      expect(opening.status, VoiceInputStatus.idle);
      recorder.pendingPermission!.complete(true);
      opening.dispose();

      // Words held from a send that did not land: the arrow, and a press sends them again.
      stt.replies.add('ship it');
      await voice.startListening();
      await voice.submit((_) async => false);
      final retry = voiceMicAction(voice, session);
      expect(retry.face, VoiceMicFace.retry);
      retry.onPressed!();
      await pumpEventQueue();

      // A refused microphone: the tap asks again.
      final refused = VoiceInputController(
        transcriber: stt.call,
        recorder: FakeVoiceRecorder()..permitted = false,
        language: language,
      );
      await refused.startListening();
      final off = voiceMicAction(refused, session);
      expect(off.face, VoiceMicFace.off);
      off.onPressed!();
      await pumpEventQueue();
      refused.dispose();
    });
  });

  group('the line above the mic', () {
    testWidgets('a notice, words held back, and a level that swells', (
      tester,
    ) async {
      final language = ValueNotifier('en');
      final stt = FakeTranscriber();
      final recorder = _LevelRecorder();
      final voice = VoiceInputController(
        transcriber: stt.call,
        recorder: recorder,
        language: language,
      );
      addTearDown(() {
        voice.dispose();
        language.dispose();
      });
      late Tty tty;
      await tester.pumpWidget(
        phoneApp(
          Builder(
            builder: (context) {
              tty = Tty.of(context);
              return Center(child: VoiceLevelHalo(voice: voice));
            },
          ),
        ),
      );
      expect(voiceStatus(voice, tty), isNull);

      await voice.startListening();
      recorder.level.value = 0.8;
      await tester.pump(const Duration(milliseconds: 200));

      stt.replies.add('');
      await voice.stopListening();
      expect(
        voiceStatus(voice, tty)?.text,
        VoiceNotice.nothingHeard.toLowerCase(),
      );

      stt.replies.add('deploy');
      await voice.startListening();
      await voice.submit((_) async => false);
      await tester.pump(const Duration(seconds: 6));
      expect(voiceStatus(voice, tty)?.text, 'not sent · tap the mic again');

      // A different controller under the same halo follows the new one's level.
      final other = VoiceInputController(
        transcriber: stt.call,
        recorder: _LevelRecorder(),
        language: language,
      );
      addTearDown(other.dispose);
      await tester.pumpWidget(
        phoneApp(Center(child: VoiceLevelHalo(voice: other))),
      );
      await tester.pump();
    });
  });

  group('the key strip', () {
    late Terminal terminal;
    late List<String> typed;

    setUp(() {
      terminal = Terminal(maxLines: 100)..resize(80, 10);
      typed = [];
      terminal.onOutput = typed.add;
    });

    Future<void> pumpBar(
      WidgetTester tester, {
      List<KeyHint> hints = const [],
      VoidCallback? pick,
      VoidCallback? photo,
      bool enabled = true,
      bool? ctrl,
      ValueChanged<bool>? armCtrl,
    }) async {
      setPhone(tester, smallPhone);
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: TerminalKeyBar(
                terminal: terminal,
                enabled: enabled,
                onDismissKeyboard: () {},
                hints: hints,
                onPickImage: pick,
                onTakePhoto: photo,
                ctrlArmed: ctrl,
                onArmCtrl: armCtrl,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('the pane\'s own keys join the row, and press their chord', (
      tester,
    ) async {
      final hints = parseKeyHints([
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ]);
      expect(hints, isNotEmpty);
      await pumpBar(tester);
      await pumpBar(tester, hints: hints);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.text('cycle'));
      await tester.pump();
      expect(typed, ['\x1b[Z']);
    });

    testWidgets('one way to send a picture skips the choice', (tester) async {
      var picks = 0, photos = 0;
      await pumpBar(tester, pick: () => picks++);
      await tester.tap(find.byKey(const ValueKey('terminal-key-Send image')));
      expect(picks, 1);
      await pumpBar(tester, photo: () => photos++);
      await tester.tap(find.byKey(const ValueKey('terminal-key-Send image')));
      expect(photos, 1);
    });

    testWidgets('dimmed while the stream takes no input: nothing is sent', (
      tester,
    ) async {
      await pumpBar(tester, enabled: false);
      await tester.tap(find.byKey(const ValueKey('terminal-key-esc')));
      await tester.tap(find.byKey(const ValueKey('terminal-key-Up')));
      expect(typed, isEmpty);
    });

    testWidgets('ctrl as the session holds it', (tester) async {
      final armed = <bool>[];
      await pumpBar(tester, ctrl: true, armCtrl: armed.add);
      await tester.tap(find.byKey(const ValueKey('terminal-key-ctrl')));
      expect(armed, [false]);
      await tester.tap(find.byKey(const ValueKey('terminal-key-Left')));
      expect(armed, [false, false]);
    });

    testWidgets('too narrow to divide: the row lays out without the hints\' '
        'scroll', (tester) async {
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: SizedBox(
              width: 10,
              child: TerminalKeyBar(
                terminal: terminal,
                enabled: true,
                onDismissKeyboard: () {},
                hints: parseKeyHints([
                  '  ⏵⏵ accept edits on (shift+tab to cycle)',
                ]),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      // An overflow at ten pixels wide is expected; what matters is no crash.
      tester.takeException();
    });
  });
}

/// A recorder whose microphone can fail in each way it does.
class _Recorder extends FakeVoiceRecorder {
  _Recorder({this.startFails = false, this.allowedThrows = false});

  final bool startFails;
  final bool allowedThrows;

  @override
  Future<bool> allowed() async {
    if (allowedThrows) throw Exception('no audio session');
    return true;
  }

  @override
  Future<void> start() async {
    if (startFails) throw Exception('in use by another app');
    await super.start();
  }
}

/// A recorder that also says how loud it is.
class _LevelRecorder extends FakeVoiceRecorder implements VoiceLevelMeter {
  @override
  final ValueNotifier<double> level = ValueNotifier(0);
}
