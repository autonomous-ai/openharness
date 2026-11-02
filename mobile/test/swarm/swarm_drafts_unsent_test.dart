import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_kept.dart';
import 'package:harness_mobile/swarm/swarm_outbox.dart';
import 'package:harness_mobile/swarm/swarm_post_line.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A chat's draft and a post that did not get through stay until they are sent
/// or cleared, across leaving the chat and a restart, for the account alone
/// (Tony's mobile list, task 25). A phone app is killed often.
void main() {
  const commands = '/api/super-tabs/$tab/commands';
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  late MemorySwarmKeptStore store;
  late FakeSwarm swarm;
  setUp(() {
    store = MemorySwarmKeptStore();
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData('g1', title: 'Fix login', agentIds: const ['agent-lead']),
        ],
      ),
      'members': [part(me, 1, person(me, role: 'owner'))],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes[messages] = (_) => {'messages': <Object>[], 'before': null};
  });

  /// A running app: what a restart makes anew, over the same [store].
  Future<SwarmInbox> app() async {
    final inbox = SwarmInbox(
      accountId: me,
      request: swarm.request,
      keptStore: store,
    );
    addTearDown(inbox.dispose);
    await inbox.kept.ready;
    await inbox.refresh();
    return inbox;
  }

  Future<SwarmConversation> chat(SwarmInbox inbox) async {
    final c = SwarmConversation(inbox.reader(tab)!, 'g1');
    addTearDown(() {
      if (!_gone.contains(c)) c.dispose();
    });
    await c.load();
    return c;
  }

  void leave(SwarmConversation c) {
    _gone.add(c);
    c.dispose();
  }

  Never lost(_) =>
      throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');

  /// A post whose answer never came.
  Future<SwarmPost> notSent(SwarmConversation c, String text) async {
    swarm.routes[commands] = lost;
    c.draft = text;
    await c.send();
    return c.outgoing.single;
  }

  group('a draft', () {
    test('survives leaving the chat and coming back', () async {
      final inbox = await app();
      final first = await chat(inbox);
      first.draft = 'half a thought';
      leave(first);
      expect((await chat(inbox)).draft, 'half a thought');
    });

    test('survives a restart, its mentions with it', () async {
      final before = await app();
      final c = await chat(before);
      c.draft = 'ask';
      c.mention('agent-lead');
      final draft = c.draft;
      expect(draft, isNot('ask'));
      await before.kept.flush();
      final again = await app();
      final after = await chat(again);
      expect(after.draft, draft);
      expect(again.kept.draft(tab, 'g1', null)?.mentions.keys, ['agent-lead']);
    });

    test('is kept per chat', () async {
      final inbox = await app();
      (await chat(inbox)).draft = 'for g1';
      expect(
        inbox.kept.draft(tab, 'g2', null),
        isNull,
        reason: 'another chat starts empty',
      );
    });

    test('a thread reply keeps its own, across a restart', () async {
      final before = await app();
      final c = await chat(before);
      final t = SwarmThread(c, 'root-1');
      addTearDown(t.dispose);
      t.draft = 'in the thread';
      expect(c.draft, isEmpty);
      await before.kept.flush();
      final after = await chat(await app());
      expect(after.threadDraft('root-1'), 'in the thread');
    });

    test(
      'goes once sent, and a kill right after brings nothing back',
      () async {
        swarm.routes[commands] = (_) => {
          'result': {'messageId': 'm9'},
        };
        final before = await app();
        final c = await chat(before);
        c.draft = 'sent now';
        await c.send();
        // No flush: what a send writes, it writes at once.
        expect(store.held?['drafts'], isEmpty);
        expect((await chat(await app())).draft, isEmpty);
      },
    );

    test('emptied by hand, it goes', () async {
      final before = await app();
      final c = await chat(before);
      c.draft = 'words';
      c.draft = '';
      await before.kept.flush();
      expect((await chat(await app())).draft, isEmpty);
    });
  });

  group('on the page', () {
    Future<SwarmHost> open(WidgetTester tester, {required String draft}) async {
      store
        ..heldBy = me
        ..held = {
          'drafts': [
            {'tab': tab, 'chat': 'g1', 'text': draft},
          ],
          'posts': <Object>[],
        };
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: swarm.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
        kept: store,
      )..foreground = false;
      addTearDown(host.dispose);
      await host.session!.inbox.kept.ready;
      await host.session!.inbox.refresh();
      await tester.pumpWidget(
        MaterialApp(
          builder: (_, child) => SwarmScope(notifier: host, child: child!),
          home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
        ),
      );
      await tester.pumpAndSettle();
      return host;
    }

    String box(WidgetTester tester) =>
        tester.widget<TextField>(find.byType(TextField)).controller!.text;

    testWidgets('the words kept are in the box when the chat opens', (
      tester,
    ) async {
      await open(tester, draft: 'half a thought');
      expect(box(tester), 'half a thought');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });

    testWidgets('what is typed then is what is kept', (tester) async {
      final host = await open(tester, draft: 'half');
      await tester.enterText(find.byType(TextField), 'half a thought');
      await tester.pump();
      expect(
        host.session!.inbox.kept.draft(tab, 'g1', null)?.text,
        'half a thought',
      );
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  });

  group('Not sent', () {
    test('survives a restart', () async {
      final c = await chat(await app());
      await notSent(c, 'did you get this?');
      final after = await chat(await app());
      expect(after.outgoing.single.text, 'did you get this?');
      expect(after.outgoing.single.state, SwarmPostState.unconfirmed);
    });

    test('one caught mid-send by a kill comes back as Not sent', () async {
      final answer = Completer<Object?>();
      swarm.routes[commands] = (_) => answer.future;
      final c = await chat(await app());
      c.draft = 'on its way';
      unawaited(c.send());
      await Future<void>.delayed(Duration.zero);
      expect(c.outgoing.single.state, SwarmPostState.sending);
      final after = await chat(await app());
      expect(after.outgoing.single.state, SwarmPostState.unconfirmed);
    });

    test('Retry after a restart sends the same receipt, once', () async {
      final c = await chat(await app());
      final post = await notSent(c, 'once only');
      final after = await chat(await app());
      swarm.routes[commands] = (_) => {
        'result': {'messageId': post.messageId},
      };
      expect(await after.retry(after.outgoing.single), isTrue);
      final sent = swarm.calls
          .where((call) => call.path == commands)
          .map((call) => call.body!['operationId'])
          .toSet();
      expect(sent, {post.operationId});
    });

    test('Delete takes it away for good', () async {
      final c = await chat(await app());
      final post = await notSent(c, 'never mind');
      c.deletePost(post);
      expect(c.outgoing, isEmpty);
      expect((await chat(await app())).outgoing, isEmpty);
    });

    test('a refusal after a restart puts its words back in the box', () async {
      final c = await chat(await app());
      await notSent(c, 'my words');
      final after = await chat(await app());
      swarm.routes[commands] = (_) =>
          throw const SuperTabFailure('INVALID', 'Refused.', statusCode: 400);
      await after.retry(after.outgoing.single);
      expect(after.outgoing, isEmpty);
      expect(after.draft, 'my words');
    });

    test('the first read showing it arrived drops the copy, quietly', () async {
      final c = await chat(await app());
      final post = await notSent(c, 'arrived after all');
      swarm.routes[messages] = (_) => {
        'messages': [
          {
            'id': post.messageId,
            'conversationId': 'g1',
            'text': 'arrived after all',
            'sequence': 1,
            'author': {'kind': 'person', 'id': me, 'name': 'me'},
            'createdAt': '2026-11-03T01:00:00.000Z',
          },
        ],
        'before': null,
      };
      final after = await chat(await app());
      expect(after.outgoing, isEmpty);
      expect(after.messages.single.id, post.messageId);
      expect(store.held?['posts'], isEmpty);
    });

    test('a thread reply survives too, and can be deleted', () async {
      final before = await app();
      final c = await chat(before);
      swarm.routes[commands] = lost;
      final t = SwarmThread(c, 'root-1');
      addTearDown(t.dispose);
      t.draft = 'reply';
      await t.send();
      final after = await chat(await app());
      final again = SwarmThread(after, 'root-1');
      addTearDown(again.dispose);
      expect(again.outgoing.single.text, 'reply');
      again.deletePost(again.outgoing.single);
      expect((await app()).kept.posts(tab, 'g1', 'root-1'), isEmpty);
    });

    testWidgets('its row has Retry and Delete; Sending… has neither', (
      tester,
    ) async {
      var retried = 0, deleted = 0;
      Widget line(bool sending) => MaterialApp(
        home: Scaffold(
          body: SwarmPostLine(
            sending: sending,
            onRetry: () => retried++,
            onDelete: () => deleted++,
          ),
        ),
      );
      await tester.pumpWidget(line(false));
      await tester.tap(find.byKey(const ValueKey('swarm-resend-post')));
      await tester.tap(find.byKey(const ValueKey('swarm-delete-post')));
      expect((retried, deleted), (1, 1));
      expect(
        tester.getSize(find.byKey(const ValueKey('swarm-delete-post'))).height,
        greaterThanOrEqualTo(44),
      );
      await tester.pumpWidget(line(true));
      expect(find.byKey(const ValueKey('swarm-delete-post')), findsNothing);
    });
  });

  group('access', () {
    test('a Swarm lost takes its own, and not another\'s', () async {
      final inbox = await app();
      final c = await chat(inbox);
      c.draft = 'mine';
      inbox.kept.setDraft('other', 'x', null, 'stays');
      await inbox.kept.flush();
      swarm.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await inbox.refresh();
      expect(inbox.kept.draft(tab, 'g1', null), isNull);
      expect(inbox.kept.draft('other', 'x', null)?.text, 'stays');
      expect('${store.held}', isNot(contains('mine')));
    });

    test('a chat lost while open takes its draft and posts', () async {
      final inbox = await app();
      final c = await chat(inbox);
      await notSent(c, 'unsent');
      c.draft = 'drafted';
      swarm.routes[messages] = (_) =>
          throw const SuperTabFailure('FORBIDDEN', 'No.', statusCode: 403);
      await c.load();
      expect(c.draft, isEmpty);
      expect('${store.held}', isNot(contains('unsent')));
      expect(inbox.kept.draft(tab, 'g1', null), isNull);
    });

    test('a chat lost while closed takes them, unopened', () async {
      final before = await app();
      before.kept.setDraft(tab, 'gone', null, 'secret words');
      await before.kept.flush();
      swarm.routes['/api/super-tabs/$tab/groups/gone'] = (_) =>
          throw const SuperTabFailure('NOT_FOUND', 'No.', statusCode: 404);
      final after = await app();
      await pumpEventQueue();
      expect(swarm.paths, contains('/api/super-tabs/$tab/groups/gone'));
      expect(after.kept.draft(tab, 'gone', null), isNull);
      expect('${store.held}', isNot(contains('secret words')));
    });

    test('a read that cannot say keeps it, and asks again', () async {
      final before = await app();
      before.kept.setDraft(tab, 'maybe', null, 'keep me');
      await before.kept.flush();
      swarm.routes['/api/super-tabs/$tab/groups/maybe'] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      final after = await app();
      await pumpEventQueue();
      expect(after.kept.draft(tab, 'maybe', null)?.text, 'keep me');
    });
  });

  group('the account', () {
    late ValueNotifier<String?> account;
    late bool reading;
    late ExperimentalFeaturesStore features;

    Future<SwarmHost> host() async {
      account = ValueNotifier<String?>(me);
      reading = false;
      features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final h = SwarmHost(
        accountId: () => account.value,
        accountReading: () => reading,
        account: account,
        request: swarm.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
        kept: store,
      )..foreground = false;
      addTearDown(h.dispose);
      await h.session!.inbox.kept.ready;
      h.session!.inbox.kept.setDraft(tab, 'g1', null, 'private words');
      await h.session!.inbox.kept.flush();
      expect('${store.held}', contains('private words'));
      return h;
    }

    Future<void> settled() => pumpEventQueue();

    test('signing out clears it', () async {
      await host();
      account.value = null;
      await settled();
      expect(store.held, isNull);
    });

    test('another account signing in clears it', () async {
      final h = await host();
      account.value = 'someone-else';
      await settled();
      expect(store.held, isNull);
      await h.session!.inbox.kept.ready;
      expect(h.session!.inbox.kept.draft(tab, 'g1', null), isNull);
    });

    test('Swarm turned off clears it', () async {
      await host();
      features.value = const {};
      await settled();
      expect(store.held, isNull);
    });

    test('the same account still being read keeps it', () async {
      await host();
      reading = true;
      account.value = null;
      await settled();
      expect('${store.held}', contains('private words'));
    });
  });
}

final _gone = <SwarmConversation>{};
