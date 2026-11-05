// Sending a take from the Desktop and web composer's mic (#2665) through
// #2887's path, as the phone's sendVoice does: the clip goes up as an
// ordinary file, the server reads it once as a voice message, and the send
// names that file with no text (its words become the text on the server).
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
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

  // A voice message plays only and never has words (anh Dee, 11-04), so
  // one sent without them says nothing about words (River, 11-05).
  for (final failure in [null, 'limit']) {
    test(
      'sent without words (${failure ?? 'not heard'}), it says nothing',
      () async {
        server.voiceAnswers = [
          {
            'voice': {
              'durationMs': 1000,
              'waveform': List.filled(48, 3),
              'transcribed': false,
              'failure': ?failure,
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
        expect(posted.notice, isNull);
        expect(sent(), isNotNull);
      },
    );
  }

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
