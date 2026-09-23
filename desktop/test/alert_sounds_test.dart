// The noise the app makes when an agent finishes or gets stuck: when it plays, when it stays
// quiet, and what the switch in Settings actually controls.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/notify/alert_sounds.dart';

/// A key/value store that lives in memory, standing in for the file one.
class _Memory implements LocalKeyValueStore {
  final values = <String, String?>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// Every `playAlert` the platform was asked for, in order.
  late List<String> played;
  late MethodChannel channel;

  setUp(() {
    played = [];
    channel = const MethodChannel('harness/swarm_tabs');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'playAlert') {
            played.add((call.arguments as Map)['sound'] as String);
          }
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  AlertSounds sounds(AlertSoundStore store, {DateTime Function()? clock}) =>
      AlertSounds(
        store: store,
        channel: channel,
        now: clock ?? () => DateTime(2026, 9, 23, 12),
      );

  test('the feature is OFF until somebody asks for it', () {
    // An app that makes a noise nobody chose is a bad guest, and a swarm is many agents.
    expect(AlertSoundStore(storage: _Memory()).value, isFalse);
  });

  test('each kind has its own sound, and the urgent one is not the finished one', () {
    expect(AlertKind.done.sound, isNotEmpty);
    expect(AlertKind.needsYou.sound, isNotEmpty);
    expect(AlertKind.done.sound, isNot(AlertKind.needsYou.sound));
  });

  /// A store with the feature switched on — what every playback test needs now that the default
  /// is silence.
  Future<AlertSoundStore> switchedOn() async {
    final store = AlertSoundStore(storage: _Memory());
    await store.set(true);
    return store;
  }

  test('plays for a finished agent and for one that is waiting on a person', () async {
    final store = await switchedOn();
    final player = sounds(store);
    player.play(AlertKind.done);
    player.play(AlertKind.needsYou);
    await Future<void>.delayed(Duration.zero);
    expect(played, [AlertKind.done.sound, AlertKind.needsYou.sound]);
  });

  test('says nothing at all while the switch is off', () async {
    final store = AlertSoundStore(storage: _Memory());
    expect(store.value, isFalse, reason: 'off is the default, not a state a test has to set');
    final player = sounds(store);
    player.play(AlertKind.done);
    player.play(AlertKind.needsYou);
    await Future<void>.delayed(Duration.zero);
    expect(played, isEmpty);
  });

  test('a batch of agents finishing together is ONE sound, not a burst', () async {
    // A swarm finishing together is the ordinary case. Ten beeps say nothing that one does not.
    var at = DateTime(2026, 9, 23, 12);
    final player = sounds(await switchedOn(), clock: () => at);
    for (var i = 0; i < 10; i++) {
      at = at.add(const Duration(milliseconds: 40));
      player.play(AlertKind.done);
    }
    await Future<void>.delayed(Duration.zero);
    expect(played, hasLength(1));
  });

  test('the rate limit is per KIND, so a stuck agent is never swallowed by a busy one', () async {
    var at = DateTime(2026, 9, 23, 12);
    final player = sounds(await switchedOn(), clock: () => at);
    player.play(AlertKind.done);
    at = at.add(const Duration(milliseconds: 40));
    // "Somebody is waiting on you" is the more urgent of the two and must not be eaten by the
    // quieter one that just played.
    player.play(AlertKind.needsYou);
    await Future<void>.delayed(Duration.zero);
    expect(played, [AlertKind.done.sound, AlertKind.needsYou.sound]);
  });

  test('the same kind is heard again once the gap has passed', () async {
    var at = DateTime(2026, 9, 23, 12);
    final player = sounds(await switchedOn(), clock: () => at);
    player.play(AlertKind.done);
    at = at.add(const Duration(seconds: 5));
    player.play(AlertKind.done);
    await Future<void>.delayed(Duration.zero);
    expect(played, hasLength(2));
  });

  test('the choice survives a restart, and only a real "on" unmutes the app', () async {
    final memory = _Memory();
    final store = AlertSoundStore(storage: memory);
    await store.set(true);
    final reopened = AlertSoundStore(storage: memory);
    await reopened.load();
    expect(reopened.value, isTrue);

    // A truncated or hand-edited value lands on the default rather than starting to make noises.
    memory.values['app_alert_sounds'] = 'o';
    final garbled = AlertSoundStore(storage: memory);
    await garbled.load();
    expect(garbled.value, isFalse);
  });

  test('a platform that cannot make a noise does not break the frame that asked', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          throw PlatformException(code: 'NO_AUDIO');
        });
    final player = sounds(await switchedOn());
    expect(() => player.play(AlertKind.done), returnsNormally);
    await Future<void>.delayed(Duration.zero);
  });
}
