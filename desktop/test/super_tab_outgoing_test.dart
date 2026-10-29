import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';

void main() {
  test(
    'an older refresh cannot unlock a newer POST or retry it twice',
    () async {
      final s = ConversationServer();
      final second = Completer<void>();
      final c = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        save: s.save,
        pollInterval: Duration.zero,
        request: (method, path, {body}) async {
          if (method == 'POST' && (body!['command'] as Map)['text'] == 'Second')
            await second.future;
          return s.request(method, path, body: body);
        },
      );
      await c.refresh();
      c.setDraft('lead', 'First');
      final one = c.send();
      c.setDraft('lead', 'Second');
      final two = c.send();
      await one;
      expect(c.saving, isTrue);
      expect(await c.retry(), isNull);
      second.complete();
      await two;
      expect(s.posts, hasLength(2));
      await c.flush();
      c.dispose();
    },
  );
  test('revocation drops queued text and cannot dispatch it later', () async {
    final s = ConversationServer();
    final gate = Completer<void>();
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: s.save,
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (method == 'POST') await gate.future;
        return s.request(method, path, body: body);
      },
    );
    await c.refresh();
    c.setDraft('lead', 'First');
    final one = c.send();
    c.setDraft('lead', 'Second');
    final two = c.send();
    expect(c.outgoing('lead'), hasLength(2));
    c.revokeAccess('Access removed.');
    gate.complete();
    await Future.wait([one, two]);
    expect(c.outgoing('lead'), isEmpty);
    expect(s.posts, hasLength(1));
    c.dispose();
  });
  test(
    'queued sends retain their project, workgroup and own Buddy destinations',
    () async {
      final s = ConversationServer();
      final gate = Completer<void>();
      var hold = false;
      final c = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        save: s.save,
        pollInterval: Duration.zero,
        request: (method, path, {body}) async {
          if (method == 'POST' && hold) await gate.future;
          return s.request(method, path, body: body);
        },
      );
      await c.refresh();
      await c.addBuddy(projectId: 'lead', machineId: 'mac', engine: 'claude');
      hold = true;
      final sends = <Future<Map<String, dynamic>?>>[];
      for (final id in ['lead', 'offline', 'buddy-owner-lead']) {
        expect(await c.select(id), isTrue);
        c.setDraft(id, 'Message for $id');
        sends.add(c.send());
        expect(c.outgoing(id).single.text, 'Message for $id');
      }
      gate.complete();
      await Future.wait(sends);
      final posts = s.posts
          .map((p) => p['command'] as Map)
          .where((p) => p['type'] == 'message.send');
      expect(posts.map((p) => p['conversationId']), [
        'lead',
        'offline',
        'buddy-owner-lead',
      ]);
      await c.flush();
      c.dispose();
    },
  );
  test('a slow refresh never delays the next queued POST', () async {
    final s = ConversationServer();
    final reads = Completer<void>();
    var holdReads = false;
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: s.save,
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (method == 'GET' && holdReads) {
          final captured = await s.request(method, path, body: body);
          await reads.future;
          return captured;
        }
        return s.request(method, path, body: body);
      },
    );
    await c.refresh();
    holdReads = true;
    c.setDraft('lead', 'First');
    final one = c.send();
    c.setDraft('lead', 'Second');
    final two = c.send();
    await Future<void>.delayed(Duration.zero);
    expect(s.posts.map((p) => (p['command'] as Map)['text']), [
      'First',
      'Second',
    ]);
    reads.complete();
    await Future.wait([one, two]);
    expect(c.messages('lead').map((m) => m.text), ['First', 'Second']);
    await c.flush();
    c.dispose();
  });
  test('queued text survives closing and can never cross accounts', () async {
    final s = ConversationServer();
    final gate = Completer<void>();
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: s.save,
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (method == 'POST') await gate.future;
        return s.request(method, path, body: body);
      },
    );
    await c.refresh();
    c.setDraft('lead', 'First');
    final one = c.send();
    c.setDraft('lead', 'Second');
    final two = c.send();
    await c.flush();
    final saved = s.saved!;
    c.dispose();
    gate.complete();
    await Future.wait([one, two]);
    final restored = s.controller(initial: saved);
    await restored.refresh();
    expect(restored.outgoing('lead').map((m) => m.text), ['First', 'Second']);
    expect(
      s.posts,
      hasLength(1),
      reason: 'Only the request already dispatched before close can finish; restoration sends nothing.',
    );
    final other = SuperTabController(
      tabId: 'tab',
      accountId: 'someone-else',
      request: s.request,
      save: s.save,
      initial: saved,
      pollInterval: Duration.zero,
    );
    expect(other.outgoing('lead'), isEmpty);
    restored.dispose();
    other.dispose();
  });
  test(
    'acknowledged text confirms before the following refresh finishes',
    () async {
      final s = ConversationServer();
      final reads = Completer<void>();
      var holdReads = false;
      final c = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        save: s.save,
        pollInterval: Duration.zero,
        request: (method, path, {body}) async {
          if (method == 'GET' && holdReads) await reads.future;
          return s.request(method, path, body: body);
        },
      );
      await c.refresh();
      holdReads = true;
      c.setDraft('lead', 'Confirmed already');
      final sent = c.send();
      await Future<void>.delayed(Duration.zero);
      expect(c.outgoing('lead').single.state.name, 'confirmed');
      reads.complete();
      await sent;
      expect(c.outgoing('lead'), isEmpty);
      expect(c.messages('lead').map((m) => m.text), ['Confirmed already']);
      await c.flush();
      c.dispose();
    },
  );
  test(
    'an uncertain first send keeps later text retryable in typed order',
    () async {
      final server = ConversationServer()..loseReply = true;
      final gate = Completer<void>();
      final c = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        save: server.save,
        pollInterval: Duration.zero,
        request: (method, path, {body}) async {
          if (method == 'POST') await gate.future;
          return server.request(method, path, body: body);
        },
      );
      await c.refresh();
      c.setDraft('lead', 'First');
      final one = c.send();
      c.setDraft('lead', 'Second');
      final two = c.send();
      gate.complete();
      await Future.wait([one, two]);
      expect(server.posts, hasLength(1));
      expect(c.outgoing('lead').map((m) => m.text), ['First', 'Second']);
      expect(c.outgoing('lead').map((m) => m.state), [
        SuperTabOutgoingState.unconfirmed,
        SuperTabOutgoingState.refused,
      ]);
      await c.flush();
      c.dispose();
    },
  );
  test('rapid text sends show immediately and post in typed order', () async {
    final server = ConversationServer();
    final first = Completer<void>();
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: server.save,
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (method == 'POST' && server.posts.isEmpty) await first.future;
        return server.request(method, path, body: body);
      },
    );
    await c.refresh();
    c.setDraft('lead', 'First');
    final one = c.send();
    await Future<void>.delayed(Duration.zero);
    c.setDraft('lead', 'Second');
    final two = c.send();
    await Future<void>.delayed(Duration.zero);
    expect(c.outgoing('lead').map((m) => m.text), ['First', 'Second']);
    expect(c.draft('lead'), isEmpty);
    first.complete();
    await Future.wait([one, two]);
    expect(server.posts.map((p) => (p['command'] as Map)['text']), [
      'First',
      'Second',
    ]);
    expect(c.messages('lead').map((m) => m.text), ['First', 'Second']);
    await c.flush();
    c.dispose();
  });

  /// A controller whose sends wait for [hold] while it is set.
  ({SuperTabController controller, ConversationServer server}) open({
    Completer<void>? Function()? hold,
    Map<String, dynamic>? initial,
    ConversationServer? server,
  }) {
    final s = server ?? ConversationServer();
    final controller = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: s.save,
      initial: initial ?? const {},
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (method == 'POST') await hold?.call()?.future;
        return s.request(method, path, body: body);
      },
    );
    addTearDown(() async {
      await controller.flush();
      controller.dispose();
    });
    return (controller: controller, server: s);
  }

  List<(String, SuperTabOutgoingState)> outgoing(SuperTabController c) => [
    for (final m in c.outgoing('lead')) (m.text, m.state),
  ];

  test('a message is outgoing from the moment it is sent until the transcript '
      'holds it, and the draft is free at once', () async {
    final post = Completer<void>();
    final (:controller, :server) = open(hold: () => post);
    await controller.refresh();
    controller.setDraft('lead', 'Please check the arm64 build');

    final sending = controller.send();
    await Future<void>.delayed(Duration.zero);
    expect(controller.draft('lead'), isEmpty);
    expect(outgoing(controller), [
      ('Please check the arm64 build', SuperTabOutgoingState.sending),
    ]);

    post.complete();
    await sending;
    expect(outgoing(controller), isEmpty);
    expect(controller.messages('lead').map((m) => m.text), [
      'Please check the arm64 build',
    ]);
  });

  test('a confirmed message the transcript does not hold yet stays outgoing, '
      'once, and leaves when a read brings it', () async {
    final (:controller, :server) = open();
    await controller.refresh();
    controller.setDraft('lead', 'Ship it');
    // The send lands; the read after it does not.
    server.failReads = true;
    await controller.send();
    expect(outgoing(controller), [
      ('Ship it', SuperTabOutgoingState.confirmed),
    ]);
    expect(controller.messages('lead'), isEmpty);

    server.failReads = false;
    await controller.refresh();
    expect(outgoing(controller), isEmpty);
    expect(controller.messages('lead').map((m) => m.text), ['Ship it']);
  });

  test(
    'a send whose answer is lost is unconfirmed; Retry sends it once',
    () async {
      final (:controller, :server) = open(
        server: ConversationServer()..loseReply = true,
      );
      await controller.refresh();
      controller.setDraft('lead', 'Build the agreed plan.');
      expect(await controller.send(), isNull);
      expect(controller.draft('lead'), isEmpty);
      expect(outgoing(controller), [
        ('Build the agreed plan.', SuperTabOutgoingState.unconfirmed),
      ]);

      await controller.retry();
      expect(server.posts[0]['operationId'], server.posts[1]['operationId']);
      expect(server.messages, hasLength(1));
      expect(outgoing(controller), isEmpty);
      expect(controller.messages('lead').map((m) => m.text), [
        'Build the agreed plan.',
      ]);
    },
  );

  test('an unconfirmed message the transcript already holds is not shown '
      'twice', () async {
    final (:controller, :server) = open(
      server: ConversationServer()..loseReply = true,
    );
    await controller.refresh();
    controller.setDraft('lead', 'Once only');
    await controller.send();
    // The backend names a person's message by the send's operation id.
    final sent = server.messages.single;
    sent['id'] = server.posts.single['operationId'];
    await controller.refresh();
    expect(controller.messages('lead').map((m) => m.text), ['Once only']);
    expect(outgoing(controller), isEmpty);
  });

  test('a refused message keeps its text and reason after a restart too; '
      'Retry sends it as it was, tags and reply included', () async {
    final server = ConversationServer()
      ..append('Which build?')
      ..state['agents'] = [
        {
          'id': 'builder',
          'name': 'Builder',
          'machineId': 'host',
          'harnessId': 'session',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
    ((server.state['conversations'] as List)[0] as Map)['agentIds'] = [
      'builder',
    ];
    final first = open(server: server).controller;
    await first.refresh();
    first.setDraft('lead', '@Builder the arm64 one');
    first.mention('lead', 'builder', '@Builder');
    server.reject = true;
    await first.send(replyTo: 'message-1');
    expect(first.draft('lead'), isEmpty);
    final refused = first.outgoing('lead').single;
    expect(refused.state, SuperTabOutgoingState.refused);
    expect(refused.text, '@Builder the arm64 one');
    expect(refused.error, 'Choose an agent in this conversation.');
    await first.flush();

    final reopened = open(server: server, initial: server.saved).controller;
    await reopened.refresh();
    expect(
      reopened.outgoing('lead').single.state,
      SuperTabOutgoingState.refused,
    );
    server.reject = false;
    await reopened.retryOutgoing(reopened.outgoing('lead').single);
    expect(reopened.outgoing('lead'), isEmpty);
    expect(reopened.draft('lead'), isEmpty);
    expect(server.messages.last['text'], '@Builder the arm64 one');
    expect(server.messages.last['replyTo'], 'message-1');
    expect(server.posts.last['command']['recipientIds'], ['builder']);
  });

  test('losing access drops what was waiting to be shown', () async {
    final (:controller, :server) = open(
      server: ConversationServer()..reject = true,
    );
    await controller.refresh();
    controller.setDraft('lead', 'Private');
    await controller.send();
    expect(controller.outgoing('lead'), hasLength(1));
    controller.revokeAccess('Access removed.');
    expect(controller.outgoing('lead'), isEmpty);
  });

  test('Delete removes a refused message, and nothing is sent', () async {
    final (:controller, :server) = open(
      server: ConversationServer()..reject = true,
    );
    await controller.refresh();
    controller.setDraft('lead', 'Not this one');
    await controller.send();
    controller.discardOutgoing(controller.outgoing('lead').single);
    expect(controller.outgoing('lead'), isEmpty);
    expect(controller.operationError, isNull);
    await controller.flush();
    expect(server.saved!.containsKey('refused'), isFalse);
    expect(server.messages, isEmpty);
  });

  test('Delete of an unconfirmed message that did arrive shows it once on the '
      'next read', () async {
    final (:controller, :server) = open(
      server: ConversationServer()..loseReply = true,
    );
    await controller.refresh();
    controller.setDraft('lead', 'It got there');
    await controller.send();
    expect(
      controller.outgoing('lead').single.state,
      SuperTabOutgoingState.unconfirmed,
    );
    // The server took it and its answer was lost; the read after failed too.
    expect(server.messages, hasLength(1));

    controller.discardOutgoing(controller.outgoing('lead').single);
    expect(controller.outgoing('lead'), isEmpty);
    expect(controller.hasPendingAction, isFalse);
    await controller.refresh();
    expect(controller.messages('lead').map((m) => m.text), ['It got there']);
    expect(controller.outgoing('lead'), isEmpty);
    await controller.flush();
    expect(server.saved!.containsKey('pending'), isFalse);
  });

  test('a refused message stays when the next one is sent, and a second '
      'refusal keeps both, until each is sent again or deleted', () async {
    final (:controller, :server) = open();
    await controller.refresh();
    server.reject = true;
    controller.setDraft('lead', 'First');
    await controller.send();
    server.reject = false;
    controller.setDraft('lead', 'Second');
    await controller.send();
    expect(outgoing(controller), [('First', SuperTabOutgoingState.refused)]);
    expect(controller.messages('lead').map((m) => m.text), ['Second']);

    server.reject = true;
    controller.setDraft('lead', 'Third');
    await controller.send();
    expect(outgoing(controller), [
      ('First', SuperTabOutgoingState.refused),
      ('Third', SuperTabOutgoingState.refused),
    ]);
    await controller.flush();
    final reopened = open(server: server, initial: server.saved).controller;
    await reopened.refresh();
    expect(outgoing(reopened), outgoing(controller));

    server.reject = false;
    await reopened.retryOutgoing(reopened.outgoing('lead').first);
    expect(server.messages.last['text'], 'First');
    expect(outgoing(reopened), [('Third', SuperTabOutgoingState.refused)]);
    reopened.discardOutgoing(reopened.outgoing('lead').single);
    expect(outgoing(reopened), isEmpty);
  });
}
