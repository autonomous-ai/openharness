import 'dart:typed_data';
import 'dart:ui' show Locale;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/phone/voice_wav.dart';

import '../voice_fakes.dart';

/// The pieces of voice input under the mic: the WAV a take becomes, how loud it was, the language
/// it is heard in, and the microphone itself — its plugin answered here, never the real one.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// Little-endian 16-bit samples.
  Uint8List pcm(List<int> samples) {
    final data = ByteData(samples.length * 2);
    for (var i = 0; i < samples.length; i++) {
      data.setInt16(i * 2, samples[i], Endian.little);
    }
    return data.buffer.asUint8List();
  }

  group('a take as PCM', () {
    test('silence is level 0; a shout is level 1; the peak is the loudest', () {
      expect(pcm16Level(Uint8List(0)), 0);
      expect(pcm16Level(pcm([0, 0, 0, 0])), 0);
      expect(pcm16Level(pcm([32000, -32000, 32000, -32000])), 1);
      final speech = pcm16Level(pcm([900, -1200, 1500, -800]));
      expect(speech, greaterThan(0));
      expect(speech, lessThan(1));
      expect(pcm16Peak(pcm([10, -2000, 300])), 2000);
      expect(pcm16Peak(Uint8List(0)), 0);
    });

    test('wrapped as a WAV the backend can read', () {
      final samples = pcm([1, 2, 3, 4]);
      final wav = wavFromPcm16(samples, sampleRate: 16000, channels: 1);
      final header = ByteData.sublistView(wav);
      expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
      expect(String.fromCharCodes(wav.sublist(8, 12)), 'WAVE');
      expect(header.getUint32(4, Endian.little), 36 + samples.length);
      expect(header.getUint16(22, Endian.little), 1);
      expect(header.getUint32(24, Endian.little), 16000);
      expect(header.getUint32(28, Endian.little), 32000);
      expect(header.getUint32(40, Endian.little), samples.length);
      expect(wav.sublist(44), samples);
    });
  });

  group('the language it is heard in', () {
    test('the phone\'s own until one is chosen, then the one chosen', () async {
      final storage = MemoryKeyValueStore();
      final store = VoiceLanguageStore(
        storage: storage,
        preferredLocales: const [Locale('fr', 'FR')],
      );
      expect(store.value, 'fr');
      await store.select('es');
      expect(store.value, 'es');
      expect(storage.values.values, contains('es'));

      // Nothing that is not a language, and nothing twice.
      await store.select('klingon');
      expect(store.value, 'es');

      final next = VoiceLanguageStore(
        storage: storage,
        preferredLocales: const [Locale('en')],
      );
      await next.load();
      expect(next.value, 'es');
    });

    test(
      'a store that cannot be read or written keeps the language in memory',
      () async {
        final store = VoiceLanguageStore(
          storage: _Broken(),
          preferredLocales: const [Locale('ja')],
        );
        await store.load();
        expect(store.value, 'ja');
        await store.select('en');
        expect(store.value, 'en');
      },
    );
  });

  group('the microphone', () {
    late _Plugin plugin;

    setUp(() => plugin = _Plugin()..install());
    tearDown(() => plugin.uninstall());

    test(
      'records a take, and hands back the WAV, its length and its peak',
      () async {
        final mic = MicVoiceRecorder();
        expect(await mic.allowed(), isTrue);
        await mic.start();
        plugin.say(pcm(List.filled(1600, 4000)));
        plugin.say(pcm(List.filled(1600, -9000)));
        await pumpEventQueue();
        expect(mic.level.value, greaterThan(0));

        final take = await mic.stop();
        expect(take, isNotNull);
        expect(take!.peak, 9000);
        expect(take.length, const Duration(milliseconds: 200));
        expect(String.fromCharCodes(take.wav.sublist(0, 4)), 'RIFF');
        expect(mic.level.value, 0);
        await mic.dispose();
      },
    );

    test('a take in which nothing arrived is none', () async {
      final mic = MicVoiceRecorder();
      await mic.start();
      expect(await mic.stop(), isNull);
      // Stopped again with nothing running: still none, and no call to the plugin.
      expect(await mic.stop(), isNull);
      await mic.dispose();
    });

    test(
      'a device that records at another rate says so in the header',
      () async {
        final mic = MicVoiceRecorder();
        await mic.start();
        await plugin.changeConfig(sampleRate: 8000, channels: 1);
        plugin.say(pcm(List.filled(800, 1000)));
        await pumpEventQueue();
        final take = await mic.stop();
        expect(
          ByteData.sublistView(take!.wav).getUint32(24, Endian.little),
          8000,
        );
        expect(take.length, const Duration(milliseconds: 100));
        await mic.dispose();
      },
    );

    test(
      'cancelled, the take is thrown away and the next starts clean',
      () async {
        final mic = MicVoiceRecorder();
        await mic.cancel(); // Nothing to cancel yet.
        await mic.start();
        plugin.say(pcm(List.filled(1600, 4000)));
        await pumpEventQueue();
        await mic.cancel();
        expect(plugin.calls, contains('cancel'));
        await mic.start();
        plugin.say(pcm(List.filled(160, 100)));
        await pumpEventQueue();
        final take = await mic.stop();
        expect(take!.length, const Duration(milliseconds: 10));
        await mic.dispose();
      },
    );

    test('refused, it says so', () async {
      plugin.permitted = false;
      final mic = MicVoiceRecorder();
      expect(await mic.allowed(), isFalse);
      await mic.dispose();
    });
  });
}

