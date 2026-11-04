import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/dictation_session.dart';
import 'package:harness/super_tabs/voice_dictation.dart';

import 'support/fake_dictation.dart';
import 'support/fake_voice_recorder.dart';

/// #2888: the composer's mic dictates live into the box, as the Claude app
/// does: words stream in at the caret as editable text, and the person's own
/// text before and after it is kept.
void main() {
  late FakeDictation recognizer;
  late FakeVoiceRecorder mic;
  late List<(Uint8List, String)> transcribed;
  late Object transcriberAnswer;
  late SuperTabDictationSession session;
  late TextEditingController box;

  setUp(() {
    recognizer = FakeDictation();
    mic = FakeVoiceRecorder();
    transcribed = [];
    transcriberAnswer = 'check the release notes';
    box = TextEditingController();
    session = SuperTabDictationSession(
      recognizer: () => recognizer,
      fallbackRecorder: () => mic,
      transcribe: (wav, lang) async {
        transcribed.add((wav, lang));
        final answer = transcriberAnswer;
        if (answer is Exception) throw answer;
        return answer as String;
      },
      lang: () => 'vi',
    );
  });

  tearDown(() {
    session.dispose();
    box.dispose();
  });

  void caretAt(String text, int offset) => box.value = TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: offset),
  );

  testWidgets('a tap listens in the computer\'s language, for its chat', (
    tester,
  ) async {
    session.start(conversationId: 'c1', root: 'r1', text: box);
    await tester.pump();
    expect(session.state, SuperTabDictationState.listening);
    expect(session.activeIn('c1', 'r1'), isTrue);
    expect(session.activeIn('c1', null), isFalse);
    expect(recognizer.calls, ['available', 'listen vi']);
  });

  testWidgets('words stream in at the caret, each partial replacing the last', (
    tester,
  ) async {
    caretAt('Hi team, tomorrow', 8);
    session.start(conversationId: 'c1', text: box);
    await tester.pump();
    recognizer.say('please');
    expect(box.text, 'Hi team, please tomorrow');
    recognizer.say('please check');
    expect(box.text, 'Hi team, please check tomorrow');
    expect(box.selection, const TextSelection.collapsed(offset: 21));
    recognizer.say('please check the notes', done: true);
    await tester.pump();
    expect(box.text, 'Hi team, please check the notes tomorrow');
    expect(session.state, SuperTabDictationState.off);
  });

  testWidgets('into an empty box, no spaces are added', (tester) async {
    session.start(conversationId: 'c1', text: box);
    await tester.pump();
    recognizer.say('ship it', done: true);
    expect(box.text, 'ship it');
  });

  testWidgets('stop ends listening and keeps what was heard', (tester) async {
    session.start(conversationId: 'c1', text: box);
    await tester.pump();
    recognizer.say('half a');
    session.stop();
    await tester.pump();
    expect(recognizer.calls.last, 'stop');
    expect(session.state, SuperTabDictationState.off);
    expect(box.text, 'half a');
    recognizer.say('late words');
    expect(box.text, 'half a');
  });

  testWidgets('typing while listening stops it and keeps both', (tester) async {
    session.start(conversationId: 'c1', text: box);
    await tester.pump();
    recognizer.say('hello');
    box.value = const TextEditingValue(
      text: 'hello!',
      selection: TextSelection.collapsed(offset: 6),
    );
    await tester.pump();
    expect(session.state, SuperTabDictationState.off);
    expect(recognizer.calls.last, 'stop');
    recognizer.say('hello there');
    expect(box.text, 'hello!');
  });

  testWidgets('refused recognition says so and listens to nothing', (
    tester,
  ) async {
    recognizer.ready = SuperTabDictationReady.refused;
    session.start(conversationId: 'c1', text: box);
    await tester.pump();
    expect(session.state, SuperTabDictationState.off);
    expect(session.refused, isTrue);
    expect(recognizer.calls, ['available']);
    expect(mic.calls, isEmpty);
  });

  testWidgets('a recognizer error keeps the words and says what happened', (
    tester,
  ) async {
    session.start(conversationId: 'c1', text: box);
    await tester.pump();
    recognizer.say('some words');
    recognizer.fail('error_network');
    await tester.pump();
    expect(session.state, SuperTabDictationState.off);
    expect(box.text, 'some words');
    expect(session.notice, SuperTabDictationSession.failed);
  });

  group('with no recognizer (a browser without speech recognition)', () {
    setUp(() => recognizer.ready = SuperTabDictationReady.none);

    testWidgets('records, and on stop the words land at the caret', (
      tester,
    ) async {
      caretAt('Hi team, tomorrow', 8);
      session.start(conversationId: 'c1', text: box);
      await tester.pump();
      expect(session.state, SuperTabDictationState.listening);
      expect(mic.calls, ['allowed', 'start']);
      session.stop();
      await tester.pump();
      await tester.pump();
      expect(mic.calls.last, 'stop');
      expect(transcribed.single.$1, mic.clip.wav);
      expect(transcribed.single.$2, 'vi');
      expect(box.text, 'Hi team, check the release notes tomorrow');
      expect(session.state, SuperTabDictationState.off);
    });

    testWidgets('a failed transcription keeps the box and says why', (
      tester,
    ) async {
      caretAt('draft', 5);
      transcriberAnswer = Exception('over the limit');
      session.start(conversationId: 'c1', text: box);
      await tester.pump();
      session.stop();
      await tester.pump();
      await tester.pump();
      expect(box.text, 'draft');
      expect(session.notice, SuperTabDictationSession.notTranscribed);
      expect(session.state, SuperTabDictationState.off);
    });

    testWidgets('a recording stops by itself at five minutes', (tester) async {
      session.start(conversationId: 'c1', text: box);
      await tester.pump();
      await tester.pump(SuperTabDictationSession.maxFallback);
      await tester.pump();
      await tester.pump();
      expect(mic.calls.last, 'stop');
      expect(box.text, 'check the release notes');
    });
  });
}
