import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// Swarm's chat and start screens on a simulator, a screenshot at each step,
/// for comparing with Tony's prototype v2: the chat as the prototype fills it
/// (a reply's quote, a decision under its asker's message, an @mention), the
/// @ picker, Reply, a quote followed to its original, a post on its way; then
/// each start screen.
///
/// Every answer is scripted in memory ([FakeSwarm]): nothing reaches an
/// account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_chat_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the chat, as the prototype has it', (tester) async {
    final walk = _Walk(tester, binding, 'chat');
    final now = DateTime.now();
    DateTime at(int hour, int minute, {int day = 0}) =>
        DateTime(now.year, now.month, now.day - day, hour, minute);
    const conversation = 'g-pm';
    const messages =
        '/api/super-tabs/$tab/conversations/$conversation/messages';
    Map<String, dynamic> message(
      String id,
      int sequence,
      DateTime when,
      String text, {
      String author = 'agent-lead',
      String? replyTo,
    }) => {
      'id': id,
      'conversationId': conversation,
      'text': text,
      'sequence': sequence,
      'replyTo': ?replyTo,
      'author': author == me
          ? {'kind': 'person', 'id': me, 'name': 'Tony'}
          : {'kind': 'agent', 'id': author, 'name': 'River'},
      'attachments': <Object>[],
      'createdAt': when.toUtc().toIso8601String(),
    };
    final page = [
      message(
        'm2',
        2,
        at(11, 28),
        'Where are we on the phone build?',
        author: me,
      ),
      message(
        'm3',
        3,
        at(11, 34),
        'Jasper fixed the three review findings. Kai runs the iPhone test '
            'once the phone is plugged in. I will ask you before we ship.',
        replyTo: 'm2',
      ),
      message('m4', 4, at(11, 35), 'One question before the release:'),
      message(
        'm5',
        5,
        at(11, 40),
        '@Kai I will plug in the iPhone 14 after lunch.',
        author: me,
      ),
      message(
        'm6',
        6,
        at(11, 41),
        'Thanks. Kai starts the moment it is in.',
        replyTo: 'm5',
      ),
    ];

    final fake = FakeSwarm();
    final posted = Completer<Object?>();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    const derived = {'decisionsWaiting': 1};
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        head: headData(
          projects: [
            {
              'id': project,
              'name': 'openharness',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
          ],
        ),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-jasper', displayName: 'Jasper'),
          agent('agent-kai', displayName: 'Kai'),
        ],
        groups: [
          groupData(
            conversation,
            title: 'tony',
            agentIds: ['agent-lead', 'agent-jasper', 'agent-kai'],
            audience: [me],
            lastMessageSequence: 6,
          ),
          groupData(
            'g-test',
            title: 'iPhone test',
            agentIds: ['agent-kai'],
            status: 'working',
            workerId: 'agent-kai',
          ),
        ],
        derived: derived,
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'projectId': project,
          'projectName': 'openharness',
          'conversationId': conversation,
          'conversationTitle': 'tony',
          'askerName': 'River',
          'question':
              'Ship mobile v1 behind a flag for a week, or to everyone?',
          'options': ['Flag 1 week', 'Everyone'],
          'recommended': -1,
          'createdAt': at(
            11,
            35,
          ).add(const Duration(seconds: 20)).toUtc().toIso8601String(),
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': {'sequence': 2, 'id': 'm2'},
    };
    fake.routes['$messages?before=2&beforeId=m2'] = (_) => {
      'messages': [
        message('m1', 1, at(17, 2, day: 1), 'The phone build is on its way.'),
      ],
      'next': null,
    };
    // A post stays on its way, for its screenshot.
    fake.routes['/api/super-tabs/$tab/commands'] = (_) => posted.future;

    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      _app(
        host,
        const SwarmConversationPage(swarmId: tab, conversationId: conversation),
      ),
    );
    await walk.waitFor(walk.key('swarm-ask-d1'));
    await walk.shot('chat');

    await tester.enterText(find.byType(TextField), '@');
    await walk.shot('mention-picker');
    await tester.enterText(find.byType(TextField), '@K');
    await walk.shot('mention-narrowed');
    await tester.enterText(find.byType(TextField), '');

    await tester.tap(find.text('Thanks. Kai starts the moment it is in.'));
    await walk.shot('actions');
    await tester.tap(walk.key('swarm-reply-m6'));
    await walk.shot('reply-bar');
    await tester.tap(walk.key('swarm-reply-cancel'));

    await tester.tap(walk.key('swarm-quote-m3'));
    await walk.wait(300);
    await walk.shot('quote-followed', settle: 0);

    await tester.enterText(find.byType(TextField), 'Sounds good.');
    await walk.wait(200);
    await tester.tap(walk.key('swarm-send'));
    await walk.shot('sending');
    posted.complete({'result': <String, dynamic>{}});
    await walk.wait();
  });

  testWidgets('the chat as it loads, reads back and starts', (tester) async {
    final walk = _Walk(tester, binding, 'loading');
    const conversation = 'g-build';
    const messages =
        '/api/super-tabs/$tab/conversations/$conversation/messages';
    final now = DateTime.now();
    const said = [
      'Build 214 is green on CI.',
      'The iPhone run starts after lunch, once the phone is plugged in.',
      'Jasper fixed the three review findings.',
      'Kai is checking the Android build.',
      'Release notes are drafted; I will ask you before we ship.',
    ];
    Map<String, dynamic> message(int sequence) => {
      'id': 'm$sequence',
      'conversationId': conversation,
      'text': said[sequence % said.length],
      'sequence': sequence,
      'author': {
        'kind': 'agent',
        'id': sequence.isEven ? 'agent-lead' : 'agent-jasper',
        'name': sequence.isEven ? 'River' : 'Jasper',
      },
      'attachments': <Object>[],
      'createdAt': now
          .subtract(Duration(minutes: 3 * (60 - sequence)))
          .toUtc()
          .toIso8601String(),
    };
    Map<String, dynamic> build(int newest) => groupData(
      conversation,
      title: 'Phone build',
      agentIds: ['agent-lead', 'agent-jasper'],
      status: 'working',
      workerId: 'agent-jasper',
      lastMessageSequence: newest,
    );

    final swarm = Completer<void>();
    final first = Completer<Object?>(), earlier = Completer<Object?>();
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) async {
      await swarm.future;
      return {
        ...firstLoad(
          agents: [
            agent('agent-lead', name: 'Lead', displayName: 'River'),
            agent('agent-jasper', displayName: 'Jasper'),
          ],
          groups: [
            build(40),
            groupData(
              'g-new',
              title: 'Release notes',
              agentIds: ['agent-lead'],
            ),
          ],
        ),
        'members': [part(me, 1, person(me))],
      };
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => first.future;
    fake.routes['$messages?before=21&beforeId=m21'] = (_) => earlier.future;
    fake.routes['/api/super-tabs/$tab/conversations/g-new/messages'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };

    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      _app(
        host,
        const SwarmConversationPage(swarmId: tab, conversationId: conversation),
      ),
    );
    await walk.waitFor(walk.key('swarm-chat-skeleton'));
    await walk.shot('skeleton-and-header');

    swarm.complete();
    await walk.waitFor(find.text('Phone build'));
    await walk.shot('skeleton');

    first.complete({
      'messages': [for (var i = 40; i > 20; i--) message(i)],
      'next': {'sequence': 21, 'id': 'm21'},
    });
    await walk.waitFor(walk.key('swarm-message-m40'));
    await walk.shot('read');

    // Reading back when a message arrives: it waits below.
    await tester.drag(walk.key('swarm-messages'), const Offset(0, 300));
    await walk.wait();
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c3',
      lastChangedAt: 200,
      groups: [part(conversation, 9, build(41))],
    );
    fake.routes['$messages?after=40'] = (_) => {
      'messages': [message(41)],
      'next': null,
    };
    await host.session!.inbox.reader(tab)!.refresh();
    await walk.waitFor(walk.key('swarm-new-pill'));
    await walk.shot('new-pill');

    await tester.drag(walk.key('swarm-messages'), const Offset(0, 4000));
    await walk.waitFor(walk.key('swarm-older-loading'));
    await walk.shot('earlier-loading');
    earlier.complete({
      'messages': [for (var i = 20; i > 0; i--) message(i)],
      'next': null,
    });
    await walk.wait();

    // Another chat, with nothing in it yet: the app built again around it,
    // as a navigator keeps its first page.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(
      _app(
        host,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g-new'),
      ),
    );
    await walk.waitFor(walk.key('swarm-chat-empty'));
    await walk.shot('empty');
  });

  testWidgets('each start screen', (tester) async {
    final walk = _Walk(tester, binding, 'start');
    const macAway = (name: 'MacBook Pro', away: true);
    const miniAway = (name: 'Mac mini', away: true);
    final cases = <(String, List<SwarmComputer>?, FakeSwarm Function())>[
      (
        'offline',
        [macAway, miniAway],
        () => FakeSwarm()
          ..routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
            'MACHINE_UNAVAILABLE',
            'Connect one of your computers to open Swarm.',
          ),
      ),
      (
        'no-computer',
        const [],
        () => FakeSwarm()
          ..routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
            'MACHINE_UNAVAILABLE',
            'Connect one of your computers to open Swarm.',
          ),
      ),
      ('no-swarm', [(name: 'MacBook Pro', away: false)], () => _empty()),
      (
        'invited',
        [(name: 'MacBook Pro', away: false)],
        () => _empty()
          ..routes['/api/super-tabs/invitations'] = (_) => [
            {
              'tabId': 'tab-team',
              'name': 'Autonomous team',
              'inviteId': 'invite-team',
              'role': 'collaborator',
              'expiresAt': 1893456000000,
            },
          ],
      ),
      (
        'invites-failed',
        [(name: 'MacBook Pro', away: false)],
        () => _empty()
          ..routes['/api/super-tabs/invitations'] = (_) =>
              throw const SuperTabFailure(
                'INTERNAL',
                'Something went wrong.',
                statusCode: 500,
              ),
      ),
    ];
    for (final (name, list, backend) in cases) {
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        notices: SilentSystemNotices(),
        features: features,
        computers: _Computers(list),
      )..foreground = false;
      final session = host.session!;
      await session.inbox.refresh();
      await tester.pumpWidget(
        _app(
          host,
          Builder(
            builder: (context) => Scaffold(
              // Home's ground, which the start screen stands on there.
              backgroundColor: Tty.of(context).ground,
              body: SafeArea(
                child: Builder(
                  builder: (context) => ListenableBuilder(
                    listenable: session.inbox,
                    builder: (context, _) =>
                        swarmStartView(context, session) ?? const SizedBox(),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await walk.shot(name);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }

    await tester.pumpWidget(
      _app(
        null,
        SwarmIntroPage(
          features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore()),
        ),
      ),
    );
    await walk.shot('intro');
  });
}

/// The account has no Swarm and no invitation.
FakeSwarm _empty() {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': <Object>[],
    'next': null,
  };
  fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
  return fake;
}

/// [home] in the phone's dark theme, with [host]'s Swarm over it.
Widget _app(SwarmHost? host, Widget home) => grid.BrightnessScope(
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: Brightness.dark),
    builder: (context, child) =>
        host == null ? child! : SwarmScope(notifier: host, child: child!),
    home: home,
  ),
);

class _Computers extends ChangeNotifier implements SwarmComputers {
  _Computers(this.computers);

  @override
  final List<SwarmComputer>? computers;

  @override
  bool get rechecking => false;

  @override
  Future<void> recheck() async {}

  @override
  void add(BuildContext context) {}
}

class _Walk {
  _Walk(this.tester, this.binding, this.name);

  final WidgetTester tester;
  final IntegrationTestWidgetsFlutterBinding binding;
  final String name;
  var _step = 0;

  Future<void> wait([int ms = 600]) async {
    for (var elapsed = 0; elapsed < ms; elapsed += 100) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> shot(String step, {int settle = 900}) async {
    await wait(settle);
    _step++;
    await binding.takeScreenshot(
      '$name-${_step.toString().padLeft(2, '0')}-$step',
    );
  }

  Future<void> waitFor(Finder finder, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      if (finder.evaluate().isNotEmpty) return;
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('never appeared: $finder');
  }

  Finder key(String value) => find.byKey(ValueKey(value));
}
