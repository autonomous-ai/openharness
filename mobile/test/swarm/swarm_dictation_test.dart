import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_dictation.dart';

/// The phone's own recognizer as the chat reaches it: `harness/dictation`,
/// its native side answered here, and what it says routed to the take that
/// is listening — never to one already ended.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('harness/dictation');
  const codec = StandardMethodCodec();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  /// What the native side was asked, and how it answers each method.
  late List<MethodCall> calls;
  late Map<String, Object? Function(MethodCall)> answers;

  setUp(() {
    calls = [];
    answers = {
      'start': (_) => true,
      'resume': (_) => true,
      'access': (_) => 'allowed',
    };
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return answers[call.method]?.call(call);
    });
  });
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  /// The native side saying [method] about [take].
  Future<void> native(String method, int take, [Map<String, Object?>? more]) =>
      messenger.handlePlatformMessage(
        channel.name,
        codec.encodeMethodCall(MethodCall(method, {'take': take, ...?more})),
        (_) {},
      );

  /// What a take heard, in order.
  late List<Object> heard;

  Future<bool> start(SwarmChannelDictation dictation, [String? locale]) =>
      dictation.start(
        locale ?? 'vi-VN',
        onWords: (words) => heard.add(words),
        onLevel: (level) => heard.add(level),
        onEnd: (end) => heard.add(end),
      );

  setUp(() => heard = []);

  int take(MethodCall call) => (call.arguments as Map)['take'] as int;

  group('access', () {
    test('says what the person allowed', () async {
      final dictation = SwarmChannelDictation();
      for (final (answer, access) in [
        ('allowed', SwarmDictationAccess.allowed),
        ('noMic', SwarmDictationAccess.noMic),
        ('denied', SwarmDictationAccess.denied),
        ('restricted', SwarmDictationAccess.denied),
      ]) {
        answers['access'] = (_) => answer;
        expect(await dictation.access(), access, reason: answer);
      }
    });

    test('a native side that fails, or is not there, is a refusal', () async {
      final dictation = SwarmChannelDictation();
      answers['access'] = (_) => throw PlatformException(code: 'boom');
      expect(await dictation.access(), SwarmDictationAccess.denied);

      messenger.setMockMethodCallHandler(channel, null);
      expect(await dictation.access(), SwarmDictationAccess.denied);
    });
  });

  group('a take', () {
    test('listens in its locale, and hears its words, level and end', () async {
      final dictation = SwarmChannelDictation();
      expect(await start(dictation, 'ja-JP'), isTrue);
      final started = calls.single;
      expect(started.method, 'start');
      expect((started.arguments as Map)['locale'], 'ja-JP');
      final id = take(started);

      await native('words', id, {'text': 'こんにちは'});
      await native('level', id, {'rms': 0.1});
      await native('end', id, {'end': 'done'});
      await native('words', id, {'text': 'after the end'});

      expect(heard, ['こんにちは', isA<double>(), SwarmDictationEnd.done]);
    });

    test(
      'ends as the native side says, and anything unknown is a failure',
      () async {
        final dictation = SwarmChannelDictation();
        for (final (end, expected) in [
          ('noSpeech', SwarmDictationEnd.noSpeech),
          ('failed', SwarmDictationEnd.failed),
          ('whatever', SwarmDictationEnd.failed),
        ]) {
          heard.clear();
          calls.clear();
          await start(dictation);
          await native('end', take(calls.single), {'end': end});
          expect(heard, [expected], reason: end);
        }
      },
    );

    test('stop asks for this take, whose end then comes once', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final id = take(calls.single);

      await dictation.stop();
      expect(calls.last.method, 'stop');
      expect(take(calls.last), id);
      await native('end', id, {'end': 'done'});
      await native('end', id, {'end': 'failed'});

      expect(heard, [SwarmDictationEnd.done]);
    });

    test('a stop that fails ends the take as failed', () async {
      final dictation = SwarmChannelDictation();
      answers['stop'] = (_) => throw PlatformException(code: 'boom');
      await start(dictation);

      await dictation.stop();

      expect(heard, [SwarmDictationEnd.failed]);
    });

    test('cancel asks for this take, and nothing of it comes after', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final id = take(calls.single);

      await dictation.cancel();
      expect(calls.last.method, 'cancel');
      expect(take(calls.last), id);
      await native('words', id, {'text': 'late'});
      await native('end', id, {'end': 'done'});

      expect(heard, isEmpty);
    });

    test('a cancel that fails is still a cancel', () async {
      final dictation = SwarmChannelDictation();
      answers['cancel'] = (_) => throw PlatformException(code: 'boom');
      await start(dictation);
      final id = take(calls.single);

      await dictation.cancel();
      await native('words', id, {'text': 'late'});

      expect(heard, isEmpty);
    });

    test('an earlier take\'s words land nowhere in the next one', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final first = take(calls.single);
      await dictation.cancel();
      await start(dictation);
      final second = take(calls.last);
      expect(second, isNot(first));

      await native('words', first, {'text': 'old'});
      await native('words', second, {'text': 'new'});

      expect(heard, ['new']);
    });

    test(
      'without the locale, or failing to start, it does not listen',
      () async {
        final dictation = SwarmChannelDictation();
        answers['start'] = (_) => false;
        expect(await start(dictation), isFalse);
        await native('words', take(calls.last), {'text': 'nothing'});

        answers['start'] = (_) => throw PlatformException(code: 'boom');
        expect(await start(dictation), isFalse);
        await native('words', take(calls.last), {'text': 'nothing'});

        expect(heard, isEmpty);
      },
    );

    test('what it says without a take, or malformed, is ignored', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final id = take(calls.single);

      await messenger.handlePlatformMessage(
        channel.name,
        codec.encodeMethodCall(const MethodCall('words', 'text')),
        (_) {},
      );
      await native('words', id, {'text': 42});
      await native('level', id, {'rms': 'loud'});

      expect(heard, isEmpty);
    });
  });

  group('the words of a take', () {
    /// What [start] heard last: every word so far.
    String said() => heard.whereType<String>().last;

    late SwarmChannelDictation dictation;
    late int id;

    setUp(() async {
      dictation = SwarmChannelDictation();
      await start(dictation);
      id = take(calls.single);
    });

    /// The recognizer's latest best guess at what is being said: [from] and
    /// [to] where its words begin and end in the take's audio (0 where it
    /// does not say), [finished] when it says that guess is done.
    Future<void> guess(
      String text, {
      double from = 0,
      double to = 0,
      bool finished = false,
    }) => native('words', id, {
      'text': text,
      'final': finished,
      'from': from,
      'to': to,
    });

    // Tony, 10-29: 'một hai ba bốn năm' came out as 'Một 2 12345'.
    test('each guess replaces the last, however it is rewritten', () async {
      await guess('1', from: 0.4, to: 0.8);
      await guess('Một 2', from: 0.4, to: 1.2);
      await guess('123', from: 0.4, to: 1.6);
      await guess('1234', from: 0.4, to: 2.0);
      await guess('12345', from: 0.4, to: 2.4);
      expect(said(), '12345');
    });

    test('each guess replaces the last where it says no times', () async {
      await guess('1');
      await guess('Một 2');
      await guess('Một hai ba');
      expect(said(), 'Một hai ba');
      await guess('123');
      expect(said(), '123');
    });

    test('a guess with times after one without replaces it, unless that one '
        'was finished', () async {
      await guess('1');
      await guess('Một 2', from: 0.4, to: 1.2);
      expect(said(), 'Một 2');

      await guess('Một hai.', finished: true);
      await guess('Ba', from: 3.0, to: 3.3);
      expect(said(), 'Một hai. Ba');
    });

    test('a finished sentence, then new words after a pause, keeps the '
        'sentence exactly once', () async {
      await guess('Hôm nay mình làm gì', from: 0.3, to: 2.0);
      await guess('Hôm nay mình làm gì.', from: 0.3, to: 2.1, finished: true);
      await guess('Ngày', from: 3.6, to: 3.9);
      expect(said(), 'Hôm nay mình làm gì. Ngày');
      await guess('Ngày mai', from: 3.6, to: 4.3);
      expect(said(), 'Hôm nay mình làm gì. Ngày mai');
    });

    test(
      'a finished sentence, then new words, where it says no times',
      () async {
        await guess('Hôm nay mình làm gì.', finished: true);
        await guess('Ngày');
        await guess('Ngày mai');
        expect(said(), 'Hôm nay mình làm gì. Ngày mai');
      },
    );

    test('words that start after the last ended are new, though nothing '
        'said the last was finished', () async {
      await guess('hôm nay mình làm', from: 0.3, to: 2.0);
      await guess('gì', from: 3.4, to: 3.6);
      expect(said(), 'hôm nay mình làm gì');
      await guess('gì nữa', from: 3.4, to: 4.0);
      expect(said(), 'hôm nay mình làm gì nữa');
    });

    test('a guess said to be finished and then revised is replaced, not '
        'repeated', () async {
      await guess('1', from: 0.4, to: 0.8, finished: true);
      await guess('Một 2', from: 0.4, to: 1.2);
      expect(said(), 'Một 2');
    });

    test('a recognizer that says everything again after a finished sentence '
        'is not doubled', () async {
      await guess('Hôm nay', from: 0.3, to: 1.0, finished: true);
      await guess('Hôm nay mình', from: 0.3, to: 1.5);
      expect(said(), 'Hôm nay mình');

      await guess('Hôm nay mình.', finished: true);
      await guess('Hôm nay mình làm');
      expect(said(), 'Hôm nay mình làm', reason: 'where it says no times');
    });

    test('the last words, as the take stops, come once', () async {
      await guess('một hai', from: 0.3, to: 1.0);
      await guess('Một hai.', from: 0.3, to: 1.0, finished: true);
      expect(said(), 'Một hai.');
    });

    test('keeps nothing from one take for the next', () async {
      await guess('Một hai ba.', from: 0.3, to: 1.5, finished: true);
      await guess('bốn', from: 2.5, to: 2.8);
      await dictation.cancel();

      await start(dictation);
      id = take(calls.last);
      await guess('năm', from: 0.3, to: 0.6);

      expect(said(), 'năm');
    });
  });

  test('the long-press language as the recognizer\'s locale', () {
    expect(swarmDictationLocale('vi'), 'vi-VN');
    expect(swarmDictationLocale('en'), 'en-US');
    expect(swarmDictationLocale('es'), 'es-ES');
    expect(swarmDictationLocale('fr'), 'fr-FR');
    expect(swarmDictationLocale('ja'), 'ja-JP');
    expect(swarmDictationLocale('it'), 'it-IT');
    expect(
      swarmDictationLocale('xx'),
      'vi-VN',
      reason: 'Vietnamese by default',
    );
  });

  group('a take listens until it is stopped (Tony, 10-29)', () {
    /// What [start] heard last: every word so far.
    String said() => heard.whereType<String>().last;

    var now = DateTime(2026, 10, 29, 9);
    late SwarmChannelDictation dictation;
    late int id;

    setUp(() async {
      now = DateTime(2026, 10, 29, 9);
      dictation = SwarmChannelDictation(clock: () => now);
      await start(dictation);
      id = take(calls.single);
    });

    Future<void> guess(
      String text, {
      double from = 0,
      double to = 0,
      bool finished = false,
    }) => native('words', id, {
      'text': text,
      'final': finished,
      'from': from,
      'to': to,
    });

    /// The recognizer ending its session by itself, the microphone still on.
    Future<void> paused([String end = 'done']) =>
        native('paused', id, {'end': end});

    List<MethodCall> resumes() =>
        calls.where((call) => call.method == 'resume').toList();

    test('a session the recognizer ends by itself is resumed at once, its '
        'words kept', () async {
      await guess('Hôm nay mình làm gì.', from: 0.3, to: 2.1, finished: true);
      await paused();
      expect(resumes().single.arguments, {'take': id});

      // A new session's times start again from nothing.
      await guess('Ngày', from: 0.2, to: 0.5);
      await guess('Ngày mai', from: 0.2, to: 0.9);
      expect(said(), 'Hôm nay mình làm gì. Ngày mai');
      expect(heard.whereType<SwarmDictationEnd>(), isEmpty);
    });

    test('a session that ends on a guess it never finished keeps it', () async {
      await guess('hôm nay mình', from: 0.3, to: 1.2);
      await paused('noSpeech');
      await guess('làm gì', from: 0.1, to: 0.6);
      expect(said(), 'hôm nay mình làm gì');
    });

    test('a long silence, session after session, keeps listening', () async {
      await guess('một', from: 0.3, to: 0.6);
      for (var i = 0; i < 6; i++) {
        now = now.add(const Duration(seconds: 20));
        await paused('noSpeech');
      }
      expect(resumes(), hasLength(6));
      expect(heard.whereType<SwarmDictationEnd>(), isEmpty);
      await guess('hai', from: 0.2, to: 0.5);
      expect(said(), 'một hai');
    });

    test('sessions that keep ending at once, hearing nothing, are given up: '
        'the take ends as failed, its words kept', () async {
      await guess('một', from: 0.3, to: 0.6);
      await paused();
      await paused('failed');
      now = now.add(const Duration(milliseconds: 900));
      await paused('failed');

      expect(heard.whereType<SwarmDictationEnd>(), [SwarmDictationEnd.failed]);
      expect(resumes(), hasLength(2));
      expect(calls.last.method, 'cancel');
      expect(said(), 'một');
      await paused();
      expect(resumes(), hasLength(2), reason: 'given up for good');
    });

    test('words between sessions that end quickly keep it going', () async {
      for (final word in ['một', 'hai', 'ba', 'bốn']) {
        await guess(word, from: 0.1, to: 0.3);
        await paused();
      }
      expect(heard.whereType<SwarmDictationEnd>(), isEmpty);
      expect(said(), 'một hai ba bốn');
    });

    test('a resume the phone refuses ends the take as failed', () async {
      answers['resume'] = (_) => false;
      await guess('một', from: 0.3, to: 0.6);
      await paused();

      expect(heard.whereType<SwarmDictationEnd>(), [SwarmDictationEnd.failed]);
      expect(calls.last.method, 'cancel');
    });

    test('a resume that fails ends the take as failed', () async {
      answers['resume'] = (_) => throw PlatformException(code: 'boom');
      await paused();

      expect(heard.whereType<SwarmDictationEnd>(), [SwarmDictationEnd.failed]);
    });

    test('a session ending as the take stops is not resumed', () async {
      await guess('một hai', from: 0.3, to: 0.9);
      await dictation.stop();
      await paused();
      await native('end', id, {'end': 'done'});

      expect(resumes(), isEmpty);
      expect(heard.whereType<SwarmDictationEnd>(), [SwarmDictationEnd.done]);
      expect(said(), 'một hai');
    });

    test('an earlier take\'s session ending is not resumed', () async {
      await dictation.cancel();
      await start(dictation);
      await paused();

      expect(resumes(), isEmpty);
    });
  });

  group('the level the wave follows (Tony, 10-29: "a live wave")', () {
    late SwarmChannelDictation dictation;
    late int id;

    setUp(() async {
      dictation = SwarmChannelDictation();
      await start(dictation);
      id = take(calls.single);
    });

    /// The microphone at [db] dBFS, [times] buffers of a tenth of a second.
    Future<void> sound(double db, [int times = 1]) async {
      for (var i = 0; i < times; i++) {
        await native('level', id, {'rms': math.pow(10, db / 20)});
      }
    }

    double last() => heard.whereType<double>().last;

    test('a voice above the room fills the wave and the room alone leaves it '
        'low, however loud the microphone takes them', () async {
      for (final (room, voice) in [(-70.0, -45.0), (-40.0, -15.0)]) {
        await dictation.cancel();
        await start(dictation);
        id = take(calls.last);
        await sound(room, 30);
        expect(last(), lessThan(0.05), reason: 'the room at $room dB');
        await sound(voice);
        expect(last(), greaterThan(0.6), reason: 'a voice at $voice dB');
        await sound(room + 2);
        expect(last(), lessThan(0.05), reason: 'the room again');
      }
    });

    test(
      'the click the microphone opens on is forgotten within seconds',
      () async {
        await sound(-95);
        await sound(-50, 35);
        expect(last(), lessThan(0.05));
      },
    );

    test('a room that grows louder is followed', () async {
      await sound(-60, 30);
      await sound(-45, 35);
      expect(last(), lessThan(0.05));
    });

    test('near-digital silence never moves the wave', () async {
      await sound(-100, 30);
      await sound(-80);
      expect(last(), 0);
      await native('level', id, {'rms': 0});
      expect(last(), 0);
    });
  });
}
