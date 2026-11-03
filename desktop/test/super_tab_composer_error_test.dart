// A composer's upload error belongs to its conversation, and a refused upload
// says why.
import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart' show CancelToken, RequestOptions, Response;
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

    Future<void> refuseFile() async {
      server.failUpload = 'a.png';
      c.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      await c.send();
      expect(c.composerError('lead'), 'The file is too large.');
    }

    test('taking the file off clears the refusal', () async {
      await refuseFile();
      c.attachments('lead').clear();
      expect(c.composerError('lead'), isNull);
    });

    test(
      'a text-only send that goes through clears a resolved refusal',
      () async {
        await refuseFile();
        c.attachments('lead').clear();
        c.setDraft('lead', 'Send without the file');
        expect(await c.send(), isNotNull);
        expect(server.posts, isNotEmpty);
        expect(c.composerError('lead'), isNull);
      },
    );

    test('a send blocked afterwards says why, over the old refusal', () async {
      await refuseFile();
      c.attachments('lead').clear();
      c.setDraft('lead', 'Hello');
      await c.send(recipients: ['no-longer-present']);
      expect(c.operationError, contains('mentioned agent'));
      expect(c.composerError('lead'), c.operationError);
    });

    test('a refused send shows only under its own conversation, and the '
        'other keeps its upload error', () async {
      await c.select('offline');
      server.failUpload = 'a.png';
      c.attachments('offline').add([HarnessAttachment('a.png', _png)]);
      await c.send();
      expect(c.composerError('offline'), 'The file is too large.');

      await c.select('lead');
      server.failUpload = null;
      server.reject = true;
      c.setDraft('lead', 'Hello');
      expect(await c.send(), isNull);
      expect(c.hasPendingAction, isFalse);
      expect(c.composerError('lead'), 'Choose an agent in this conversation.');

      await c.select('offline');
      expect(c.composerError('offline'), 'The file is too large.');

      await c.select('lead');
      expect(c.composerError('lead'), 'Choose an agent in this conversation.');
    });

    test(
      'a send forbidden in one conversation is not said in another',
      () async {
        server
          ..refuse = {'code': 'FORBIDDEN', 'message': 'You can’t write here.'}
          ..refuseStatus = 403;
        c.setDraft('lead', 'Hello');
        expect(await c.send(), isNull);
        expect(c.composerError('lead'), 'You can’t write here.');

        server.refuse = null;
        await c.select('offline');
        expect(c.composerError('offline'), isNull);
      },
    );

    test(
      'a mention that is gone says so only in its own conversation',
      () async {
        c.setDraft('lead', 'Hello');
        await c.send(recipients: ['no-longer-present']);
        expect(c.composerError('lead'), contains('mentioned agent'));

        await c.select('offline');
        expect(c.composerError('offline'), isNull);
      },
    );

    test(
      'a send still unconfirmed blocks every composer, so each says why',
      () async {
        server.loseReply = true;
        c.setDraft('lead', 'Hello');
        expect(await c.send(), isNull);
        expect(c.hasPendingAction, isTrue);

        await c.select('offline');
        expect(
          c.composerError('offline'),
          'The action is not confirmed. Retry to check it.',
        );
      },
    );

    test('a refusal outside any conversation still shows where the person '
        'is', () async {
      server.refuse = {'code': 'NOPE', 'message': 'Not allowed.'};
      expect(
        await c.command({'type': 'agent.release', 'agentId': 'a'}),
        isNull,
      );
      expect(c.composerError('lead'), 'Not allowed.');
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
          required file,
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

    test('losing access while a file goes up stops it, and what it brings '
        'later is dropped', () async {
      final gate = Completer<Map<String, dynamic>>();
      CancelToken? token;
      c.dispose();
      c = server.controller(
        upload:
            ({
              required tabId,
              required conversationId,
              required name,
              required mime,
              required file,
              required cancel,
              required onProgress,
            }) {
              token = cancel;
              return gate.future;
            },
      );
      await c.refresh();
      c.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      final sending = c.send();
      await Future<void>.delayed(Duration.zero);
      expect(c.uploading, isTrue);

      c.revokeAccess('You were signed out.');

      expect(token!.isCancelled, isTrue);
      expect(c.uploading, isFalse);
      gate.complete({
        'attachment': {'id': 'late'},
      });
      expect(await sending, isNull);
      expect(server.posts, isEmpty);
    });

    test('closing the Swarm while a file goes up stops it', () async {
      CancelToken? token;
      final closing = server.controller(
        upload:
            ({
              required tabId,
              required conversationId,
              required name,
              required mime,
              required file,
              required cancel,
              required onProgress,
            }) {
              token = cancel;
              return Completer<Map<String, dynamic>>().future;
            },
      );
      await closing.refresh();
      closing.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      unawaited(closing.send());
      await Future<void>.delayed(Duration.zero);
      expect(closing.uploading, isTrue);

      closing.dispose();

      expect(token!.isCancelled, isTrue);
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
        'Files can be up to 256 MB.',
      );
    });
  });
}
