import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_buddies_page.dart';
import 'package:harness_mobile/swarm/swarm_buddy_list.dart';
import 'package:harness_mobile/swarm/swarm_chat_notify.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The chat menu's Notifications (the desktop's chat menu, #2453): ⋮ at the
/// end of a chat's header, its sheet with All new messages, Mentions only
/// and Muted, the reader's own ticked; a tap keeps it on every device.
void main() {
  const chat = 'g1';
  const notifications =
      '/api/super-tabs/$tab/conversations/$chat/notifications';
  const refused = SuperTabFailure(
    'FORBIDDEN',
    'You cannot read this Swarm.',
    statusCode: 403,
  );

  FakeSwarm backend({Map<String, String> settings = const {}}) {
    final fake = FakeSwarm();
    final derived = {if (settings.isNotEmpty) 'chatSettings': settings};
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [groupData(chat, title: 'Fix login', number: 7)],
      derived: derived,
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    fake.routes[notifications] = (body) => {'notify': body!['notify']};
    return fake;
  }

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: chat),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// The level ticked in the open sheet.
  String? ticked(WidgetTester tester) {
    for (final level in SwarmNotify.values) {
      final row = find.ancestor(
        of: find.text(level.label),
        matching: find.byType(Row),
      );
      if (find
          .descendant(of: row.first, matching: find.text('✓'))
          .evaluate()
          .isNotEmpty) {
        return level.label;
      }
    }
    return null;
  }

  Future<void> open(WidgetTester tester) async {
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
  }

  List<Map<String, dynamic>?> sent(FakeSwarm fake) => [
    for (final call in fake.calls)
      if (call.path == notifications) call.body,
  ];

  testWidgets('⋮ holds Notifications, the setting ticked; Muted is kept on '
      'every device and ticked next time', (tester) async {
    final fake = backend();
    await pump(tester, fake);

    await open(tester);
    expect(find.text('notifications'), findsOneWidget);
    for (final level in SwarmNotify.values) {
      expect(find.text(level.label), findsOneWidget);
    }
    expect(ticked(tester), 'Mentions only');

    await tester.tap(find.text('Muted'));
    await tester.pumpAndSettle();
    expect(find.text('notifications'), findsNothing, reason: 'sheet closed');
    expect(sent(fake), [
      {'notify': 'muted'},
    ]);
    expect(key('swarm-notify-failed'), findsNothing);

    await open(tester);
    expect(ticked(tester), 'Muted');
  });

  testWidgets('a setting made on the desktop is the one ticked', (
    tester,
  ) async {
    await pump(tester, backend(settings: {chat: 'all'}));

    await open(tester);
    expect(ticked(tester), 'All new messages');
  });

  testWidgets('refused: it says so, and the old setting is ticked again', (
    tester,
  ) async {
    final fake = backend();
    fake.routes[notifications] = (_) => throw const SuperTabFailure(
      'CHAT_SETTING_BUSY',
      'Busy',
      statusCode: 503,
    );
    await pump(tester, fake);

    await open(tester);
    await tester.tap(find.text('All new messages'));
    await tester.pumpAndSettle();
    expect(
      find.text('Could not change notifications. Try again.'),
      findsOneWidget,
    );

    await open(tester);
    expect(ticked(tester), 'Mentions only');
  });

  testWidgets('access lost while the sheet is open: it closes, and ⋮ goes', (
    tester,
  ) async {
    final fake = backend();
    final host = await pump(tester, fake);
    await open(tester);
    expect(find.text('Muted'), findsOneWidget);

    fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
    unawaited(host.session!.inbox.reader(tab)!.refresh());
    await tester.pumpAndSettle();

    expect(find.text('Muted'), findsNothing);
    expect(find.text('Fix login'), findsNothing, reason: 'nothing names it');
    expect(key('swarm-chat-menu'), findsNothing);
  });

  testWidgets('access lost while a choice is on its way: its answer shows '
      'nothing, no error either', (tester) async {
    final fake = backend();
    final answer = Completer<Object?>();
    fake.routes[notifications] = (_) => answer.future;
    final host = await pump(tester, fake);
    await open(tester);
    await tester.tap(find.text('Muted'));
    await tester.pumpAndSettle();

    host.session!.inbox.reader(tab)!.revoke();
    await tester.pumpAndSettle();
    answer.completeError(Exception('lost'));
    await tester.pumpAndSettle();

    expect(key('swarm-notify-failed'), findsNothing);
    expect(key('swarm-chat-menu'), findsNothing);
  });

  testWidgets('a muted Buddy chat on Buddies: greyed with a crossed bell, '
      'no dot', (tester) async {
    final row = SwarmBuddyRow(
      swarmId: tab,
      project: SuperTabProject.fromJson({
        'id': project,
        'name': 'Mobile',
        'ownerId': me,
        'leadConversationId': leadChat,
        'visibility': 'public',
        'members': <Object>[],
      }),
      name: 'Wren',
      muted: true,
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SwarmBuddiesRow(
            row: row,
            line: 'Done',
            now: DateTime.utc(2026, 11, 1),
            onTap: () {},
          ),
        ),
      ),
    );

    expect(key('swarm-buddies-muted-${row.key}'), findsOneWidget);
    expect(key('swarm-buddies-unread-${row.key}'), findsNothing);
  });
}
