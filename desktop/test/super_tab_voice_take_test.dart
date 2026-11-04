import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/voice_recorder.dart';
import 'package:harness/super_tabs/voice_take.dart';
import 'package:harness/super_tabs/voice_wav.dart';

import 'support/fake_voice_recorder.dart';

void main() {
  group('a take', () {
    late FakeVoiceRecorder mic;
    late List<({String conversationId, String? root, Uint8List wav})> posted;
    late SuperTabVoicePosted answer;
    late SuperTabVoiceTake take;

    setUp(() {
      mic = FakeVoiceRecorder();
      posted = [];
      answer = (sent: true, notice: null);
      take = SuperTabVoiceTake(
        recorder: () => mic,
        post: (conversationId, root, clip) async {
          posted.add((
            conversationId: conversationId,
            root: root,
            wav: clip.wav,
          ));
          return answer;
        },
      );
    });

    tearDown(() => take.dispose());

    testWidgets('starts recording for its chat and thread', (tester) async {
      take.start(conversationId: 'c1', root: 'r1');
      await tester.pump();
      expect(take.state, SuperTabVoiceState.recording);
      expect(take.conversationId, 'c1');
      expect(take.root, 'r1');
      expect(mic.calls, ['allowed', 'start']);
      take.discard();
    });

    testWidgets('send stops the take and posts its clip once', (tester) async {
      take.start(conversationId: 'c1');
      await tester.pump();
      take.send();
      await tester.pump();
      expect(mic.calls, ['allowed', 'start', 'stop']);
      expect(posted, hasLength(1));
      expect(posted.single.conversationId, 'c1');
      expect(posted.single.root, isNull);
      expect(posted.single.wav, mic.clip.wav);
      expect(take.state, SuperTabVoiceState.off);
      take.send();
      await tester.pump();
      expect(posted, hasLength(1));
    });

    testWidgets('discard cancels the recording and posts nothing', (
      tester,
    ) async {
      take.start(conversationId: 'c1');
      await tester.pump();
      take.discard();
      await tester.pump();
      expect(mic.calls.last, 'cancel');
      expect(posted, isEmpty);
      expect(take.state, SuperTabVoiceState.off);
    });

    testWidgets('a send that fails keeps the take with its notice', (
      tester,
    ) async {
      answer = (sent: false, notice: 'Voice messages need a newer server');
      take.start(conversationId: 'c1');
      await tester.pump();
      take.send();
      await tester.pump();
      expect(take.state, SuperTabVoiceState.held);
      expect(take.notice, 'Voice messages need a newer server');
      answer = (sent: true, notice: null);
      take.send();
      await tester.pump();
      expect(posted, hasLength(2));
      expect(take.state, SuperTabVoiceState.off);
      expect(take.notice, isNull);
    });

    testWidgets('a refused microphone says so and records nothing', (
      tester,
    ) async {
      mic.allow = false;
      take.start(conversationId: 'c1');
      await tester.pump();
      expect(take.state, SuperTabVoiceState.off);
      expect(take.denied, isTrue);
      expect(mic.calls, ['allowed']);
      expect(posted, isEmpty);
      // Allowed later in the system's settings: the next tap asks again.
      mic.allow = true;
      take.start(conversationId: 'c1');
      await tester.pump();
      expect(take.denied, isFalse);
      expect(take.state, SuperTabVoiceState.recording);
      take.discard();
    });

    testWidgets('a mic that cannot start says so', (tester) async {
      mic.failStart = true;
      take.start(conversationId: 'c1');
      await tester.pump();
      expect(take.state, SuperTabVoiceState.off);
      expect(take.notice, SuperTabVoiceTake.couldNotStart);
    });

    testWidgets('stops at ten minutes and waits with Send ready', (
      tester,
    ) async {
      take.start(conversationId: 'c1');
      await tester.pump();
      await tester.pump(SuperTabVoiceTake.maxTake);
      await tester.pump();
      expect(take.state, SuperTabVoiceState.held);
      expect(take.canSend, isTrue);
      expect(mic.calls.last, 'stop');
      expect(posted, isEmpty);
    });

    testWidgets('hold stops the take and keeps it for its chat', (
      tester,
    ) async {
      take.start(conversationId: 'c1', root: 'r1');
      await tester.pump();
      take.hold();
      await tester.pump();
      expect(take.state, SuperTabVoiceState.held);
      expect(take.conversationId, 'c1');
      expect(take.length, mic.clip.length);
      expect(posted, isEmpty);
      take.send();
      await tester.pump();
      expect(posted.single.root, 'r1');
    });

    testWidgets('nothing recorded says so and keeps nothing', (tester) async {
      mic.empty = true;
      take.start(conversationId: 'c1');
      await tester.pump();
      take.send();
      await tester.pump();
      expect(posted, isEmpty);
      expect(take.state, SuperTabVoiceState.off);
      expect(take.notice, SuperTabVoiceTake.nothingRecorded);
    });
  });

  test('a recorder only where recording works: macOS, Windows and the web', () {
    expect(
      superTabVoiceRecorder(web: false, platform: TargetPlatform.macOS),
      isNotNull,
    );
    expect(
      superTabVoiceRecorder(web: true, platform: TargetPlatform.linux),
      isNotNull,
    );
    expect(
      superTabVoiceRecorder(web: false, platform: TargetPlatform.linux),
      isNull,
    );
    expect(
      superTabVoiceRecorder(web: false, platform: TargetPlatform.windows),
      isNotNull,
    );
  });

  test('a clip is PCM16 in a WAV header stating its rate and length', () {
    final pcm = Uint8List.fromList(List.filled(3200, 1));
    final wav = wavFromPcm16(pcm, sampleRate: 16000, channels: 1);
    final data = ByteData.sublistView(wav);
    expect(wav.length, 44 + 3200);
    expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
    expect(String.fromCharCodes(wav.sublist(8, 12)), 'WAVE');
    expect(data.getUint32(24, Endian.little), 16000);
    expect(data.getUint16(22, Endian.little), 1);
    expect(data.getUint32(40, Endian.little), 3200);
  });
}