/// A store whose every read and write fails.
class _Broken extends MemoryKeyValueStore {
  @override
  Future<String?> read(String key) async => throw Exception('unreadable');

  @override
  Future<void> write(String key, String value) async =>
      throw Exception('read-only');
}

/// The `record` plugin's side of its channels: a recorder that answers every call, and streams
/// whatever [say] hands it until it is stopped.
class _Plugin {
  static const _messages = MethodChannel('com.llfbandit.record/messages');

  bool permitted = true;
  final List<String> calls = [];
  final Set<String> _channels = {};
  MockStreamHandlerEventSink? _sink;
  String? _recorder;

  TestDefaultBinaryMessenger get _messenger =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  void install() {
    _messenger.setMockMethodCallHandler(_messages, (call) async {
      calls.add(call.method);
      final id = (call.arguments as Map?)?['recorderId'] as String?;
      switch (call.method) {
        case 'create':
          _recorder = id;
          _stream('com.llfbandit.record/events/$id', (_) {});
          return null;
        case 'hasPermission':
          return permitted;
        case 'startStream':
          _stream('com.llfbandit.record/eventsRecord/$id', (sink) {
            _sink = sink;
          });
          return null;
        case 'stop':
          _sink?.endOfStream();
          _sink = null;
          return null;
        case 'cancel':
          _sink?.endOfStream();
          _sink = null;
          return null;
        default:
          return null;
      }
    });
  }

  void _stream(
    String name,
    void Function(MockStreamHandlerEventSink sink) onListen,
  ) {
    _channels.add(name);
    _messenger.setMockStreamHandler(
      EventChannel(name),
      MockStreamHandler.inline(onListen: (_, sink) => onListen(sink)),
    );
  }

  /// A buffer of audio arriving from the microphone.
  void say(Uint8List buffer) => _sink?.success(buffer);

  /// The device announcing it records at a rate of its own.
  Future<void> changeConfig({
    required int sampleRate,
    required int channels,
  }) async {
    const codec = StandardMethodCodec();
    await _messenger.handlePlatformMessage(
      'com.llfbandit.record/configChanged/$_recorder',
      codec.encodeMethodCall(
        MethodCall('onConfigChanged', {
          'encoder': 'pcm16bits',
          'sampleRate': sampleRate,
          'numChannels': channels,
        }),
      ),
      (_) {},
    );
  }

  void uninstall() {
    _messenger.setMockMethodCallHandler(_messages, null);
    for (final name in _channels) {
      _messenger.setMockStreamHandler(EventChannel(name), null);
    }
  }
}
