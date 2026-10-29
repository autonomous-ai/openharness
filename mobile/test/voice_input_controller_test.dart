import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_notice.dart';

import 'voice_fakes.dart';

void main() {
  late FakeVoiceRecorder recorder;
  late FakeTranscriber backend;
  late ValueNotifier<String> language;
  late VoiceInputController voice;

  setUp(() {
    recorder = FakeVoiceRecorder();
    backend = FakeTranscriber();
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: backend.call,
      recorder: recorder,
      language: language,
    );
  });

  tearDown(() {
    voice.dispose();
    language.dispose();
  });

  test('a take that reaches its limit ends there, its words kept for the '
      'next send', () {
    fakeAsync((async) {
      backend.replies.add('a long thought');
      unawaited(voice.startListening());
      async.flushMicrotasks();

      async.elapse(VoiceInputController.maxTake);
      async.flushMicrotasks();

      expect(recorder.stops, 1);
      expect(voice.status, VoiceInputStatus.idle);
      expect(voice.transcript, 'a long thought');
    });
  });

  test('an owner that takes over the limit is told, and the take runs on', () {
    fakeAsync((async) {
      var told = 0;
      voice.onTakeLimit = () async => told++;
      unawaited(voice.startListening());
      async.flushMicrotasks();

      async.elapse(VoiceInputController.maxTake - const Duration(seconds: 1));
      expect(told, 0);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();

      expect(told, 1);
      expect(recorder.stops, 0);
      expect(backend.calls, isEmpty);
      expect(voice.status, VoiceInputStatus.listening);
      voice.clear();
    });
  });

  test('an owner that holds a take back keeps it from the backend until it '
      'says yes, asked once the microphone has closed', () async {
    final gate = Completer<bool>();
    var asked = 0;
    voice.mayTranscribe = () {
      asked++;
      expect(recorder.stops, 1, reason: 'asked after the stop');
      return gate.future;
    };
    backend.replies.add('held words');
    await voice.startListening();

    final stopping = voice.stopListening();
    await Future<void>.delayed(Duration.zero);
    expect(asked, 1);
    expect(backend.calls, isEmpty);
    expect(voice.status, VoiceInputStatus.transcribing);

    gate.complete(true);
    await stopping;
    expect(backend.calls, hasLength(1));
    expect(voice.transcript, 'held words');
  });

  test('a take its owner will not let go is never transcribed', () async {
    voice.mayTranscribe = () async => false;
    backend.replies.add('kept back');
    await voice.startListening();

    await voice.stopListening();

    expect(backend.calls, isEmpty);
    expect(voice.transcript, isEmpty);
    expect(voice.isIdle, isTrue);
    expect(voice.notice, isNull, reason: 'nothing failed');
  });

  test('a take cleared while held back is not transcribed when it is let '
      'go', () async {
    final gate = Completer<bool>();
    voice.mayTranscribe = () => gate.future;
    await voice.startListening();
    final stopping = voice.stopListening();
    await Future<void>.delayed(Duration.zero);

    voice.clear();
    gate.complete(true);
    await stopping;

    expect(backend.calls, isEmpty);
    expect(voice.isIdle, isTrue);
  });

  test('at rest until the mic is pressed', () async {
    expect(voice.isIdle, isTrue);
    expect(recorder.starts, 0);

    await voice.startListening();

    expect(voice.status, VoiceInputStatus.listening);
    expect(recorder.recording, isTrue);
    expect(voice.isIdle, isFalse);
  });

  test('an empty take leaves the mic at rest again', () async {
    await voice.startListening();

    await voice.stopListening();

    expect(voice.isIdle, isTrue, reason: 'the take came back empty');
  });

  test('stopping sends the take to the backend and keeps its words', () async {
    backend.replies.add('fix the failing test');
    await voice.startListening();

    await voice.stopListening();

    expect(backend.calls.single.lang, 'en');
    expect(voice.transcript, 'fix the failing test');
    expect(voice.status, VoiceInputStatus.idle);
  });

  test(
    'the words wait for the backend: nothing shows mid-transcription',
    () async {
      backend.pending = Completer<String>();
      await voice.startListening();

      final stopping = voice.stopListening();
      await Future<void>.delayed(Duration.zero);
      expect(voice.status, VoiceInputStatus.transcribing);
      expect(voice.transcript, isEmpty);

      backend.pending!.complete('run the tests');
      await stopping;
      expect(voice.transcript, 'run the tests');
    },
  );

  test('a second take adds to what the first one heard', () async {
    backend.replies.addAll(['run the tests', 'then commit']);
    await voice.startListening();
    await voice.stopListening();

    await voice.startListening();
    await voice.stopListening();

    expect(voice.transcript, 'run the tests then commit');
  });

  test('a refused microphone says so, and the next press asks again', () async {
    recorder.permitted = false;
    await voice.startListening();

    expect(voice.status, VoiceInputStatus.unavailable);
    expect(voice.notice, VoiceNotice.unavailable);

    recorder.permitted = true;
    await voice.startListening();
    expect(voice.status, VoiceInputStatus.listening);
  });

  test('clearing while the permission prompt is up records nothing', () async {
    recorder.pendingPermission = Completer<bool>();
    final opening = voice.startListening();
    expect(voice.status, VoiceInputStatus.starting);

    voice.clear();
    recorder.pendingPermission!.complete(true);
    await opening;

    expect(recorder.starts, 0);
    expect(voice.status, VoiceInputStatus.idle);
  });

  test('a failed transcription says so and adds nothing', () async {
    backend.fails = true;
    await voice.startListening();

    await voice.stopListening();

    expect(voice.transcript, isEmpty);
    expect(voice.notice, VoiceNotice.notTranscribed);
  });

  test('an empty transcript comes back as a notice, not a message', () async {
    await voice.startListening();

    await voice.stopListening();

    expect(voice.transcript, isEmpty);
    expect(voice.notice, VoiceNotice.nothingHeard);
  });

  test('a silent microphone is said so, and nothing is uploaded', () async {
    recorder.captured = (
      wav: Uint8List(44),
      length: const Duration(seconds: 3),
      peak: 0,
    );
    await voice.startListening();

    await voice.stopListening();

    expect(backend.calls, isEmpty);
    expect(voice.notice, VoiceNotice.noSound);
  });

  test('a take with no audio at all is said so too', () async {
    recorder.captured = null;
    await voice.startListening();

    await voice.stopListening();

    expect(backend.calls, isEmpty);
    expect(voice.notice, VoiceNotice.noSound);
  });

  test('send hands over everything heard and empties the transcript', () async {
    backend.replies.add('open a PR');
    await voice.startListening();
    await voice.stopListening();

    final delivered = <String>[];
    await voice.submit((text) async {
      delivered.add(text);
      return true;
    });

    expect(delivered, ['open a PR']);
    expect(voice.transcript, isEmpty);
  });

  test('send mid-sentence ends the take and sends it with the rest', () async {
    backend.replies.addAll(['open a PR', 'for this branch']);
    await voice.startListening();
    await voice.stopListening();
    await voice.startListening();

    final delivered = <String>[];
    await voice.submit((text) async {
      delivered.add(text);
      return true;
    });

    expect(recorder.stops, 2);
    expect(delivered, ['open a PR for this branch']);
  });

  test('a take that fails mid-send sends none of the message', () async {
    backend.replies.add('delete the');
    await voice.startListening();
    await voice.stopListening();
    await voice.startListening();
    backend.fails = true;

    var delivered = false;
    await voice.submit((_) async => delivered = true);

    expect(delivered, isFalse);
    expect(voice.transcript, 'delete the');
    expect(voice.notice, VoiceNotice.notTranscribed);
  });

  test('a send that fails keeps the words for another try', () async {
    backend.replies.add('deploy');
    await voice.startListening();
    await voice.stopListening();

    await voice.submit((_) async => false);

    expect(voice.transcript, 'deploy');
    expect(voice.notice, VoiceNotice.notSent);
    expect(voice.isSending, isFalse);
  });

  test(
    'the retry face, held again after a take fails, sends none of the message',
    () async {
      backend.replies.add('deploy');
      await voice.startListening();
      await voice.stopListening();
      await voice.submit((_) async => false);
      backend.fails = true;
      var delivered = false;

      await voice.startHold((_) async => delivered = true);
      await voice.finishHold((_) async => delivered = true);

      expect(delivered, isFalse, reason: 'what was just said is missing');
      expect(voice.transcript, 'deploy');
    },
  );

  test('clearing mid-transcription drops the words when they arrive', () async {
    backend.pending = Completer<String>();
    await voice.startListening();
    final stopping = voice.stopListening();
    await Future<void>.delayed(Duration.zero);

    voice.clear();
    backend.pending!.complete('never mind');
    await stopping;

    expect(voice.transcript, isEmpty);
    expect(voice.isIdle, isTrue);
  });

  test('clearing while recording throws the recording away', () async {
    await voice.startListening();

    voice.clear();

    expect(recorder.cancels, 1);
    expect(backend.calls, isEmpty);
  });

  test(
    'handing over to the keyboard transcribes the take in progress',
    () async {
      backend.replies.addAll(['rename the', 'module']);
      await voice.startListening();
      await voice.stopListening();
      await voice.startListening();

      expect(await voice.takeTranscript(), 'rename the module');
      expect(voice.transcript, isEmpty);
    },
  );

  test('words already on their way are not handed to the keyboard', () async {
    backend.replies.add('ship it');
    await voice.startListening();
    await voice.stopListening();
    final delivery = Completer<bool>();
    final sending = voice.submit((_) => delivery.future);
    await Future<void>.delayed(Duration.zero);

    expect(await voice.takeTranscript(), isEmpty);

    delivery.complete(true);
    await sending;
  });

  test('a take is heard in the language chosen by the time it ends', () async {
    backend.replies.add('xin chào');
    await voice.startListening();

    language.value = 'vi';
    await voice.stopListening();

    expect(backend.calls.single.lang, 'vi');
  });

  group('a pretend take', () {
    test('listens without asking for the microphone or opening it', () async {
      recorder.permitted = false;

      await voice.startListening(pretend: () => 'make a page');

      expect(voice.status, VoiceInputStatus.listening);
      expect(voice.pretending, isTrue);
      expect(recorder.starts, 0);
      expect(recorder.recording, isFalse);
    });

    test('is heard as what pretend says when it ends, and nothing is uploaded '
        'or recorded', () async {
      var prompt = 'make a page';
      await voice.startListening(pretend: () => prompt);
      // Changed while the take was on: the take is heard as the prompt at its end.
      prompt = 'make a page with a clock';
      final sent = <String>[];

      await voice.submit((text) async {
        sent.add(text);
        return true;
      });

      expect(sent, ['make a page with a clock']);
      expect(backend.calls, isEmpty);
      expect(recorder.stops, 0);
      expect(voice.isIdle, isTrue);
      expect(voice.pretending, isFalse);
    });

    test('pretend saying null makes an ordinary recording', () async {
      backend.replies.add('yes');

      await voice.startListening(pretend: () => null);
      await voice.stopListening();

      expect(recorder.starts, 1);
      expect(voice.transcript, 'yes');
    });

    test(
      'a take that pretend stops speaking for mid-way is heard as nothing',
      () async {
        String? prompt = 'make a page';
        await voice.startListening(pretend: () => prompt);
        prompt = null;
        var sends = 0;

        await voice.submit((_) async {
          sends++;
          return true;
        });

        expect(sends, 0);
        expect(voice.notice, VoiceNotice.nothingHeard);
        expect(recorder.starts, 0);
      },
    );

    test(
      'replaces words held from a send that failed, never joins them',
      () async {
        await voice.startListening(pretend: () => 'make a page');
        await voice.submit((_) async => false);
        expect(voice.transcript, 'make a page');

        await voice.startListening(pretend: () => 'make a page');
        final sent = <String>[];
        await voice.submit((text) async {
          sent.add(text);
          return true;
        });

        expect(sent, ['make a page']);
      },
    );

    test('a prompt that cannot be read ends the take as nothing heard, not a '
        'mic stuck listening', () async {
      await voice.startListening(
        pretend: () {
          if (voice.status == VoiceInputStatus.listening) throw StateError('x');
          return 'make a page';
        },
      );
      var sends = 0;

      await voice.submit((_) async {
        sends++;
        return true;
      });

      expect(sends, 0);
      expect(voice.status, VoiceInputStatus.idle);
    });

    test('moves its meter while it listens, and rests it after', () {
      fakeAsync((async) {
        unawaited(voice.startListening(pretend: () => 'make a page'));
        async.flushMicrotasks();
        final levels = <double>{};
        for (var i = 0; i < 10; i++) {
          async.elapse(const Duration(milliseconds: 90));
          levels.add(voice.level.value);
        }
        expect(levels.length, greaterThan(1));
        expect(levels.every((level) => level > 0), isTrue);

        voice.clear();
        async.elapse(const Duration(milliseconds: 200));
        expect(voice.level.value, 0);
        expect(voice.status, VoiceInputStatus.idle);
      });
    });

    test('the level is one listenable: a listener added during a pretend take '
        'comes off after it', () {
      fakeAsync((async) {
        expect(identical(voice.level, voice.level), isTrue);
        unawaited(voice.startListening(pretend: () => 'make a page'));
        async.flushMicrotasks();
        var heard = 0;
        void listener() => heard++;
        voice.level.addListener(listener);
        async.elapse(const Duration(milliseconds: 200));
        expect(heard, greaterThan(0));

        voice.clear();
        voice.level.removeListener(listener);
        heard = 0;
        unawaited(voice.startListening(pretend: () => 'make a page'));
        async.flushMicrotasks();
        async.elapse(const Duration(milliseconds: 500));
        expect(heard, 0, reason: 'nothing left on the pretend meter');
        voice.clear();
      });
    });

    test(
      'hands the keyboard nothing: what it stands for is in the prompt',
      () async {
        await voice.startListening(pretend: () => 'make a page');

        expect(await voice.takeTranscript(), isEmpty);
        expect(voice.isIdle, isTrue);
      },
    );

    test('an empty prompt is heard as nothing, and nothing is sent', () async {
      await voice.startListening(pretend: () => '  ');
      var sends = 0;

      await voice.submit((_) async {
        sends++;
        return true;
      });

      expect(sends, 0);
      expect(voice.notice, VoiceNotice.nothingHeard);
    });

    test('a take with no pretend records, whatever the last one was', () async {
      await voice.startListening(pretend: () => 'make a page');
      await voice.submit((_) async => true);
      backend.replies.add('add a test');

      await voice.startListening();
      await voice.stopListening();

      expect(recorder.starts, 1);
      expect(voice.transcript, 'add a test');
    });
  });
}
