// Sending a take from the Desktop and web composer's mic (#2665) through
// #2887's path, as the phone's sendVoice does: the clip goes up as an
// ordinary file, the server reads it once as a voice message, and the send
// names that file with no text (its words become the text on the server).
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/voice_send.dart';

import 'support/voice_server.dart';

final _wav = Uint8List.fromList(List.filled(44 + 3200, 1));

void main() {
  late VoiceServer server;
  late SuperTabController c;

  setUp(() async {
    server = VoiceServer()..append('Hello');
    c = server.controller();
    await c.refresh();
  });

  tearDown(() async {
    await c.flush();
    c.dispose();
  });

  Map<String, dynamic>? sent() => server.lastSend();

  test(
    'a take goes up as a voice file, is read once, and is sent alone',
    () async {
      final posted = await c.sendVoice(
        conversationId: 'lead',
        root: null,
        wav: _wav,
        lang: 'vi',
      );
      expect(posted.sent, isTrue);
      expect(posted.notice, isNull);
      expect(server.uploads.single['name'], 'Voice message.wav');
      expect(server.uploads.single['file'], _wav);
      final id = server.uploads.single['id'];
      expect(server.voiceReads, [
        '/api/super-tabs/tab/attachments/$id/voice?lang=vi',
      ]);
      final send = sent()!;
      expect(send['conversationId'], 'lead');
      expect(send['text'], '');
      expect(send['attachmentIds'], [id]);
      expect(send['replyTo'], isNull);
    },
  );

  for (final root in <String?>[null, 'message-1']) {
    final where = root == null ? 'chat' : 'thread';
    HarnessAttachments files() => root == null
        ? c.attachments('lead')
        : c.threadAttachments('lead', root);

    test('$where sends image, document and clip in one ordered post', () async {
      files().add([
        HarnessAttachment('picture.png', Uint8List.fromList([1])),
        HarnessAttachment('notes.txt', Uint8List.fromList([2])),
      ]);
      final other = root == null
          ? c.threadAttachments('lead', 'other')
          : c.attachments('lead');
      other.add([
        HarnessAttachment('other.txt', Uint8List.fromList([3])),
      ]);
      final posted = await c.sendVoice(
        conversationId: 'lead',
        root: root,
        wav: _wav,
        lang: 'en',
      );
      expect(posted.sent, isTrue);
      expect(server.uploads.map((u) => u['name']), [
        'picture.png',
        'notes.txt',
        'Voice message.wav',
      ]);
      expect(sent()!['attachmentIds'], [
        'attachment-1',
        'attachment-2',
        'attachment-3',
      ]);
      expect(sent()!['replyTo'], root);
      expect(
        server.posts.where(
          (p) => (p['command'] as Map)['type'] == 'message.send',
        ),
        hasLength(1),
      );
      expect(files().files, isEmpty);
      expect(other.files.single.name, 'other.txt');
    });

    test('$where keeps image when its upload fails', () async {
      final image = HarnessAttachment('picture.png', Uint8List.fromList([1]));
      files().add([image]);
      server.failUpload = 'picture.png';
      final posted = await c.sendVoice(
        conversationId: 'lead',
        root: root,
        wav: _wav,
        lang: 'en',
      );
      expect(posted.sent, isFalse);
      expect(posted.notice, 'The file is too large.');
      expect(files().files, [image]);
      expect(sent(), isNull);
    });

    test('$where keeps image when voice reading fails', () async {
      final image = HarnessAttachment('picture.png', Uint8List.fromList([1]));
      files().add([image]);
      server.voiceAnswers = [
        const SuperTabFailure('NOT_FOUND', 'Not found.', statusCode: 404),
      ];
      final posted = await c.sendVoice(
        conversationId: 'lead',
        root: root,
        wav: _wav,
        lang: 'en',
      );
      expect(posted.sent, isFalse);
      expect(files().files, [image]);
      expect(sent(), isNull);
    });

    test(
      '$where leaves files added during voice reading for next time',
      () async {
        files().add([
          HarnessAttachment('picture.png', Uint8List.fromList([1])),
        ]);
        final later = HarnessAttachment('later.txt', Uint8List.fromList([2]));
        server.onVoiceRead = () => files().add([later]);
        final posted = await c.sendVoice(
          conversationId: 'lead',
          root: root,
          wav: _wav,
          lang: 'en',
        );
        expect(posted.sent, isTrue);
        expect(sent()!['attachmentIds'], ['attachment-1', 'attachment-2']);
        expect(files().files, [later]);
      },
    );

    test('$where counts clip toward ten-file limit before uploading', () async {
      files().add([
        for (var i = 0; i < 10; i++)
          HarnessAttachment('$i.txt', Uint8List.fromList([1])),
      ]);
      final posted = await c.sendVoice(
        conversationId: 'lead',
        root: root,
        wav: _wav,
        lang: 'en',
      );
      expect(posted.sent, isFalse);
      expect(posted.notice, isNotEmpty);
      expect(server.uploads, isEmpty);
      expect(sent(), isNull);
      expect(files().files, hasLength(10));
    });
  }

  test("a thread's take is a reply to its root", () async {
    await c.sendVoice(
      conversationId: 'lead',
      root: 'message-1',
      wav: _wav,
      lang: 'en',
    );
    expect(sent()!['replyTo'], 'message-1');
  });

  test('a clip still being read is asked about again', () async {
    server.voiceAnswers = [
      const SuperTabFailure(
        'VOICE_TRANSCRIBING',
        'Still reading.',
        statusCode: 409,
      ),
      ...server.voiceAnswers,
    ];
    superTabVoiceRetry = Duration.zero;
    final posted = await c.sendVoice(
      conversationId: 'lead',
      root: null,
      wav: _wav,
      lang: 'en',
    );
    expect(posted.sent, isTrue);
    expect(server.voiceReads, hasLength(2));
  });

  test('a server from before voice messages keeps the take', () async {
    server.voiceAnswers = [
      const SuperTabFailure('NOT_FOUND', 'Not found.', statusCode: 404),
    ];
    final posted = await c.sendVoice(
      conversationId: 'lead',
      root: null,
      wav: _wav,
      lang: 'en',
    );
    expect(posted.sent, isFalse);
    expect(posted.notice, superTabVoiceNeedsServer);
    expect(sent(), isNull);
  });

  test('over the daily voice limit it sends and says so', () async {
    server.voiceAnswers = [
      {
        'voice': {
          'durationMs': 1000,
          'waveform': List.filled(48, 3),
          'transcribed': false,
          'failure': 'limit',
        },
      },
    ];
    final posted = await c.sendVoice(
      conversationId: 'lead',
      root: null,
      wav: _wav,
      lang: 'en',
    );
    expect(posted.sent, isTrue);
    expect(posted.notice, superTabVoiceOverLimit);
    expect(sent(), isNotNull);
  });

  test('a refused upload keeps the take and says why', () async {
    server.failUpload = 'Voice message.wav';
    final posted = await c.sendVoice(
      conversationId: 'lead',
      root: null,
      wav: _wav,
      lang: 'en',
    );
    expect(posted.sent, isFalse);
    expect(posted.notice, 'The file is too large.');
    expect(server.voiceReads, isEmpty);
    expect(sent(), isNull);
  });
}
