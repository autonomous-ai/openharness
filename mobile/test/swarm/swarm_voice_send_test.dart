import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
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

  for (final inThread in [false, true]) {
    final where = inThread ? 'thread' : 'chat';
    test(
      '$where sends attached image and file with the clip in one post',
      () async {
        final r = rig();
        final c = await open(r.reader);
        final thread = SwarmThread(c, 'root-1');
        addTearDown(thread.dispose);
        final files = inThread ? thread.files : c.files;
        files.add([
          SwarmOutgoingFile('picture.png', Uint8List.fromList([1, 2])),
          SwarmOutgoingFile('notes.txt', Uint8List.fromList([3])),
        ]);
        c.draft = 'keep typing';
        thread.draft = 'keep replying';
        final sent = inThread
            ? await thread.sendVoice(take, 'en')
            : await c.sendVoice(take, 'en');
        expect(sent.sent, isTrue);
        expect(r.swarm.commands.single['attachmentIds'], [
          'id-picture.png',
          'id-notes.txt',
          'id-Voice message.wav',
        ]);
        expect(r.swarm.commands.single['replyTo'], inThread ? 'root-1' : null);
        expect(files.files, isEmpty);
        expect(c.draft, 'keep typing');
        expect(thread.draft, 'keep replying');
      },
    );

    test('$where keeps attachments when their upload fails', () async {
      final r = rig();
      final c = await open(r.reader);
      final thread = SwarmThread(c, 'root-1');
      addTearDown(thread.dispose);
      final files = inThread ? thread.files : c.files;
      final image = SwarmOutgoingFile('picture.png', Uint8List.fromList([1]));
      files.add([image]);
      r.uploads.refuse['picture.png'] = const SuperTabFailure(
        'UPLOAD_FAILED',
        'Try again',
      );
      final sent = inThread
          ? await thread.sendVoice(take, 'en')
          : await c.sendVoice(take, 'en');
      expect(sent.sent, isFalse);
      expect(r.swarm.commands, isEmpty);
      expect(files.files, [image]);
    });

    test(
      '$where restores attached files after a refused combined post',
      () async {
        final r = rig();
        final c = await open(r.reader);
        final thread = SwarmThread(c, 'root-1');
        addTearDown(thread.dispose);
        final files = inThread ? thread.files : c.files;
        final image = SwarmOutgoingFile('picture.png', Uint8List.fromList([1]));
        final later = SwarmOutgoingFile('later.txt', Uint8List.fromList([2]));
        files.add([image]);
        r.swarm.routes[commands] = (_) {
          files.add([later]);
          throw const SuperTabFailure('INVALID', 'Try again', statusCode: 400);
        };
        final sent = inThread
            ? await thread.sendVoice(take, 'en')
            : await c.sendVoice(take, 'en');
        expect(sent.sent, isFalse);
        expect(files.files, [image, later]);
      },
    );

    test('$where keeps attachments when voice reading fails', () async {
      final r = rig();
      final c = await open(r.reader);
      final thread = SwarmThread(c, 'root-1');
      addTearDown(thread.dispose);
      final files = inThread ? thread.files : c.files;
      final image = SwarmOutgoingFile('picture.png', Uint8List.fromList([1]));
      files.add([image]);
      r.swarm.routes['/api/super-tabs/$tab/attachments/'] = (_) =>
          throw TimeoutException('offline');
      final sent = inThread
          ? await thread.sendVoice(take, 'en')
          : await c.sendVoice(take, 'en');
      expect(sent.sent, isFalse);
      expect(r.swarm.commands, isEmpty);
      expect(files.files, [image]);
    });

    test(
      '$where leaves files added while the clip is read for next time',
      () async {
        final r = rig();
        final c = await open(r.reader);
        final thread = SwarmThread(c, 'root-1');
        addTearDown(thread.dispose);
        final files = inThread ? thread.files : c.files;
        files.add([
          SwarmOutgoingFile('picture.png', Uint8List.fromList([1])),
        ]);
        final later = SwarmOutgoingFile('later.txt', Uint8List.fromList([2]));
        r.swarm.routes['/api/super-tabs/$tab/attachments/'] = (_) {
          files.add([later]);
          return facts();
        };
        final sent = inThread
            ? await thread.sendVoice(take, 'en')
            : await c.sendVoice(take, 'en');
        expect(sent.sent, isTrue);
        expect(files.files, [later]);
        expect(r.swarm.commands.single['attachmentIds'], [
          'id-picture.png',
          'id-Voice message.wav',
        ]);
      },
    );

    test('$where counts the clip toward the ten-file limit', () async {
      final r = rig();
      final c = await open(r.reader);
      final thread = SwarmThread(c, 'root-1');
      addTearDown(thread.dispose);
      final files = inThread ? thread.files : c.files;
      files.add([
        for (var i = 0; i < 10; i++)
          SwarmOutgoingFile('$i.txt', Uint8List.fromList([1])),
      ]);
      final sent = inThread
          ? await thread.sendVoice(take, 'en')
          : await c.sendVoice(take, 'en');
      expect(sent.sent, isFalse);
      expect(sent.notice, isNotEmpty);
      expect(r.uploads.asked, isEmpty);
      expect(r.swarm.commands, isEmpty);
      expect(files.files, hasLength(10));
    });
  }

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

  // A voice message plays only and never has words (anh Dee, 11-04), so
  // one sent without them says nothing about words (River, 11-05).
  for (final failure in [null, 'limit']) {
    test(
      'sent without words (${failure ?? 'not heard'}), it says nothing',
      () async {
        final r = rig();
        r.swarm.routes['/api/super-tabs/$tab/attachments/'] = (_) =>
            facts(transcribed: false, failure: failure);
        final c = await open(r.reader);
        expect(await c.sendVoice(take, 'en'), (sent: true, notice: null));
        expect(r.swarm.commands, hasLength(1));
      },
    );
  }

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
