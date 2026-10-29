import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

const other = 'person-tony';

/// The ways to a profile: the "You" row at the top of the menu opens one's
/// own, and a person's face in a chat opens theirs — one's own with Edit.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(groups: [groupData('g1', title: 'Fix login', number: 4)]),
      'members': [
        part(me, 1, {
          ...person(me),
          'avatar': {'kind': 'preset', 'key': 'fox'},
          'status': {'text': 'Focusing', 'emoji': '🎯', 'until': null},
        }),
        part(other, 1, {
          ...person(other, role: 'collaborator'),
          'status': {'text': 'At lunch', 'emoji': '🍽️', 'until': null},
        }),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/groups'] = (_) => {
      'groups': <Object>[],
      'next': null,
    };
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'msg-1',
          'conversationId': 'g1',
          'text': 'Ship it today?',
          'sequence': 1,
          'author': {'kind': 'person', 'id': other, 'name': '$other@x.io'},
          'createdAt': '2026-10-27T01:00:00.000Z',
        },
        {
          'id': 'msg-2',
          'conversationId': 'g1',
          'text': 'Yes.',
          'sequence': 2,
          'author': {'kind': 'person', 'id': me, 'name': '$me@x.io'},
          'createdAt': '2026-10-27T01:01:00.000Z',
        },
      ],
      'next': null,
    };
    return fake;
  }

  Future<void> pump(WidgetTester tester, Widget home) async {
    tester.view.physicalSize = const Size(1170, 2532);
    addTearDown(tester.view.reset);
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: backend().request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
      ),
    );
    await frames(tester);
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder inside(String value, Finder finder) =>
      find.descendant(of: key(value), matching: finder);

  testWidgets('the menu starts with you, and opens your profile', (
    tester,
  ) async {
    await pump(tester, const SwarmPage());
    await tester.tap(key('swarm-menu'));
    await frames(tester);
    expect(inside('swarm-drawer-you-$tab', find.text('🦊')), findsOneWidget);
    expect(
      inside('swarm-drawer-you-$tab', find.text('🎯 Focusing')),
      findsOneWidget,
    );
    expect(
      tester.getSize(key('swarm-drawer-you-$tab')).height,
      greaterThanOrEqualTo(44),
    );
    await tester.tap(key('swarm-drawer-you-$tab'));
    await frames(tester);
    expect(find.text('Your profile'), findsOneWidget);
  });

  testWidgets("a person's face in a chat opens who they are", (tester) async {
    await pump(
      tester,
      const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
    );
    final face = key('swarm-author-msg-1');
    expect(tester.getSize(face).width, greaterThanOrEqualTo(44));
    expect(tester.getSize(face).height, greaterThanOrEqualTo(44));
    await tester.tap(face);
    await frames(tester);
    expect(inside('swarm-person', find.text('person-tony')), findsOneWidget);
    expect(inside('swarm-person', find.text('🍽️ At lunch')), findsOneWidget);
    expect(
      inside('swarm-person', find.text('person-tony@example.com')),
      findsOneWidget,
    );
    expect(key('swarm-person-edit'), findsNothing);
  });

  testWidgets('who they are is dimmed as every sheet is and inset 16 across '
      'and 24 below, with the name a heading of 17, its status a body of 17 '
      'and its email and role captions of 13', (tester) async {
    await pump(
      tester,
      const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
    );
    await tester.tap(key('swarm-author-msg-1'));
    await frames(tester);

    expect(
      ModalRoute.of(tester.element(key('swarm-person')))!.barrierColor,
      Colors.black54,
    );
    expect(
      tester.widget<Padding>(key('swarm-person')).padding,
      const EdgeInsets.fromLTRB(16, 8, 16, 24),
    );
    final grabber = find.byWidgetPredicate(
      (w) => w is Container && w.constraints?.maxWidth == 36,
    );
    expect(
      tester.getSize(
        find.descendant(of: grabber, matching: find.byType(DecoratedBox)),
      ),
      const Size(36, 4),
    );
    expect(
      tester.widget<Container>(grabber).margin,
      const EdgeInsets.only(bottom: 16),
    );
    TextStyle styleOf(String text) =>
        tester.widget<Text>(inside('swarm-person', find.text(text))).style!;
    expect(styleOf('person-tony').fontSize, 17);
    expect(styleOf('person-tony').fontWeight, FontWeight.w600);
    expect(styleOf('🍽️ At lunch').fontSize, 17);
    for (final line in ['person-tony@example.com', 'Collaborator']) {
      expect(styleOf(line).fontSize, 13, reason: line);
    }
  });

  testWidgets('your own face opens yours, with Edit profile', (tester) async {
    await pump(
      tester,
      const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
    );
    await tester.tap(key('swarm-author-msg-2'));
    await frames(tester);
    expect(inside('swarm-person', find.text('🎯 Focusing')), findsOneWidget);
    await tester.tap(key('swarm-person-edit'));
    await frames(tester);
    expect(find.text('Your profile'), findsOneWidget);
    expect(key('swarm-person'), findsNothing);
  });
}

/// A second of frames, for screens whose skeletons never settle.
Future<void> frames(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
