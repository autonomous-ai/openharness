import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_face.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

const leadPhoto = 'https://storage.googleapis.com/avatars/river.png?sig=1';
const buddyPhoto = 'https://storage.googleapis.com/avatars/wren.png?sig=1';

/// The faces people and agents chose, on the screens that showed only
/// initials: Home's Buddies, the project page's work and team, and the
/// chat's messages — with a person's status emoji beside their own.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  /// With [buddy], the person's Buddy Wren wears an uploaded photo in its
  /// chat.
  FakeSwarm backend({bool buddy = false}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    final derived = {
      'avatars': {
        'agent:agent-lead': leadPhoto,
        if (buddy) 'agent:agent-wren': buddyPhoto,
      },
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        derived: derived,
        agents: [
          {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'avatar': {'kind': 'upload'},
          },
          {
            ...agent('agent-builder', displayName: 'Nova'),
            'avatar': {'kind': 'preset', 'key': 'owl'},
          },
          agent('agent-plain', displayName: 'Pike'),
          if (buddy)
            {
              ...buddyData('agent-wren', displayName: 'Wren'),
              'avatar': {'kind': 'upload'},
            },
        ],
        groups: [
          if (buddy) buddyChatData('buddy-me', agentIds: ['agent-wren']),
          groupData(
            'g1',
            title: 'Fix login',
            number: 4,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
          ),
          groupData(
            'g2',
            title: 'Sync',
            number: 5,
            agentIds: ['agent-plain'],
            status: 'working',
            workerId: 'agent-plain',
          ),
        ],
      ),
      'members': [
        part(me, 1, {
          ...person(me),
          'avatar': {'kind': 'preset', 'key': 'fox'},
          'status': {'text': 'Focusing', 'emoji': '🎯', 'until': null},
        }),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/groups'] = (_) => {
      'groups': <Object>[],
      'next': null,
    };
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'msg-1',
          'conversationId': 'g1',
          'text': 'Which name should the flag have?',
          'sequence': 1,
          'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
          'createdAt': '2026-10-27T01:00:00.000Z',
        },
        {
          'id': 'msg-2',
          'conversationId': 'g1',
          'text': 'Call it beta.',
          'sequence': 2,
          'author': {'kind': 'person', 'id': me, 'name': '$me@example.com'},
          'createdAt': '2026-10-27T01:01:00.000Z',
        },
      ],
      'next': null,
    };
    return fake;
  }

  /// Links an uploaded picture was asked from.
  final asked = <Uri>[];

  Future<void> pump(
    WidgetTester tester,
    Widget home, {
    bool buddy = false,
  }) async {
    asked.clear();
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: backend(buddy: buddy).request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    final images = <Uri, ImageProvider>{};
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(
          notifier: host,
          child: SwarmAvatarImages(
            image: (url) {
              if (!asked.contains(url)) asked.add(url);
              return images[url] ??= MemoryImage(Uint8List(0));
            },
            child: child!,
          ),
        ),
        home: home,
      ),
    );
    // A skeleton breathes while it shows: frames until the page is read.
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Finder within(String key, Finder finder) =>
      find.descendant(of: find.byKey(ValueKey(key)), matching: finder);

  testWidgets("Home's Buddies show the Buddy's uploaded picture", (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    addTearDown(tester.view.reset);
    await pump(tester, const SwarmPage(), buddy: true);
    expect(
      within('swarm-home-buddy-$tab-$project', find.byType(SwarmAvatar)),
      findsOneWidget,
    );
    expect(asked, [Uri.parse(buddyPhoto)]);
  });

  testWidgets("the project's work shows each worker's chosen face", (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    addTearDown(tester.view.reset);
    await pump(
      tester,
      const SwarmProjectPage(swarmId: tab, projectId: project),
    );
    await tester.tap(find.byKey(const ValueKey('swarm-project-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('swarm-project-menu-status')));
    await tester.pumpAndSettle();
    expect(within('swarm-conversation-g1', find.text('🦉')), findsOneWidget);
    // Nobody chose one: the initial, as before.
    expect(within('swarm-conversation-g2', find.text('P')), findsOneWidget);
    expect(within('swarm-conversation-g2', find.text('🦉')), findsNothing);
  });

  testWidgets("a chat shows each author's face and a person's status", (
    tester,
  ) async {
    await pump(
      tester,
      const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
    );
    expect(within('swarm-message-msg-1', find.text('🦉')), findsOneWidget);
    expect(within('swarm-message-msg-2', find.text('🦊')), findsOneWidget);
    expect(within('swarm-message-msg-2', find.text('🎯')), findsOneWidget);
    expect(within('swarm-message-msg-1', find.text('🎯')), findsNothing);
  });
}
