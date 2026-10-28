import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';

void main() {
  test(
    'receipt refreshes the latest own message when a new reply arrives',
    () async {
      final server = ConversationServer()..append('Please start.');
      server.messages.first['deliveries'] = [
        {'id': 'delivery', 'agentId': 'lead-agent', 'status': 'claimed'},
      ];
      final c = server.controller();
      await c.refresh();
      server.messages.first['deliveries'] = [
        {'id': 'delivery', 'agentId': 'lead-agent', 'status': 'answered'},
      ];
      server.append('Done.');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'lead-agent',
        'name': 'Lead',
      };
      server.messages.last['replyTo'] = server.messages.first['id'];
      await c.refresh();
      expect(c.messages('lead').first.deliveries.single['status'], 'answered');
      c.dispose();
    },
  );

  test('keeps the backend\'s credential notice for the sender until the next action', () async {
    const notice =
        'Removed a credential (GitHub token) before saving. Revoke or rotate it.';
    final server = ConversationServer()
      ..commandResult['credentialNotice'] = notice;
    final c = server.controller();
    await c.refresh();
    c.setDraft('lead', 'Here is the token.');
    expect(await c.send(), isNotNull);
    expect(c.operationNotice, notice);
    expect(c.draft('lead'), isEmpty);
    server.commandResult.clear();
    c.setDraft('lead', 'Plain words.');
    expect(await c.send(), isNotNull);
    expect(c.operationNotice, isNull);
    server.commandResult['credentialNotice'] = notice;
    c.setDraft('lead', 'Again.');
    await c.send();
    c.select('offline');
    expect(c.operationNotice, isNull);
    c.dispose();
  });

  test(
    'group terminals keep every member when selecting one and after reopening',
    () async {
      final server = ConversationServer();
      server.state['agents'] = [
        for (final id in ['a', 'b'])
          {
            'id': id,
            'name': id,
            'machineId': 'm',
            'harnessId': 'native-$id',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
          },
      ];
      (server.state['conversations'] as List)[1]['agentIds'] = ['a', 'b'];
      final c = server.controller();
      await c.refresh();
      c.selectGroupTerminals('offline');
      expect(c.terminalAgents('offline').map((a) => a.id), ['a', 'b']);
      c.selectTerminal('offline', 'b');
      expect(c.terminalAgents('offline').map((a) => a.id), ['a', 'b']);
      await c.flush();
      c.dispose();
      final restored = server.controller(initial: server.saved);
      await restored.refresh();
      expect(restored.terminalAgents('offline').map((a) => a.id), ['a', 'b']);
      restored.selectGroupTerminals('offline');
      expect(restored.terminalAgents('offline').map((a) => a.id), ['a', 'b']);
      (server.state['conversations'] as List)[1]['agentIds'] = ['a'];
      await restored.refresh();
      expect(restored.terminalAgents('offline').map((a) => a.id), ['a']);
      restored.revokeAccess('Removed');
      expect(restored.terminalAgents('offline'), isEmpty);
      restored.dispose();
    },
  );
  test('terminal selections survive reopening and cannot cross accounts or group membership', () async {
    final server = ConversationServer();
    server.state['agents'] = [
      {
        'id': 'worker',
        'name': 'Worker',
        'machineId': 'm',
        'harnessId': 'native',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    (server.state['conversations'] as List)[1]['agentIds'] = ['worker'];
    final first = server.controller();
    await first.refresh();
    first.selectTerminal('offline', 'worker');
    first.selectTerminal('lead', 'worker');
    expect(first.terminalAgent('lead'), isNull);
    await first.flush();
    first.dispose();
    final restored = server.controller(initial: server.saved);
    await restored.refresh();
    expect(restored.terminalAgent('offline')?.id, 'worker');
    final other = server.controller(initial: server.saved, account: 'other');
    await other.refresh();
    expect(other.terminalAgent('offline'), isNull);
    other.dispose();
    (server.state['conversations'] as List)[1]['agentIds'] = <String>[];
    await restored.refresh();
    expect(restored.terminalAgent('offline'), isNull);
    restored.dispose();
  });
  test(
    'mentions keep stable agent identities through rename, reopen and deletion',
    () async {
      final server = ConversationServer();
      (server.state['conversations'] as List)[0]['agentIds'] = ['worker-1'];
      final first = server.controller();
      await first.refresh();
      first.setDraft('lead', '@Worker 1 review this.');
      first.mention('lead', 'worker-1', '@Worker 1');
      await first.flush();
      first.dispose();
      final reopened = server.controller(initial: server.saved);
      await reopened.refresh();
      await reopened.send();
      expect((server.posts.single['command'] as Map)['recipientIds'], [
        'worker-1',
      ]);
      reopened.setDraft('lead', '@Worker 1 again');
      reopened.mention('lead', 'worker-1', '@Worker 1');
      reopened.setDraft('lead', '@Worker 10 again');
      expect(reopened.mentions('lead'), isEmpty);
      reopened.setDraft('lead', '@Worker 1 check');
      reopened.mention('lead', 'worker-1', '@Worker 1');
      (server.state['conversations'] as List)[0]['agentIds'] = <String>[];
      await reopened.refresh();
      expect(await reopened.send(), isNull);
      expect(server.posts, hasLength(1));
      expect(reopened.operationError, contains('no longer'));
      await reopened.flush();
      reopened.dispose();
    },
  );
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
        conversationFixture('onboarding', 'Onboarding'),
      );
      await controller.refresh();
      expect(controller.selectedId, 'offline');
      expect(controller.draft('offline'), 'Keep local changes');
      expect(controller.draft('lead'), 'Architecture notes');
      expect(
        controller.unread(controller.snapshot!.conversation('lead')!),
        isTrue,
      );
      await controller.loadMessages('lead');
      controller.markRead('lead');
      expect(
        controller.unread(controller.snapshot!.conversation('lead')!),
        isFalse,
      );
    },
  );

  test(
    'a displayed tail stays read when an older snapshot catches up',
    () async {
      final server = ConversationServer()..append('First visible update');
      final c = await open(server);
      c.markRead('lead', through: 1);
      server.append('Arrived before the snapshot');
      await c.loadMessages('lead');
      expect(c.selected!.lastMessageSequence, 1);
      expect(c.unread(c.selected!), isTrue);
      c.markRead('lead', through: 2);
      await c.flush();
      expect(server.saved!['readAt'], {'lead': 2});
      await c.refresh();
      expect(c.selected!.lastMessageSequence, 2);
      expect(c.unread(c.selected!), isFalse);
    },
  );

  test(
    'read boundaries cannot acknowledge messages that were never loaded',
    () async {
      final server = ConversationServer()..append('Loaded update');
      final c = await open(server);
      server.append('A newer lead message');
      server.append('A workgroup never opened', conversationId: 'offline');
      c.select('offline');
      // The selected-group request has not returned. No snapshot-only boundary
      // can acknowledge either the missing workgroup or the missing lead tail.
      c.markRead('offline', through: 999);
      c.markRead('lead', through: 999);
      await c.flush();
      expect(server.saved!['readAt'], {'lead': 1});
      await c.refresh();
      c.markRead('lead', through: 999);
      expect(c.unread(c.snapshot!.conversation('lead')!), isTrue);
      expect(c.unread(c.snapshot!.conversation('offline')!), isTrue);
      c.markRead('offline', through: 3);
      expect(c.unread(c.snapshot!.conversation('offline')!), isFalse);
      expect(c.unread(c.snapshot!.conversation('lead')!), isTrue);
    },
  );

  test('read markers persist for their Swarm and account only', () async {
    final server = ConversationServer()..append('Seen update');
    final c = await open(server);
    c.markRead('lead', through: 1);
    await c.flush();
    final saved = server.saved!;
    final restored = server.controller(initial: saved);
    final other = server.controller(initial: saved, account: 'other');
    addTearDown(restored.dispose);
    addTearDown(other.dispose);
    await restored.refresh();
    await other.refresh();
    expect(restored.unread(restored.selected!), isFalse);
    expect(other.unread(other.selected!), isTrue);
    restored.revokeAccess('Removed');
    restored.markRead('lead', through: 99);
    await restored.flush();
    expect(server.saved!['readAt'], {'lead': 1});
  });

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
      // The message waits in the chat for Retry; the draft is free.
      expect(first.draft('lead'), isEmpty);
      expect(
        first.outgoing('lead').single.state,
        SuperTabOutgoingState.unconfirmed,
      );
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
    expect(
      controller.outgoing('lead').single.state,
      SuperTabOutgoingState.refused,
    );
    server.reject = false;
    await controller.retryOutgoing(controller.outgoing('lead').single);
    expect(server.messages.single['text'], 'Hold this draft');
    expect(controller.outgoing('lead'), isEmpty);
  });

  test('reconnecting after more than a page of messages shows the latest, '
      'then fills the gap in order', () async {
    final server = ConversationServer()..append('First');
    final controller = await open(server);
    for (var i = 0; i < 250; i++) {
      server.append('Message $i');
    }
    await controller.refresh();
    expect(
      controller.messages('lead').map((m) => m.sequence),
      List.generate(100, (i) => i + 152),
    );
    while (controller.hasOlder('lead')) {
      await controller.loadMessages('lead', older: true);
    }
    expect(controller.messages('lead'), hasLength(251));
    expect(
      controller.messages('lead').map((m) => m.sequence),
      List.generate(251, (i) => i + 1),
    );
  });

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

  test(
    'a confirmed new group cannot send into the old group when its read fails',
    () async {
      final server = ConversationServer();
      final controller = await open(server);
      controller.setDraft('lead', 'Keep this in Lead');
      server.failReads = true;
      final result = await controller.command({
        'type': 'conversation.create',
        'title': 'New feature',
        'brief': '',
        'checks': <dynamic>[],
      });
      expect(controller.selectedId, result!['conversationId']);
      expect(controller.selected, isNull);
      controller.setDraft(controller.selectedId, 'Work here');
      expect(await controller.send(), isNull);
      expect(server.messages, isEmpty);
      server.failReads = false;
      await controller.refresh();
      await controller.send();
      expect(
        server.messages.single['conversationId'],
        result['conversationId'],
      );
      expect(controller.draft('lead'), 'Keep this in Lead');
    },
  );

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
