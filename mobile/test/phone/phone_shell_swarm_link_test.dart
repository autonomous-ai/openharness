import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../swarm/swarm_fixture.dart';
import 'devices_fixture.dart';

/// A message link (Desktop's Copy link to message) opened on the phone: the
/// native side holds each until the app takes it, and the shell opens the
/// chat at that message over the Swarm page.
void main() {
  const channel = MethodChannel('harness/links');
  late DevicesApp app;
  late List<String> waiting;
  late int takes;

  setUp(() {
    app = _LinkApp()
      ..currentUser = const CurrentUserProfile(
        id: 'person-me',
        email: 'me@example.com',
      );
    experimentalFeaturesStore.value = {PhoneExperiment.swarm};
    waiting = [];
    takes = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method != 'take') return null;
          takes++;
          final taken = List.of(waiting);
          waiting.clear();
          return taken;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    experimentalFeaturesStore.value = const {};
    app.dispose();
  });

  /// The native side saying a link arrived while the app runs.
  Future<void> arrive(WidgetTester tester, String url) async {
    waiting.add(url);
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(const MethodCall('arrived')),
      (_) {},
    );
    await tester.pump();
    // The route transitions finish, as for a tapped notice.
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> start(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();
    // The route transitions finish, as for a tapped notice.
    await tester.pump(const Duration(seconds: 1));
  }

  void expectOpened(WidgetTester tester, (String, String, String) at) {
    final page = tester.widget<SwarmConversationPage>(
      find.byType(SwarmConversationPage),
    );
    expect((page.swarmId, page.conversationId, page.messageId), at);
    expect(find.byType(SwarmPage, skipOffstage: false), findsOneWidget);
  }

  testWidgets('a link that arrives opens its chat at the message, over the '
      'Swarm page', (tester) async {
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');

    expectOpened(tester, ('tab-b', 'g9', 'm7'));
  });

  testWidgets('a link that launched the app, or came before sign-in, opens '
      'once the shell is up', (tester) async {
    waiting.add('harness://swarm/tab-b/g9/m7');
    await start(tester);

    expectOpened(tester, ('tab-b', 'g9', 'm7'));
    expect(waiting, isEmpty, reason: 'taken once');
  });

  testWidgets('a second link replaces the first chat, not stacks on it', (
    tester,
  ) async {
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');
    await arrive(tester, 'harness://swarm/tab-b/g2/m1');

    expectOpened(tester, ('tab-b', 'g2', 'm1'));
    expect(find.byType(SwarmConversationPage), findsOneWidget);
  });

  testWidgets('what is not a message link opens nothing', (tester) async {
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9');
    await arrive(tester, 'harness://swarm/tab-b/g9/m7?x=1');

    expect(find.byType(SwarmConversationPage), findsNothing);
  });

  testWidgets('with Swarm off, a link says to turn it on and opens nothing', (
    tester,
  ) async {
    experimentalFeaturesStore.value = const {};
    await start(tester);
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');

    expect(find.byType(SwarmConversationPage), findsNothing);
    expect(find.byType(AgentHome), findsOneWidget);
    expect(
      find.text('Turn on Swarm in Settings to open this link.'),
      findsOneWidget,
    );
  });

  group('to a project chat', () {
    /// One Swarm whose project Mobile's chat is [leadChat]; the person also
    /// has a work chat g9 there, and a private chat.
    FakeSwarm swarm({Future<void>? partsHeld}) {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': 'person-me'},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) async {
        await partsHeld;
        return {
          ...firstLoad(
            groups: [
              groupData('g9', title: 'Fix login', agentIds: ['agent-lead']),
              groupData('g-private', title: 'Theirs', audience: ['other']),
            ],
          ),
          'members': [part('person-me', 1, person('person-me'))],
        };
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/'] = (_) => <String, dynamic>{};
      return fake;
    }

    /// Frames enough for the Swarm's reads and the pages' transitions.
    Future<void> frames(WidgetTester tester) async {
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    void expectProjectAt(WidgetTester tester, String messageId) {
      expectHomeCProject('Mobile');
      final chat = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect(
        (chat.swarmId, chat.conversationId, chat.messageId),
        (tab, leadChat, messageId),
      );
      expect(find.byType(SwarmPage, skipOffstage: false), findsOneWidget);
    }

    testWidgets("opens the project on Home C's screen, its chat at the "
        'message', (tester) async {
      (app as _LinkApp).swarm = swarm();
      await start(tester);
      await frames(tester);
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      await frames(tester);

      expectProjectAt(tester, 'm7');
    });

    testWidgets('one that arrives before the Swarm is read opens the '
        'project once it is', (tester) async {
      final held = Completer<void>();
      (app as _LinkApp).swarm = swarm(partsHeld: held.future);
      waiting.add('harness://swarm/$tab/$leadChat/m7');
      await start(tester);
      await frames(tester);

      held.complete();
      await frames(tester);
      expectProjectAt(tester, 'm7');
      expect(find.byType(SwarmProjectPage), findsOneWidget);
    });

    /// A Swarm whose first copy has no project yet; its change reads answer
    /// as [_Changes.next] says when each is sent, and each waits for
    /// [_Changes.gate] when one is set.
    ({FakeSwarm fake, _Changes changes}) olderCopy() {
      final fake = swarm();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      final control = _Changes();
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async => {
        ...(await load(body) as Map<String, dynamic>),
        'head': part('head', 1, headData(projects: const [])),
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) async {
        // What the server answers is fixed when the read is sent.
        final next = control.next;
        await control.gate?.future;
        return switch (next) {
          'fail' => throw const SuperTabFailure(
            'TIMEOUT',
            'The Swarm did not answer.',
          ),
          'newer' => {
            ...changes(cursor: 'c3'),
            'head': part('head', 2, headData()),
          },
          _ => changes(cursor: 'c2'),
        };
      };
      return (fake: fake, changes: control);
    }

    SwarmHost host(WidgetTester tester) =>
        tester.widget<SwarmScope>(find.byType(SwarmScope).first).notifier!;

    testWidgets('a link whose first copy of the Swarm is older than its '
        'project reads once more, and opens the project', (tester) async {
      final (:fake, :changes) = olderCopy();
      (app as _LinkApp).swarm = fake;
      await start(tester);
      await frames(tester);
      expect(find.text('Mobile', skipOffstage: false), findsNothing);

      changes.next = 'newer';
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      await frames(tester);
      expectProjectAt(tester, 'm7');
    });

    testWidgets('a read that fails decides nothing: once one gets through, '
        'the project opens', (tester) async {
      final (:fake, :changes) = olderCopy();
      (app as _LinkApp).swarm = fake;
      await start(tester);
      await frames(tester);

      changes.next = 'fail';
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      await frames(tester);
      expect(find.byType(SwarmProjectPage), findsNothing, reason: 'offline');
      final sent = fake.paths.where((p) => p.contains('/changes?')).length;
      await frames(tester);
      expect(
        fake.paths.where((p) => p.contains('/changes?')).length,
        lessThanOrEqualTo(sent + 1),
        reason:
            'no read asked again and again while it fails: the '
            "reader's own poll, every 5 s, at most",
      );

      changes.next = 'newer';
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await frames(tester);
      expectProjectAt(tester, 'm7');
    });

    testWidgets('a read already under way when it opened does not decide: '
        'one more is read, and opens the project', (tester) async {
      final (:fake, :changes) = olderCopy();
      (app as _LinkApp).swarm = fake;
      await start(tester);
      await frames(tester);

      // Sent before the link opened: it answers the older copy.
      changes.gate = Completer<void>();
      final early = host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pump();
      changes.next = 'newer';
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      changes.gate!.complete();
      changes.gate = null;
      await early;
      await frames(tester);

      expectProjectAt(tester, 'm7');
    });

    testWidgets('a new reader for the Swarm starts the wait again: the old '
        "one's read, ending after, decides nothing", (tester) async {
      final (:fake, :changes) = olderCopy();
      (app as _LinkApp).swarm = fake;
      final list = fake.routes['/api/super-tabs/list']!;
      await start(tester);
      await frames(tester);

      // The link's read, held, on the first reader.
      changes.gate = Completer<void>();
      final held = changes.gate!;
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      final old = host(tester).session!.inbox.reader(tab)!;

      // The Swarm leaves the list and comes back with a new reader, whose
      // first copy is still without the project; its change reads bring it.
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host(tester).session!.inbox.refresh();
      changes.gate = null;
      changes.next = 'newer';
      fake.routes['/api/super-tabs/list'] = list;
      await host(tester).session!.inbox.refresh();
      expect(identical(host(tester).session!.inbox.reader(tab), old), isFalse);
      // The old reader's read ends only now, answering the older copy.
      held.complete();
      await frames(tester);

      expectProjectAt(tester, 'm7');
    });

    testWidgets("a work chat's link opens that chat, not a project", (
      tester,
    ) async {
      (app as _LinkApp).swarm = swarm();
      await start(tester);
      await frames(tester);
      await arrive(tester, 'harness://swarm/$tab/g9/m1');
      await frames(tester);

      expect(find.byType(SwarmProjectPage), findsNothing);
      expectOpened(tester, (tab, 'g9', 'm1'));
    });

    testWidgets("the project chat's id under another Swarm's id opens no "
        'project, and names none', (tester) async {
      (app as _LinkApp).swarm = swarm();
      await start(tester);
      await frames(tester);
      await arrive(tester, 'harness://swarm/tab-other/$leadChat/m7');
      await frames(tester);

      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(find.text('#Mobile'), findsNothing);
      expect(find.text('Mobile'), findsNothing);
    });

    testWidgets("a private chat's or a Buddy chat's link opens no project, "
        'and names none', (tester) async {
      (app as _LinkApp).swarm = swarm();
      await start(tester);
      await frames(tester);
      for (final chat in ['g-private', 'buddy-someone']) {
        await arrive(tester, 'harness://swarm/$tab/$chat/m1');
        await frames(tester);

        expect(find.byType(SwarmProjectPage), findsNothing, reason: chat);
        expect(find.text('#Mobile'), findsNothing, reason: chat);
        expectOpened(tester, (tab, chat, 'm1'));
      }
    });

    testWidgets('a first read that fails leaves the chat page, with no '
        'Loading held; once a read gets through, the project opens', (
      tester,
    ) async {
      final fake = swarm();
      final answer = fake.routes['/api/super-tabs/$tab/parts']!;
      var fail = true;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) => fail
          ? throw const SuperTabFailure('TIMEOUT', 'The Swarm did not answer.')
          : answer(body);
      (app as _LinkApp).swarm = fake;
      await start(tester);
      await frames(tester);
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      await frames(tester);

      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(find.byType(SwarmConversationPage), findsOneWidget);
      expect(key('swarm-project-loading'), findsNothing);

      fail = false;
      final host = tester
          .widget<SwarmScope>(find.byType(SwarmScope).first)
          .notifier!;
      await host.session!.inbox.refresh();
      await frames(tester);
      expectProjectAt(tester, 'm7');
    });

    testWidgets('a link replaced while its Swarm is read: the read opens '
        'only the second, and once', (tester) async {
      final held = Completer<void>();
      (app as _LinkApp).swarm = swarm(partsHeld: held.future);
      await start(tester);
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      await arrive(tester, 'harness://swarm/$tab/g9/m1');

      held.complete();
      await frames(tester);
      expect(find.byType(SwarmProjectPage), findsNothing);
      expectOpened(tester, (tab, 'g9', 'm1'));
      expect(tester.takeException(), isNull);
    });

    testWidgets('access lost before the read says what the chat is: no '
        'project opens', (tester) async {
      final held = Completer<void>();
      (app as _LinkApp).swarm = swarm(partsHeld: held.future);
      await start(tester);
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      final host = tester
          .widget<SwarmScope>(find.byType(SwarmScope).first)
          .notifier!;
      await frames(tester);
      host.session!.inbox.reader(tab)?.revoke();

      held.complete();
      await frames(tester);
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(find.text('#Mobile'), findsNothing);
    });

    testWidgets('access lost while it is open: the project goes from the '
        'screen', (tester) async {
      (app as _LinkApp).swarm = swarm();
      await start(tester);
      await frames(tester);
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      await frames(tester);
      expectHomeCProject('Mobile');

      final host = tester
          .widget<SwarmScope>(find.byType(SwarmScope).first)
          .notifier!;
      host.session!.inbox.reader(tab)!.revoke();
      await frames(tester);

      expect(find.text('#Mobile'), findsNothing);
      expect(key('swarm-project-menu'), findsNothing);
    });

    testWidgets('access lost with Approve asking over the Team sheet, in the '
        "shell's own navigator: the dialog and the sheet go", (tester) async {
      const derived = {'decisionsWaiting': 1};
      final fake = swarm();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          agents: [
            agent('agent-lead', name: 'Lead', displayName: 'River'),
            agent('agent-juno', displayName: 'Juno'),
          ],
          groups: [
            groupData(
              'g2',
              title: 'Saved views cache',
              number: 2160,
              agentIds: ['agent-lead', 'agent-juno'],
              status: 'needs_human',
              workerId: 'agent-juno',
              lastMessageSequence: 4,
            ),
          ],
          derived: derived,
        ),
        'members': [part('person-me', 1, person('person-me'))],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          {
            'id': 'd1',
            'projectName': 'Mobile',
            'conversationId': 'g2',
            'conversationTitle': 'Saved views cache',
            'askerName': 'River',
            'question': 'Merge #2160?',
            'options': ['Merge', 'Wait'],
          },
        ],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      (app as _LinkApp).swarm = fake;
      await start(tester);
      await frames(tester);
      await arrive(tester, 'harness://swarm/$tab/$leadChat/m7');
      await frames(tester);
      await tester.tap(key('swarm-project-menu'));
      await frames(tester);
      await tester.tap(key('swarm-project-menu-team'));
      await frames(tester);
      await tester.tap(key('swarm-approve-d1'));
      await frames(tester);
      expect(find.byType(AlertDialog), findsOneWidget);

      tester
          .widget<SwarmScope>(find.byType(SwarmScope).first)
          .notifier!
          .session!
          .inbox
          .reader(tab)!
          .revoke();
      await frames(tester);

      expect(find.byType(AlertDialog), findsNothing);
      expect(find.textContaining('Merge #2160?'), findsNothing);
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.text('#Mobile'), findsNothing);
      expect(fake.commands, isEmpty);
    });
  });

  testWidgets('after the shell is gone (signed out) a link is left for the '
      'next one', (tester) async {
    await start(tester);
    await tester.pumpWidget(const SizedBox());
    final before = takes;
    await arrive(tester, 'harness://swarm/tab-b/g9/m7');

    expect(takes, before, reason: 'nobody took it');
    expect(waiting, ['harness://swarm/tab-b/g9/m7']);
  });
}

Finder key(String value) => find.byKey(ValueKey(value));

class _LinkApp extends DevicesApp {
  /// The Swarm backend the shell's Swarm reads, when a test gives one.
  FakeSwarm? swarm;

  @override
  Future<Object?> swarmRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) => switch (swarm) {
    final fake? => fake.request(method, path, body: body),
    null => super.swarmRequest(method, path, body: body),
  };

  @override
  void handleAppResumed() {}
}

/// How [olderCopy]'s change reads answer.
class _Changes {
  String next = 'old';
  Completer<void>? gate;
}
