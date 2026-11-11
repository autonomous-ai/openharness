import 'dart:async';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_notice.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/swarm/swarm_voice.dart';

import '../voice_fakes.dart';

/// The chat's mic records a voice message (task #2584): a take is sent as
/// audio, never as words in the box.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeVoiceRecorder mic;
  late List<VoiceTake> posted;
  String? refusal;

  SwarmVoice voice() {
    mic = FakeVoiceRecorder();
    posted = [];
    refusal = null;
    return SwarmVoice(
      recorder: () => mic,
      post: (take) async {
        posted.add(take);
        return (sent: refusal == null, notice: refusal);
      },
    );
  }

  void lifecycle(AppLifecycleState state) =>
      TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(state);

  tearDown(() => lifecycle(AppLifecycleState.resumed));

  test('a tap records, and Send posts the take as audio', () {
    fakeAsync((async) {
      final v = voice()..tap();
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.recording);
      expect(mic.recording, isTrue);
      v.send();
      async.flushMicrotasks();
      expect(posted.single.wav, Uint8List.fromList([1, 2, 3, 4]));
      expect(v.state, SwarmVoiceState.off);
    });
  });

  test('X throws the take away and sends nothing', () {
    fakeAsync((async) {
      final v = voice()..tap();
      async.flushMicrotasks();
      v.discard();
      async.flushMicrotasks();
      expect(mic.cancels, 1);
      expect(v.state, SwarmVoiceState.off);
      expect(posted, isEmpty);
    });
  });

  test('a take stops at 10:00 with Send ready, and sends nothing itself', () {
    fakeAsync((async) {
      expect(SwarmVoice.maxTake, const Duration(minutes: 10));
      final v = voice()..tap();
      async.flushMicrotasks();
      async.elapse(const Duration(minutes: 9, seconds: 59));
      expect(v.state, SwarmVoiceState.recording);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.held);
      expect(mic.stops, 1);
      expect(v.canSend, isTrue);
      expect(posted, isEmpty);
      v.send();
      async.flushMicrotasks();
      expect(posted, hasLength(1));
    });
  });

  test('leaving the chat or locking the phone stops the take and keeps it', () {
    fakeAsync((async) {
      final v = voice()..tap();
      async.flushMicrotasks();
      v.hide();
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.held);
      expect(mic.cancels, 0);
      expect(v.canSend, isTrue);

      final locked = voice()..tap();
      async.flushMicrotasks();
      // A system prompt or Control Center only covers the app: the take goes on.
      lifecycle(AppLifecycleState.inactive);
      async.flushMicrotasks();
      expect(locked.state, SwarmVoiceState.recording);
      lifecycle(AppLifecycleState.hidden);
      async.flushMicrotasks();
      expect(locked.state, SwarmVoiceState.held);
      expect(posted, isEmpty);
    });
  });

  test('a second tap stops the take and holds it', () {
    fakeAsync((async) {
      final v = voice()..tap();
      async.flushMicrotasks();
      v.tap();
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.held);
      expect(v.length, const Duration(seconds: 2));
    });
  });

  test('a refused microphone says so and records nothing', () {
    fakeAsync((async) {
      final v = voice();
      mic.permitted = false;
      v.tap();
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.off);
      expect(v.off, isTrue);
      expect(v.notice, VoiceNotice.unavailable);
      expect(mic.starts, 0);
    });
  });

  test('a send that throws keeps the take, Send and X ready', () {
    fakeAsync((async) {
      final v = SwarmVoice(
        recorder: FakeVoiceRecorder.new,
        post: (_) => Future.error(TimeoutException('no answer')),
      )..tap();
      async.flushMicrotasks();
      v.send();
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.held);
      expect(v.canSend, isTrue);
      expect(v.notice, SwarmVoice.notSent);
      v.discard();
      expect(v.state, SwarmVoiceState.off);
    });
  });

  test('a sent take can still have something to say', () {
    fakeAsync((async) {
      final v = SwarmVoice(
        recorder: FakeVoiceRecorder.new,
        post: (_) async => (sent: true, notice: 'Sent without words'),
      )..tap();
      async.flushMicrotasks();
      v.send();
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.off);
      expect(v.notice, 'Sent without words');
    });
  });

  test('a send that fails keeps the take, with what went wrong', () {
    fakeAsync((async) {
      final v = voice()..tap();
      async.flushMicrotasks();
      refusal = 'Voice messages need a newer server';
      v.send();
      async.flushMicrotasks();
      expect(v.state, SwarmVoiceState.held);
      expect(v.notice, 'Voice messages need a newer server');
      expect(v.canSend, isTrue);
    });
  });
}
