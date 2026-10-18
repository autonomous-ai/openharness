import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

Map<String, dynamic> group(String id, String title) => {
  'id': id,
  'title': title,
  'leadId': null,
  'agentIds': <String>[],
  'archived': false,
  'brief': '',
  'checks': <dynamic>[],
  'assignment': null,
  'lastMessageSequence': 0,
};

class ConversationServer {
  int revision = 0;
  bool loseReply = false, reject = false, failSave = false;
  Map<String, dynamic>? saved;
  final posts = <Map<String, dynamic>>[];
  final receipts = <String, Map<String, dynamic>>{};
  final messages = <Map<String, dynamic>>[];
  final state = <String, dynamic>{
    'version': 1,
    'id': 'tab',
    'name': 'Pilot',
    'ownerId': 'owner',
    'paused': false,
    'people': [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    ],
    'agents': <dynamic>[],
    'invitations': <dynamic>[],
    'conversations': [
      group('lead', 'Lead'),
      group('offline', 'Offline editing'),
    ],
  };
  Future<void> save(Map<String, dynamic> value) async {
    if (failSave) throw StateError('Disk full');
    saved = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
  }

  void append(String text, {String conversationId = 'lead'}) {
    revision++;
    messages.add({
      'id': 'message-$revision',
      'conversationId': conversationId,
      'sequence': revision,
      'text': text,
      'createdAt': '2026-10-18T00:00:00Z',
      'author': {'kind': 'person', 'id': 'owner', 'name': 'owner@example.com'},
      'deliveries': <dynamic>[],
    });
    (state['conversations'] as List).cast<Map<String, dynamic>>().firstWhere(
      (g) => g['id'] == conversationId,
    )['lastMessageSequence'] = revision;
  }

  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (method == 'POST') {
      posts.add(Map<String, dynamic>.from(body!));
      if (reject) {
        throw const SuperTabFailure(
          'INVALID_RECIPIENT',
          'Choose an agent in this conversation.',
          statusCode: 400,
        );
      }
      final operationId = body['operationId'] as String;
      if (receipts[operationId] case final receipt?) return receipt;
      final command = body['command'] as Map;
      if (command['type'] == 'message.send') {
        append(
          command['text'] as String,
          conversationId: command['conversationId'] as String,
        );
      }
      final result = {
        'revision': revision,
        'result': {'messageId': 'message-$revision'},
      };
      receipts[operationId] = result;
      if (loseReply) {
        loseReply = false;
        throw StateError('Connection lost after commit');
      }
      return result;
    }
    final uri = Uri.parse(path);
    if (uri.pathSegments.last == 'messages') {
      final conversationId = uri.pathSegments[4];
      final after = int.tryParse(uri.queryParameters['after'] ?? '');
      final before = int.tryParse(uri.queryParameters['before'] ?? '');
      var rows = messages
          .where(
            (m) =>
                m['conversationId'] == conversationId &&
                (after == null || (m['sequence'] as int) > after) &&
                (before == null || (m['sequence'] as int) < before),
          )
          .toList();
      if (after == null) rows = rows.reversed.toList();
      final page = rows.take(100).toList();
      final next = rows.length > 100 ? page.last['sequence'] : null;
      return {
        'messages': after == null ? page.reversed.toList() : page,
        'next': next,
        'revision': revision,
      };
    }
    return jsonDecode(jsonEncode({'revision': revision, 'state': state}))
        as Map<String, dynamic>;
  }

  SuperTabController controller({
    Map<String, dynamic>? initial,
    String account = 'owner',
  }) => SuperTabController(
    tabId: 'tab',
    accountId: account,
    request: request,
    save: save,
    initial: initial ?? const {},
    pollInterval: Duration.zero,
  );
}

