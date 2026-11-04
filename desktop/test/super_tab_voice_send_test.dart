// Sending a take from the Desktop and web composer's mic (#2665) through
// #2887's path, as the phone's sendVoice does: the clip goes up as an
// ordinary file, the server reads it once as a voice message, and the send
// names that file with no text (its words become the text on the server).
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/voice_send.dart';

import 'support/super_tab_fixture.dart';

/// A server with #2887's voice route: [voiceAnswers] are given in turn, the
/// last one again; a [SuperTabFailure] in it is thrown.
class _VoiceServer extends ConversationServer {
  final voiceReads = <String>[];
  List<Object> voiceAnswers = [
    {
      'voice': {
        'durationMs': 1000,
        'waveform': List.filled(48, 3),
        'transcribed': true,
      },
    },
  ];

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (method == 'POST' && path.contains('/voice')) {
      voiceReads.add(path);
      final answer =
          voiceAnswers[(voiceReads.length - 1).clamp(
            0,
            voiceAnswers.length - 1,
          )];
      if (answer is SuperTabFailure) throw answer;
      return answer as Map<String, dynamic>;
    }
    return super.request(method, path, body: body);
  }
}

final _wav = Uint8List.fromList(List.filled(44 + 3200, 1));

void main() {
  late _VoiceServer server;
  late SuperTabController c;

  setUp(() async {
    server = _VoiceServer()..append('Hello');
    c = server.controller();
    await c.refresh();
  });

  tearDown(() async {
    await c.flush();
    c.dispose();
  });

  Map<String, dynamic>? sent() {
    for (final post in server.posts.reversed) {
      final command = post['command'];
      if (command is Map && command['type'] == 'message.send') {
        return Map<String, dynamic>.from(command);
      }
    }
    return null;
  }

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
