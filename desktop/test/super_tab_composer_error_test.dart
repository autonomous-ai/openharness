// A composer's upload error belongs to its conversation, and a refused upload
// says why.
import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart' show RequestOptions, Response;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';

final _png = Uint8List.fromList([1, 2, 3]);

void main() {
  group('the composer error is per conversation', () {
    late ConversationServer server;
    late SuperTabController c;

    setUp(() async {
      server = ConversationServer();
      c = server.controller();
      await c.refresh();
    });
    tearDown(() => c.dispose());

    test('refused in one conversation, it shows only there', () async {
      server.failUpload = 'a.png';
      c.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      await c.send();
      expect(c.composerError('lead'), 'The file is too large.');

      await c.select('offline');
      expect(c.composerError('offline'), isNull);

      await c.select('lead');
      expect(c.composerError('lead'), 'The file is too large.');
    });

    test('each conversation keeps its own', () async {
      server.failUpload = 'a.png';
      c.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      await c.send();
      await c.select('offline');
      server.failUploadCode = 'OTHER';
      c.attachments('offline').add([HarnessAttachment('a.png', _png)]);
      await c.send();

      expect(c.composerError('offline'), 'The file is too large.');
      expect(c.composerError('lead'), 'The file is too large.');
      // Another conversation's upload starting clears only its own.
      server.failUpload = null;
      await c.send();
      expect(c.composerError('offline'), isNull);
      expect(c.composerError('lead'), 'The file is too large.');
    });

    test('an upload still running at a switch fails into its own '
        'conversation, not the one now shown', () async {
      final gate = Completer<Map<String, dynamic>>();
      c.dispose();
      c = server.controller(
        upload: ({
          required tabId,
          required conversationId,
          required name,
          required mime,
          required bytes,
          required cancel,
          required onProgress,
        }) => gate.future,
      );
      await c.refresh();
      c.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      final sending = c.send();
      await Future<void>.delayed(Duration.zero);
      expect(c.uploading, isTrue);

      await c.select('offline');
      gate.completeError(
        const SuperTabFailure('FORBIDDEN', 'No files here.', statusCode: 403),
      );
      await sending;

      expect(c.composerError('offline'), isNull);
      await c.select('lead');
      expect(c.composerError('lead'), 'No files here.');
    });
  });

  group('superTabUploadRefusal', () {
    Response<dynamic> answer(int status, Object? body) => Response(
      requestOptions: RequestOptions(),
      statusCode: status,
      data: body,
    );

    test('reads a body Dio left as a String', () {
      final failure = superTabUploadRefusal(
        answer(403, '{"success":false,"error":{"code":"X","message":"M"}}'),
      );
      expect(failure.message, 'M');
      expect(failure.code, 'X');
      expect(failure.statusCode, 403);
    });

    test('names a code it has no words for', () {
      final failure = superTabUploadRefusal(
        answer(403, {'error': 'FORBIDDEN_HOST'}),
      );
      expect(failure.code, 'FORBIDDEN_HOST');
      expect(
        failure.message,
        'Could not upload the file (FORBIDDEN_HOST). Try again.',
      );
    });

    test('a body that says nothing keeps the plain words', () {
      expect(
        superTabUploadRefusal(answer(500, 'oops')).message,
        'Could not upload the file. Try again.',
      );
    });

    test('the codes it knows keep their words', () {
      expect(
        superTabUploadRefusal(answer(403, {'error': 'FORBIDDEN'})).message,
        'You can’t send files in this conversation.',
      );
      expect(
        superTabUploadRefusal(answer(413, {'error': 'ATTACHMENT_TOO_LARGE'}))
            .message,
        'That file is over 10 MB.',
      );
    });
  });
}
