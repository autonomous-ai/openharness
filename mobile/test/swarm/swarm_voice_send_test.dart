import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_thread.dart';
import 'package:harness_mobile/swarm/swarm_voice_send.dart';

import 'swarm_fixture.dart';

/// A take goes up as a voice message (task #2584): the WAV is uploaded, the
/// backend reads it once, and the message carries that file alone.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';
  const voicePath =
      '/api/super-tabs/$tab/attachments/id-Voice message.wav/voice';
  final VoiceTake take = (
    wav: Uint8List.fromList([1, 2, 3, 4]),
    length: const Duration(seconds: 81),
    peak: 9000,
  );
  Map<String, dynamic> facts({bool transcribed = true, String? failure}) => {
    'voice': {
      'durationMs': 81000,
      'waveform': List.filled(48, 9),
      'transcribed': transcribed,
      'failure': ?failure,
    },
  };

  setUp(() => swarmVoiceRetry = Duration.zero);

  ({FakeSwarm swarm, SwarmReader reader, FakeUploads uploads}) rig() {
    final swarm = FakeSwarm();
    final uploads = FakeUploads();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            agentIds: const ['agent-lead'],
            lastMessageSequence: 0,
          ),
        ],
      ),
      'members': [part(me, 1, person(me))],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    swarm.routes[commands] = (_) => {'result': <String, dynamic>{}};
    swarm.routes['/api/super-tabs/$tab/attachments/'] = (_) => facts();
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
      upload: uploads.upload,
    );
    addTearDown(reader.dispose);
    return (swarm: swarm, reader: reader, uploads: uploads);
  }

  Future<SwarmConversation> open(SwarmReader reader) async {
    await reader.refresh();
    final c = SwarmConversation(reader, 'g1');
    addTearDown(c.dispose);
    await c.load();
    return c;
  }

  test('a take is uploaded as audio, read once, and sent alone', () async {
    final r = rig();
    final c = await open(r.reader);
    c.draft = 'typed before';

    expect(await c.sendVoice(take, 'vi'), (sent: true, notice: null));

    expect(r.uploads.asked.single.name, swarmVoiceFileName);
    expect(r.uploads.asked.single.mime, 'audio/wav');
    expect(r.uploads.asked.single.bytes, [1, 2, 3, 4]);
    expect(r.swarm.paths.where((p) => p.contains('/voice')), [
      '$voicePath?lang=vi',
    ]);
    expect(r.swarm.commands.single, {
      'type': 'message.send',
      'conversationId': 'g1',
      'text': '',
      'replyTo': null,
      'recipientIds': <String>[],
      'attachmentIds': ['id-Voice message.wav'],
    });
    // What was typed stays in the box.
    expect(c.draft, 'typed before');
  });

  test('waits while the backend still transcribes it', () async {
    final r = rig();
    var asks = 0;
    r.swarm.routes['/api/super-tabs/$tab/attachments/'] = (_) {
      if (++asks < 3) {
        throw const SuperTabFailure(
          'VOICE_TRANSCRIBING',
          'Still transcribing',
          statusCode: 409,
        );
      }
      return facts();
    };
    final c = await open(r.reader);
    expect((await c.sendVoice(take, 'en')).sent, isTrue);
    expect(asks, 3);
    expect(r.swarm.commands, hasLength(1));
  });

  test('says when it went without words past the daily limit', () async {
    final r = rig();
    r.swarm.routes['/api/super-tabs/$tab/attachments/'] = (_) =>
        facts(transcribed: false, failure: 'limit');
    final c = await open(r.reader);
    expect(await c.sendVoice(take, 'en'), (
      sent: true,
      notice: swarmVoiceOverLimit,
    ));
    expect(r.swarm.commands, hasLength(1));
  });

  test(
    'keeps the take and sends nothing when the read gets no answer',
    () async {
      final r = rig();
      r.swarm.routes['/api/super-tabs/$tab/attachments/'] = (_) =>
          throw TimeoutException('forwarding timed out');
      final c = await open(r.reader);
      expect(await c.sendVoice(take, 'en'), (
        sent: false,
        notice: swarmVoiceNoAnswer,
      ));
      expect(r.swarm.commands, isEmpty);
    },
  );

  test('keeps the take and sends nothing on a server without voice', () async {
    final r = rig();
    r.swarm.routes.remove('/api/super-tabs/$tab/attachments/');
    final c = await open(r.reader);
    expect(await c.sendVoice(take, 'en'), (
      sent: false,
      notice: swarmVoiceNeedsServer,
    ));
    expect(r.swarm.commands, isEmpty);
  });

  test('a thread sends a take as a reply to its root', () async {
    final r = rig();
    final c = await open(r.reader);
    final thread = SwarmThread(c, 'root-1');
    addTearDown(thread.dispose);
    expect((await thread.sendVoice(take, 'en')).sent, isTrue);
    expect(r.swarm.commands.single, containsPair('replyTo', 'root-1'));
    expect(
      r.swarm.commands.single,
      containsPair('attachmentIds', ['id-Voice message.wav']),
    );
  });
}