void main() {
  Future<SuperTabController> open(ConversationServer server) async {
    final controller = server.controller();
    addTearDown(() async {
      await controller.flush();
      controller.dispose();
    });
    await controller.refresh();
    return controller;
  }

  test(
    'new groups and incoming activity preserve personal selection and drafts',
    () async {
      final server = ConversationServer();
      final controller = await open(server);
      controller.setDraft('lead', 'Architecture notes');
      controller.select('offline');
      controller.setDraft('offline', 'Keep local changes');
      server.append('Another person answered.');
      (server.state['conversations'] as List).add(
        group('onboarding', 'Onboarding'),
      );
      await controller.refresh();
      expect(controller.selectedId, 'offline');
      expect(controller.draft('offline'), 'Keep local changes');
      expect(controller.draft('lead'), 'Architecture notes');
      expect(
        controller.unread(controller.snapshot!.conversation('lead')!),
        isTrue,
      );
      controller.markRead('lead');
      expect(
        controller.unread(controller.snapshot!.conversation('lead')!),
        isFalse,
      );
    },
  );

  test(
    'a lost send reply reuses its durable receipt after closing and reopening',
    () async {
      final server = ConversationServer()..loseReply = true;
      final first = server.controller();
      await first.refresh();
      first.setDraft('lead', 'Build the agreed plan.');
      expect(await first.send(), isNull);
      expect(server.messages, hasLength(1));
      expect(first.hasPendingAction, isTrue);
      expect(first.draft('lead'), 'Build the agreed plan.');
      await first.flush();
      first.dispose();
      final reopened = server.controller(initial: server.saved);
      addTearDown(() async {
        await reopened.flush();
        reopened.dispose();
      });
      await reopened.refresh();
      await reopened.retry();
      expect(server.posts[0]['operationId'], server.posts[1]['operationId']);
      expect(server.messages, hasLength(1));
      expect(reopened.hasPendingAction, isFalse);
      expect(reopened.draft('lead'), isEmpty);
      expect(server.saved!.containsKey('pending'), isFalse);
    },
  );

  test('typing a new draft during a send does not let the acknowledgement erase it', () async {
    final server = ConversationServer();
    final waiting = Completer<void>();
    final controller = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: server.save,
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (method == 'POST') await waiting.future;
        return server.request(method, path, body: body);
      },
    );
    addTearDown(() async {
      await controller.flush();
      controller.dispose();
    });
    await controller.refresh();
    controller.setDraft('lead', 'First message');
    final sending = controller.send();
    await Future<void>.delayed(Duration.zero);
    controller.setDraft('lead', 'Second message');
    waiting.complete();
    await sending;
    expect(controller.draft('lead'), 'Second message');
    expect(server.messages.single['text'], 'First message');
  });

  test('a failed local receipt save cannot send and a definitive server rejection keeps an editable draft', () async {
    final server = ConversationServer();
    final controller = await open(server);
    controller.setDraft('lead', 'Hold this draft');
    server.failSave = true;
    await controller.send();
    expect(server.posts, isEmpty);
    server.failSave = false;
    server.reject = true;
    await controller.retry();
    expect(controller.hasPendingAction, isFalse);
    expect(controller.draft('lead'), 'Hold this draft');
    server.reject = false;
    await controller.send();
    expect(server.messages, hasLength(1));
  });

  test(
    'reconnecting after more than a page of messages fills the gap in order',
    () async {
      final server = ConversationServer()..append('First');
      final controller = await open(server);
      for (var i = 0; i < 250; i++) {
        server.append('Message $i');
      }
      for (var i = 0; i < 3; i++) {
        await controller.refresh();
      }
      expect(controller.messages('lead'), hasLength(251));
      expect(
        controller.messages('lead').map((m) => m.sequence),
        List.generate(251, (i) => i + 1),
      );
    },
  );

  test('drafts and pending sends cannot cross accounts', () async {
    final server = ConversationServer()..loseReply = true;
    final first = await open(server);
    first.setDraft('lead', 'Private draft');
    await first.send();
    await first.flush();
    final other = server.controller(initial: server.saved, account: 'other');
    addTearDown(other.dispose);
    expect(other.draft('lead'), isEmpty);
    expect(other.hasPendingAction, isFalse);
  });

  test('viewers cannot send messages but can leave', () async {
    final server = ConversationServer();
    server.state['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'viewer'},
    ];
    final controller = await open(server);
    controller.setDraft('lead', 'Cannot send');
    expect(await controller.send(), isNull);
    expect(server.posts, isEmpty);
    await controller.command({'type': 'member.remove', 'userId': 'owner'});
    expect((server.posts.single['command'] as Map)['type'], 'member.remove');
  });

  test('revocation hides cached transcripts and a late response cannot restore them', () async {
    final server = ConversationServer()..append('Shared history');
    var revoked = false;
    final controller = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: server.save,
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (revoked) {
          throw const SuperTabFailure(
            'FORBIDDEN',
            'You no longer have access.',
            statusCode: 403,
          );
        }
        return server.request(method, path, body: body);
      },
    );
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(controller.messages('lead'), hasLength(1));
    revoked = true;
    await controller.refresh();
    expect(controller.snapshot, isNull);
    expect(controller.messages('lead'), isEmpty);
    expect(controller.canWrite, isFalse);
  });
}
