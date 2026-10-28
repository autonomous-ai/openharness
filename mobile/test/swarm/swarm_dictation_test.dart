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
    answers = {'start': (_) => true, 'access': (_) => 'allowed'};
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

      expect(heard, ['こんにちは', closeTo(35 / 45, 1e-9), SwarmDictationEnd.done]);
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

  group('a recognizer that starts its words over after a pause', () {
    /// What [start] heard last: every word so far.
    String said() => heard.whereType<String>().last;

    test('keeps what it had before', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final id = take(calls.single);

      await native('words', id, {'text': 'hôm nay mình làm'});
      await native('words', id, {'text': 'gì'});
      expect(said(), 'hôm nay mình làm gì');
      await native('words', id, {'text': 'gì nữa'});
      expect(said(), 'hôm nay mình làm gì nữa');
      await native('words', id, {'text': 'Không'});
      expect(said(), 'hôm nay mình làm gì nữa Không');
    });

    test('is not confused with one changing its mind', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final id = take(calls.single);

      await native('words', id, {'text': 'một hai ba'});
      await native('words', id, {'text': 'một hai'});
      expect(said(), 'một hai');
      await native('words', id, {'text': 'Một, hai bốn'});
      expect(said(), 'Một, hai bốn');
      await native('words', id, {'text': 'Mốt hai bốn'});
      expect(said(), 'Mốt hai bốn', reason: 'its first word revised');
    });

    test('is not doubled when it says everything again at the end', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final id = take(calls.single);

      await native('words', id, {'text': 'hôm nay mình làm'});
      await native('words', id, {'text': 'gì'});
      await native('words', id, {'text': 'Hôm nay mình làm gì nữa.'});

      expect(said(), 'Hôm nay mình làm gì nữa.');
    });

    test('keeps nothing from one take for the next', () async {
      final dictation = SwarmChannelDictation();
      await start(dictation);
      final first = take(calls.single);
      await native('words', first, {'text': 'một hai ba'});
      await native('words', first, {'text': 'bốn'});
      await dictation.cancel();

      await start(dictation);
      await native('words', take(calls.last), {'text': 'năm'});

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

  test('a level on the terminal\'s scale: -55 dB is 0, -10 dB is 1', () {
    expect(swarmDictationLevel(0), 0);
    expect(swarmDictationLevel(-1), 0);
    expect(swarmDictationLevel(0.0001), 0, reason: '-80 dB');
    expect(
      swarmDictationLevel(0.316227766),
      closeTo(1, 1e-6),
      reason: '-10 dB',
    );
    expect(swarmDictationLevel(1), 1);
    expect(swarmDictationLevel(0.01), closeTo(15 / 45, 1e-9), reason: '-40 dB');
  });
}
