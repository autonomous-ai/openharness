import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';

  SwarmOutgoingFile file(String name, [int size = 3]) =>
      SwarmOutgoingFile(name, Uint8List.fromList(List.filled(size, 7)));

  ({FakeSwarm swarm, SwarmReader reader, FakeUploads uploads}) rig({
    String role = 'owner',
    bool uploads = true,
  }) {
    final swarm = FakeSwarm();
    final fake = FakeUploads();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            agentIds: const ['agent-lead', 'agent-builder'],
            lastMessageSequence: 0,
          ),
        ],
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
    swarm.routes[commands] = (_) => {'result': <String, dynamic>{}};
    final reader = uploads
        ? SwarmReader(
            tabId: tab,
            accountId: me,
            request: swarm.request,
            upload: fake.upload,
          )
        : SwarmReader(tabId: tab, accountId: me, request: swarm.request);
    addTearDown(reader.dispose);
    return (swarm: swarm, reader: reader, uploads: fake);
  }

  Future<SwarmConversation> open(
    SwarmReader reader, {
    Duration uploadTimeout = const Duration(minutes: 2),
  }) async {
    await reader.refresh();
    final c = SwarmConversation(reader, 'g1', uploadTimeout: uploadTimeout);
    addTearDown(c.dispose);
    await c.load();
    return c;
  }

  test('each file goes up once, in order, then the post names them', () async {
    final r = rig();
    final c = await open(r.reader);
    c.draft = 'Here are the shots';
    c.files.add([file('a.jpg'), file('b.pdf', 5)]);

    expect(await c.send(), isTrue);

    expect(r.uploads.names, ['a.jpg', 'b.pdf']);
    final first = r.uploads.asked.first;
    expect(first.tabId, tab);
    expect(first.conversationId, 'g1');
    expect(first.mime, 'image/jpeg');
    expect(first.bytes, [7, 7, 7]);
    expect(r.uploads.asked.last.mime, 'application/pdf');
    expect(r.swarm.commands.single, {
      'type': 'message.send',
      'conversationId': 'g1',
      'text': 'Here are the shots',
      'replyTo': null,
      'recipientIds': <String>[],
      'attachmentIds': ['id-a.jpg', 'id-b.pdf'],
    });
  });

  test('a post may be files alone', () async {
    final r = rig();
    final c = await open(r.reader);
    c.files.add([file('a.jpg')]);

    expect(c.canSend, isTrue);
    expect(await c.send(), isTrue);

    expect(r.swarm.commands.single['text'], '');
    expect(r.swarm.commands.single['attachmentIds'], ['id-a.jpg']);
  });

  test('a post without files names none', () async {
    final r = rig();
    final c = await open(r.reader);
    c.draft = 'hi';

    expect(await c.send(), isTrue);

    expect(r.uploads.asked, isEmpty);
    expect(r.swarm.commands.single.containsKey('attachmentIds'), isFalse);
  });

  test('nothing to send without text or files', () async {
    final r = rig();
    final c = await open(r.reader);

    expect(c.canSend, isFalse);
    expect(await c.send(), isFalse);

    expect(r.swarm.commands, isEmpty);
  });

  test('sent files leave the composer, and show with the post until it is '
      'read back', () async {
    final r = rig();
    final taken = Completer<Object?>();
    r.swarm.routes[commands] = (_) => taken.future;
    final c = await open(r.reader);
    c.files.add([file('a.jpg')]);

    final sending = c.send();
    await settle();

    expect(c.files.files, isEmpty);
    expect([for (final f in c.pending!.files) f.name], ['a.jpg']);
    taken.complete({'result': <String, dynamic>{}});
    expect(await sending, isTrue);
    expect(c.pending, isNull);
  });

  test('a failed upload keeps the draft and the files, sends nothing, and '
      'says why', () async {
    final r = rig();
    r.uploads.refuse['b.jpg'] = const SuperTabFailure(
      'ATTACHMENT_TOO_LARGE',
      'That file is over 10 MB.',
      statusCode: 413,
    );
    final c = await open(r.reader);
    c.draft = 'look';
    c.files.add([file('a.jpg'), file('b.jpg')]);

    expect(await c.send(), isFalse);

    expect(c.error, 'That file is over 10 MB.');
    expect(c.draft, 'look');
    expect([for (final f in c.files.files) f.name], ['a.jpg', 'b.jpg']);
    expect(r.swarm.commands, isEmpty);
    expect(c.uploading, isFalse);
    expect(c.pending, isNull);
  });

  test('an upload that fails for any other reason says so plainly', () async {
    final r = rig();
    r.uploads.answersAtOnce = false;
    final c = await open(r.reader);
    c.files.add([file('a.jpg'), file('b.jpg')]);

    final sending = c.send();
    await settle();
    r.uploads.asked.single.answer.completeError(StateError('socket closed'));

    expect(await sending, isFalse);
    expect(c.error, 'Could not upload the files. Try again.');
  });

  test('sending again does not upload a file that already went up', () async {
    final r = rig();
    r.uploads.refuse['b.jpg'] = const SuperTabFailure('UPLOAD_FAILED', 'No.');
    final c = await open(r.reader);
    c.files.add([file('a.jpg'), file('b.jpg')]);
    expect(await c.send(), isFalse);

    r.uploads.refuse.clear();
    expect(await c.send(), isTrue);

    expect(r.uploads.names, ['a.jpg', 'b.jpg', 'b.jpg']);
    expect(r.swarm.commands.single['attachmentIds'], ['id-a.jpg', 'id-b.jpg']);
  });

  test('each file says how much has gone up while it goes', () async {
    final r = rig();
    r.uploads.answersAtOnce = false;
    final c = await open(r.reader);
    c.files.add([file('a.jpg'), file('b.jpg')]);
    final [a, b] = c.files.files;

    final sending = c.send();
    await settle();
    expect(c.uploading, isTrue);
    expect(c.isUploading(a), isTrue);
    r.uploads.asked.single.onProgress(0.5);
    expect(c.uploadProgress(a), 0.5);
    expect(c.uploadProgress(b), isNull);

    r.uploads.asked.single.answer.complete(FakeUploads.attachment('id-a'));
    await settle();
    expect(c.isUploading(a), isFalse, reason: 'it is up');
    expect(c.isUploading(b), isTrue);
    r.uploads.asked.last.answer.complete(FakeUploads.attachment('id-b'));

    expect(await sending, isTrue);
    expect(c.uploading, isFalse);
    expect(c.uploadProgress(b), isNull);
  });

  test('taking a file off while it goes up gives the upload up and frees '
      'the composer, with the draft and the other files kept', () async {
    final r = rig();
    r.uploads.answersAtOnce = false;
    final c = await open(r.reader);
    c.draft = 'look';
    c.files.add([file('a.jpg'), file('b.jpg')]);

    final sending = c.send();
    await settle();
    final going = r.uploads.asked.single;
    c.files.remove(c.files.files.first);

    expect(await sending, isFalse);
    expect(going.cancel.isCancelled, isTrue);
    expect(c.uploading, isFalse);
    expect(c.error, isNull, reason: 'the person did it');
    expect(c.draft, 'look');
    expect([for (final f in c.files.files) f.name], ['b.jpg']);
    expect(r.swarm.commands, isEmpty);
  });

  test('an upload that stops moving gives up and says so', () async {
    final r = rig();
    r.uploads.answersAtOnce = false;
    final c = await open(
      r.reader,
      uploadTimeout: const Duration(milliseconds: 20),
    );
    c.files.add([file('a.jpg')]);

    final sending = c.send();
    await settle();
    final going = r.uploads.asked.single;
    // A transport that honours its token ends when it is cancelled.
    unawaited(
      going.cancel.whenCancel.then(
        (e) => going.answer.isCompleted ? null : going.answer.completeError(e),
      ),
    );

    expect(await sending, isFalse);
    expect(going.cancel.isCancelled, isTrue);
    expect(c.error, 'The upload stopped moving. Try again.');
    expect([for (final f in c.files.files) f.name], ['a.jpg']);
  });

  test('a post refused for its files puts them back, to go up again', () async {
    final r = rig();
    var refuse = true;
    r.swarm.routes[commands] = (_) => refuse
        ? throw const SuperTabFailure(
            'ATTACHMENT_NOT_FOUND',
            'A file of this message is gone. Attach it again.',
            statusCode: 400,
          )
        : {'result': <String, dynamic>{}};
    final c = await open(r.reader);
    c.draft = 'look';
    c.files.add([file('a.jpg')]);

    expect(await c.send(), isFalse);
    expect(c.error, 'A file of this message is gone. Attach it again.');
    expect(c.draft, 'look');
    expect([for (final f in c.files.files) f.name], ['a.jpg']);

    refuse = false;
    expect(await c.send(), isTrue);
    expect(r.uploads.names, ['a.jpg', 'a.jpg']);
  });

  test('a post refused for something else keeps its files up', () async {
    final r = rig();
    var refuse = true;
    r.swarm.routes[commands] = (_) => refuse
        ? throw const SuperTabFailure(
            'INVALID_RECIPIENT',
            'Choose an agent in this conversation.',
            statusCode: 400,
          )
        : {'result': <String, dynamic>{}};
    final c = await open(r.reader);
    c.files.add([file('a.jpg')]);

    expect(await c.send(), isFalse);
    expect([for (final f in c.files.files) f.name], ['a.jpg']);

    refuse = false;
    expect(await c.send(), isTrue);
    expect(r.uploads.names, ['a.jpg']);
    expect(r.swarm.commands.last['attachmentIds'], ['id-a.jpg']);
  });

  test(
    'a post whose answer was lost is sent again with the same files',
    () async {
      final r = rig();
      var lost = true;
      r.swarm.routes[commands] = (_) => lost
          ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
          : {'result': <String, dynamic>{}};
      final c = await open(r.reader);
      c.files.add([file('a.jpg')]);

      expect(await c.send(), isFalse);
      expect(c.unconfirmed, isTrue);
      lost = false;
      expect(await c.send(), isTrue);

      expect(r.uploads.names, ['a.jpg']);
      expect(
        [for (final s in r.swarm.commands) s['attachmentIds']],
        [
          ['id-a.jpg'],
          ['id-a.jpg'],
        ],
      );
    },
  );

  test('files added while a post goes stay for the next one', () async {
    final r = rig();
    final taken = Completer<Object?>();
    r.swarm.routes[commands] = (_) => taken.future;
    final c = await open(r.reader);
    c.files.add([file('a.jpg')]);

    final sending = c.send();
    await settle();
    c.files.add([file('later.jpg')]);
    taken.complete({'result': <String, dynamic>{}});
    await sending;

    expect([for (final f in c.files.files) f.name], ['later.jpg']);
  });

  test('a phone that cannot upload says files cannot be sent', () async {
    final r = rig(uploads: false);
    final c = await open(r.reader);
    c.files.add([file('a.jpg')]);

    expect(await c.send(), isFalse);

    expect(c.error, 'Files can’t be sent from here.');
    expect(r.swarm.commands, isEmpty);
  });

  test('a viewer uploads nothing', () async {
    final r = rig(role: 'viewer');
    final c = await open(r.reader);
    c.files.add([file('a.jpg')]);

    expect(c.canSend, isFalse);
    expect(await c.send(), isFalse);

    expect(r.uploads.asked, isEmpty);
  });

  test('closing the chat lets its files go', () async {
    final r = rig();
    await r.reader.refresh();
    final c = SwarmConversation(r.reader, 'g1');
    await c.load();
    c.files.add([file('a.jpg')]);
    final files = c.files;

    c.dispose();

    expect(files.files, isEmpty);
  });
}
