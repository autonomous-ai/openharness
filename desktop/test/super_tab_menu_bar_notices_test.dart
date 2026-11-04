import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/state/status_menu.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/message_link.dart'
    show swarmMessageLinkInbox;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/activity_view.dart';
import 'package:harness/super_tabs/notifications.dart';
import 'package:harness/super_tabs/reminders.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show MemoryStore;

const otherId = 'fedcba9876543210fedcba98';

/// The fixture's machine, answering a second Swarm, [otherId], from a server
/// of its own: a tag and a decision wait there too.
class TwoSwarms extends SuperTabFixtureConnection {
  TwoSwarms(super.store) : super(local: true) {
    other.state['id'] = otherId;
    other
      ..tag('message-1', text: 'In Atlas')
      ..ask(['Atlas question?']);
  }
  final other = ConversationServer();

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'super_tabs' &&
        payload['action'] == 'backend' &&
        (payload['path'] as String).startsWith('/api/super-tabs/$otherId')) {
      final body = payload['body'];
      return {
        'ok': true,
        'value': await other.request(
          payload['method'] as String,
          payload['path'] as String,
          body: body is Map ? Map<String, dynamic>.from(body) : null,
        ),
      };
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

/// The fixture's machine, whose Swarm stops answering the person's tag list
/// when [refusal] is set: refused (403) or failing (503).
class RefusingTags extends SuperTabFixtureConnection {
  RefusingTags(super.store) : super(local: true);
  SuperTabFailure? refusal;

  /// Refuse every tag read after the next successful waiting list (review of
  /// #2088: permission lost between two reads).
  bool refuseAfterNextWaiting = false;

  /// The waiting lists the server answered.
  var waitingReads = 0;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final path = payload['path'] as String? ?? '';
    if (refusal case final failure?
        when type == 'super_tabs' && path.contains('/mentions?')) {
      throw failure;
    }
    final answer = await super.request(
      type,
      payload: payload,
      timeout: timeout,
    );
    if (type == 'super_tabs' && path.contains('/mentions?state=waiting')) {
      waitingReads++;
      if (refuseAfterNextWaiting) {
        refuseAfterNextWaiting = false;
        refusal = const SuperTabFailure(
          'FORBIDDEN',
          'No longer permitted',
          statusCode: 403,
        );
      }
    }
    return answer;
  }
}

/// The fixture's machine, holding the answer to the next waiting-tag read
/// until [releaseOld] completes: an older refresh still on its way (review of
/// #2088).
class StaleTagRefresh extends SuperTabFixtureConnection {
  StaleTagRefresh(super.store) : super(local: true);
  bool holdNextWaiting = false;
  Completer<void>? releaseOld;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final hold =
        holdNextWaiting &&
        type == 'super_tabs' &&
        (payload['path'] as String? ?? '').contains('/mentions?state=waiting');
    if (hold) holdNextWaiting = false;
    final answer = await super.request(
      type,
      payload: payload,
      timeout: timeout,
    );
    if (hold) {
      releaseOld = Completer<void>();
      await releaseOld!.future;
    }
    return answer;
  }
}

/// A Swarm open in a tab of [f]'s app, with a tag and a decision waiting.
Future<void> openWithNotices(SuperTabLaunchFixture f) async {
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  f.connection.server
    ..tag('message-1', text: 'Please confirm the release.')
    ..ask(['Ship it behind a flag?']);
  await c.refresh();
  await SuperTabMentions.of(c).load();
  await SuperTabDecisions.of(c).load();
}

/// The app's notifications as the macOS runner answers them, on any computer:
/// a click comes back on `harness/notifications` (Linux CI picks its own
/// notifier otherwise, which hears no such click).
SystemNotifications clicks() => SystemNotifications(
  store: DesktopNotificationStore(storage: MemoryStore()),
  notifier: MacSystemNotifier(),
);

/// A Swarm open in a tab of [f]'s app with one of everything Activity lists
/// (task #2914): a due reminder, an agent waiting on the reader, a decision,
/// an unread tag in a chat held, one answered elsewhere but unread, and one in
/// a quiet chat the snapshot does not hold.
Future<SuperTabActivity> openWithEverything(SuperTabLaunchFixture f) async {
  final server = f.connection.server;
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  server.state['agents'] = [
    {
      'id': 'kestrel',
      'projectId': 'lead',
      'name': 'Builder',
      'displayName': 'Kestrel',
      'machineId': 'host',
      'harnessId': 'session',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  final offline = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((g) => g['id'] == 'offline');
  offline
    ..['agentIds'] = ['kestrel']
    ..['assignment'] = {
      'id': 'a1',
      'agentId': 'kestrel',
      'status': 'needs_human',
      'askedOf': 'owner',
      'result': 'Which port should the preview use?',
    };
  server
    ..append('Look at the preview again')
    ..remindElsewhere(
      'message-${server.revision}',
      DateTime.now().subtract(const Duration(minutes: 1)),
    )
    ..ask(['Ship it behind a flag?'])
    ..append('Please confirm the release.')
    ..tag(
      'message-${server.revision}',
      text: 'Please confirm the release.',
      createdAt: '2026-10-24T07:00:00Z',
      messageSequence: server.revision,
    )
    ..append('Answered on the phone')
    ..tag(
      'message-${server.revision}',
      text: 'Answered on the phone',
      createdAt: '2026-10-24T06:00:00Z',
      messageSequence: server.revision,
    )
    ..tag(
      'message-quiet',
      conversationId: 'quiet',
      text: 'In a quiet chat',
      createdAt: '2026-10-24T05:00:00Z',
      messageSequence: 3,
    );
  // The second tag was answered elsewhere: resolved, still unread here.
  server.mentions[1]
    ..['resolvedAt'] = '2026-10-24T06:30:00Z'
    ..['resolvedBy'] = 'answered';
  server.state['mentionsWaiting'] = 2;
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  final activity = SuperTabActivity.of(c);
  await activity.mentions.load();
  await activity.decisions.load();
  await SuperTabReminders.of(c).load();
  return activity;
}

/// What the menu bar's Swarm section lists, as (kind, id).
List<(Object?, Object?)> menuRows(SuperTabLaunchFixture f) => [
  for (final r in statusMenuSwarmEntries(f.app)) (r['kind'], r['id']),
];

/// Everything [openWithEverything] lists, in Activity's order.
const everything = [
  ('reminder', 'reminder-message-1'),
  ('agent', 'offline'),
  ('decision', 'decision-1'),
  ('mention', 'mention-1'),
  ('mention', 'mention-2'),
  ('mention', 'mention-3'),
];

void main() {
  test('the menu bar lists what needs the person in each Swarm: decisions, '
      'then tags, with where they were asked', () async {
    final f = SuperTabLaunchFixture(local: true);
    expect(statusMenuSwarmEntries(f.app), isEmpty);
    await openWithNotices(f);
    final rows = statusMenuSwarmEntries(f.app);
    expect(rows.map((r) => (r['kind'], r['title'], r['message'])), [
      ('decision', 'Wren asks you', 'Ship it behind a flag?'),
      ('mention', 'Wren tagged you', 'Please confirm the release.'),
    ]);
    for (final row in rows) {
      expect(row['swarmTabId'], tabId);
      expect(row['tabName'], 'Pilot');
      expect(row['detail'], 'web-project · Lead');
      expect(row['unread'], isTrue);
      expect(row['receivedAt'], isA<int>());
    }
    expect(rows.first['id'], 'decision-1');
    expect(rows.last['id'], 'mention-1');
  });

  test('a tag read past leaves the menu bar\'s Swarm rows', () async {
    final f = SuperTabLaunchFixture(local: true);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    f.connection.server.tag('message-1', messageSequence: 5);
    Future<List<Object?>> kinds(int mark) async {
      f.connection.server.markReadElsewhere('lead', mark);
      await c.refresh();
      await SuperTabMentions.of(c).load();
      return [for (final r in statusMenuSwarmEntries(f.app)) r['kind']];
    }

    expect(await kinds(4), ['mention']);
    expect(await kinds(5), isEmpty);
  });

  group('a conversation the person can no longer read', () {
    /// A tag and a decision in "Offline editing", then that conversation
    /// leaves what this account reads.
    Future<SuperTabLaunchFixture> askedInOffline() async {
      final f = SuperTabLaunchFixture(local: true);
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      f.connection.server
        ..tag('message-1', conversationId: 'offline', text: 'Private tag')
        ..ask(['Private question?'], conversationId: 'offline');
      await c.refresh();
      await SuperTabMentions.of(c).load();
      await SuperTabDecisions.of(c).load();
      expect(statusMenuSwarmEntries(f.app), hasLength(2));
      (f.connection.server.state['conversations'] as List).removeWhere(
        (g) => (g as Map)['id'] == 'offline',
      );
      return f;
    }

    test('with its lists still holding it, it is in the menu as in '
        'Activity: both or neither (#2914)', () async {
      final f = await askedInOffline();
      final c = f.app.superTabs.peek(tabId)!;
      await c.refresh();
      expect(c.snapshot!.conversation('offline'), isNull);
      final activity = SuperTabActivity.of(c);
      expect(activity.count, 2);
      expect(menuRows(f), [
        for (final n in activity.notices) (n.kind.name, n.id),
      ]);
      expect(menuRows(f), hasLength(2));
    });

    test('stays out while the new lists are slow to come', () async {
      final f = await askedInOffline();
      final server = f.connection.server;
      server.parts.epoch++;
      server
        ..holdMentions = Completer<void>()
        ..holdDecisions = Completer<void>();
      final c = f.app.superTabs.peek(tabId)!;
      await c.refresh();
      await pumpEventQueue();
      expect(statusMenuSwarmEntries(f.app), isEmpty);
      expect(SuperTabMentions.of(c).waiting, isEmpty);
      expect(SuperTabDecisions.of(c).open, isEmpty);
      server.holdMentions!.complete();
      server.holdDecisions!.complete();
    });

    test('stays out when the new lists fail', () async {
      final f = await askedInOffline();
      final server = f.connection.server;
      server.parts.epoch++;
      server
        ..failMentions = true
        ..failDecisions = true;
      final c = f.app.superTabs.peek(tabId)!;
      await c.refresh();
      await pumpEventQueue();
      expect(statusMenuSwarmEntries(f.app), isEmpty);
    });
  });

  testWidgets(
    'with two Swarms, each one\'s rows and View all open in that Swarm',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final f = SuperTabLaunchFixture(connectionFactory: TwoSwarms.new);
      await tester.runAsync(() => openWithNotices(f));
      final first = f.app.activeSwarmId;
      f.app.newSwarm(name: 'Second');
      f.app.bindSuperTab(f.app.activeSwarmId, otherId, 'Atlas');
      final second = f.app.activeSwarmId;
      await tester.runAsync(() async {
        final c = await f.app.superTabs.open(otherId);
        await c.refresh();
        await SuperTabMentions.of(c).load();
        await SuperTabDecisions.of(c).load();
      });
      f.app.newSwarm(name: 'Desktop');
      await mount(tester, f.app, nativeTabs: true);
      await tester.pump();
      final rows = (updates.last['statusMenuSwarmEntries'] as List).cast<Map>();
      expect(rows.map((r) => r['swarmTabId']), [
        tabId,
        tabId,
        otherId,
        otherId,
      ]);
      Future<void> choose(Map receipt) async {
        messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('openSwarmNotice', receipt),
          ),
          (_) {},
        );
        await tester.pump();
        await tester.pump();
      }

      await choose(rows.last);
      expect(f.app.activeSwarmId, second);
      await choose({'swarmTabId': tabId, 'kind': 'all', 'id': ''});
      expect(f.app.activeSwarmId, first);
      await choose({'swarmTabId': otherId, 'kind': 'all', 'id': ''});
      expect(f.app.activeSwarmId, second);
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  test('none from a Swarm this account lost, and none signed out', () async {
    final f = SuperTabLaunchFixture(local: true);
    await openWithNotices(f);
    final c = f.app.superTabs.peek(tabId)!;
    c.accessRevoked = true;
    expect(statusMenuSwarmEntries(f.app), isEmpty);
    c.accessRevoked = false;
    f.app.currentUser = null;
    expect(statusMenuSwarmEntries(f.app), isEmpty);
  });

  test(
    'the app hears when a Swarm\'s list of tags or decisions arrives',
    () async {
      final f = SuperTabLaunchFixture(local: true);
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      var heard = 0;
      f.app.addListener(() => heard++);
      f.connection.server.ask(['Ship it behind a flag?']);
      await SuperTabDecisions.of(c).load();
      expect(heard, greaterThan(0));
    },
  );

  group('choosing a row', () {
    Future<SuperTabView> showView(
      WidgetTester tester,
      ConversationServer server,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1200, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller();
      await c.refresh();
      final view = SuperTabView(
        controller: c,
        onInvite: () {},
        onAddAgent: (_) {},
        onOpenTerminal: (_) {},
        machineName: (_) => 'Team Mac',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(body: view),
        ),
      );
      await tester.pumpAndSettle();
      return view;
    }

    Future<void> close(WidgetTester tester, SuperTabView view) async {
      await tester.pumpWidget(const SizedBox());
      await view.controller.flush();
      view.controller.dispose();
    }

    testWidgets('a tag opens its conversation at the tagged message', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append('Please confirm the release.')
        ..tag('message-1');
      final view = await showView(tester, server);
      final c = view.controller;
      await SuperTabMentions.of(c).load();
      c.select('offline');
      await tester.pumpAndSettle();
      c.openNotice('mention', 'mention-1');
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      expect(c.noticeRequest, isNull);
      expect(find.byType(SuperTabActivityView), findsNothing);
      expect(find.text('Please confirm the release.'), findsWidgets);
      await close(tester, view);
    });

    testWidgets('a decision opens the Swarm\'s notifications, where it is '
        'answered', (tester) async {
      final server = ConversationServer()..ask(['Ship it behind a flag?']);
      final view = await showView(tester, server);
      final c = view.controller;
      c.openNotice('decision', 'decision-1');
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabActivityView), findsOneWidget);
      expect(find.text('Ship it behind a flag?'), findsOneWidget);
      expect(c.noticeRequest, isNull);
      await close(tester, view);
    });

    testWidgets('from the menu bar: its Swarm tab comes forward and opens it', (
      tester,
    ) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final f = SuperTabLaunchFixture(local: true);
      await tester.runAsync(() => openWithNotices(f));
      final swarmTab = f.app.activeSwarmId;
      f.app.newSwarm(name: 'Desktop');
      await mount(tester, f.app, nativeTabs: true);
      await tester.pump();
      final rows = (updates.last['statusMenuSwarmEntries'] as List).cast<Map>();
      expect(rows, hasLength(2));
      final done = Completer<void>();
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('openSwarmNotice', rows.first),
        ),
        (_) => done.complete(),
      );
      await tester.pump();
      await tester.pump();
      expect(f.app.activeSwarmId, swarmTab);

      // View all: the Swarm's Notifications page, which lists them all.
      f.app.selectSwarm(f.app.swarms.last.id);
      await tester.pump();
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('openSwarmNotice', {
            'swarmTabId': tabId,
            'kind': 'all',
            'id': '',
          }),
        ),
        (_) {},
      );
      await tester.pump();
      await tester.pump();
      expect(f.app.activeSwarmId, swarmTab);
      await tester.pumpWidget(const SizedBox());
      expect(updates.last['statusMenuSwarmEntries'], isNull);
      f.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

    /// Mounts [f]'s app with its windows answering, and clicks a tag's system
    /// notice (or another Swarm notice, by its [machine] slot) as the macOS
    /// runner sends it back.
    Future<Future<void> Function(String agentId, {String machine})> clicker(
      WidgetTester tester,
      SuperTabLaunchFixture f,
    ) async {
      final messenger = tester.binding.defaultBinaryMessenger;
      for (final (name, answer) in [
        ('harness/swarm_tabs', (MethodCall call) async => true),
        // The click raises the window first; it answers as a shown one.
        (
          'window_manager',
          (MethodCall call) async =>
              call.method == 'isMinimized' ? false : null,
        ),
      ]) {
        final channel = MethodChannel(name);
        messenger.setMockMethodCallHandler(channel, answer);
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      }
      await mount(tester, f.app, nativeTabs: true);
      await tester.pump();
      return (
        agentId, {
        String machine = SystemNotifications.mentionNoticeMachine,
      }) async {
        messenger.handlePlatformMessage(
          'harness/notifications',
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('tapped', {'machineId': machine, 'agentId': agentId}),
          ),
          (_) {},
        );
        // The Swarm loads and its tags are read from the server first; then
        // its view reads the tagged message's page.
        for (var i = 0; i < 6; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)),
          );
          await tester.pump();
        }
      };
    }

    /// A tag of the person in [server]'s `offline` group, away from the group
    /// a Swarm opens on: the server's second tag, `mention-2`.
    void tagInOffline(ConversationServer server) => server
      ..append('Can you check offline sync?', conversationId: 'offline')
      ..tag(server.messages.last['id'] as String, conversationId: 'offline');

    testWidgets(
      'a click on a tag\'s system notification brings its Swarm tab forward '
      'and opens the tagged message',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: TwoSwarms.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        final swarmTab = f.app.activeSwarmId;
        tagInOffline(f.connection.server);
        f.app.newSwarm(name: 'Desktop');
        final click = await clicker(tester, f);
        final c = f.app.superTabs.peek(tabId)!;
        // A tag no longer waiting for the person opens nothing.
        await click('$tabId/gone');
        expect(f.app.activeSwarmId, isNot(swarmTab));
        await click('$tabId/mention-2');
        expect(f.app.activeSwarmId, swarmTab);
        // Its view takes the request and opens the tagged message's group.
        expect(c.noticeRequest, isNull);
        expect(c.selectedId, 'offline');
        // The read marker's save settles.
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    // Diego (11-03): a chat's New messages notice opened nothing; it carried
    // no Swarm or chat, so the click never reached the app.
    testWidgets(
      'a click on a chat\'s New messages notification brings its Swarm tab '
      'forward and opens that chat',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: TwoSwarms.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        final swarmTab = f.app.activeSwarmId;
        f.app.newSwarm(name: 'Desktop');
        final click = await clicker(tester, f);
        final c = f.app.superTabs.peek(tabId)!;
        // A chat the person can no longer read opens nothing.
        await click('$tabId/gone', machine: '@chat');
        expect(f.app.activeSwarmId, isNot(swarmTab));
        await click('$tabId/offline', machine: '@chat');
        expect(f.app.activeSwarmId, swarmTab);
        expect(c.selectedId, 'offline');
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    // Task #2745: a reply's notice opens the reply in its thread, as its
    // message link does (message_link_host.dart opens what waits).
    testWidgets(
      'a click on a reply\'s notification hands its message link over',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: TwoSwarms.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        final click = await clicker(tester, f);
        final url = 'harness://swarm/$tabId/offline/message-1';
        addTearDown(() {
          for (final link in [...swarmMessageLinkInbox.pending]) {
            swarmMessageLinkInbox.complete(link);
          }
        });
        await click(url, machine: SystemNotifications.messageNoticeMachine);
        expect(swarmMessageLinkInbox.pending.map((l) => l.url), [url]);
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'a click on a tag in a Swarm not loaded yet loads it, checks the tag, '
      'and opens it',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: TwoSwarms.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        f.app.newSwarm(name: 'Atlas');
        f.app.bindSuperTab(f.app.activeSwarmId, otherId, 'Atlas');
        final atlas = f.app.activeSwarmId;
        f.app.newSwarm(name: 'Desktop');
        tagInOffline((f.connection as TwoSwarms).other);
        expect(f.app.superTabs.peek(otherId), isNull);
        final click = await clicker(tester, f);
        await click('$otherId/mention-2');
        expect(f.app.activeSwarmId, atlas);
        final c = f.app.superTabs.peek(otherId)!;
        expect(c.noticeRequest, isNull);
        expect(c.selectedId, 'offline');
        // The read marker's save settles.
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'a click on a tag in a closed Swarm tab reopens it at the tag; one no '
      'longer waiting reopens nothing',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: TwoSwarms.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        f.app.newSwarm(name: 'Atlas');
        f.app.bindSuperTab(f.app.activeSwarmId, otherId, 'Atlas');
        final atlas = f.app.activeSwarmId;
        await tester.runAsync(() async {
          await f.app.superTabs.open(otherId);
          await f.app.requestCloseSwarm(atlas);
          for (var i = 0; i < 20; i++) {
            await Future<void>.value();
          }
        });
        expect(f.app.closedSuperTabs.map((t) => t.id), [otherId]);
        tagInOffline((f.connection as TwoSwarms).other);
        final before = f.app.activeSwarmId;
        final click = await clicker(tester, f);

        await click('$otherId/gone');
        expect(f.app.activeSwarmId, before);
        expect(f.app.closedSuperTabs.map((t) => t.id), [otherId]);
        // What was loaded to check is let go again.
        expect(f.app.superTabs.peek(otherId), isNull);

        await click('$otherId/mention-2');
        expect(f.app.activeSwarm.superTabId, otherId);
        expect(f.app.closedSuperTabs, isEmpty);
        final c = f.app.superTabs.peek(otherId)!;
        expect(c.noticeRequest, isNull);
        expect(c.selectedId, 'offline');
        // The read marker's save settles.
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'a click on a tag in a Swarm this account is not in opens nothing',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: TwoSwarms.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        f.app.newSwarm(name: 'Desktop');
        final before = f.app.activeSwarmId;
        final click = await clicker(tester, f);
        await click('$otherId/mention-1');
        expect(f.app.activeSwarmId, before);
        expect(f.app.superTabs.peek(otherId), isNull);
        // The read marker's save settles.
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    for (final (name, refusal) in [
      (
        'refused',
        const SuperTabFailure(
          'FORBIDDEN',
          'No longer permitted',
          statusCode: 403,
        ),
      ),
      (
        'failing',
        const SuperTabFailure('UNAVAILABLE', 'Try again', statusCode: 503),
      ),
    ]) {
      testWidgets(
        'a click whose fresh tag check is $name opens nothing, though the tag '
        'waits in what was read before',
        (tester) async {
          final f = SuperTabLaunchFixture(
            connectionFactory: RefusingTags.new,
            systemNotifications: clicks(),
          );
          await tester.runAsync(() => openWithNotices(f));
          f.app.newSwarm(name: 'Desktop');
          final before = f.app.activeSwarmId;
          expect(
            SuperTabMentions.of(f.app.superTabs.peek(tabId)!).waiting
                .map((m) => m.id),
            ['mention-1'],
          );
          (f.connection as RefusingTags).refusal = refusal;
          final click = await clicker(tester, f);
          await click('$tabId/mention-1');
          expect(f.app.activeSwarmId, before);
          expect(f.app.superTabs.peek(tabId)!.noticeRequest, isNull);
          await tester.pump(const Duration(seconds: 1));
          await tester.pumpWidget(const SizedBox());
          f.dispose();
        },
        variant: TargetPlatformVariant.only(TargetPlatform.macOS),
      );
    }

    testWidgets(
      'a click that opens nothing lets go of a Swarm it loaded for a tab not '
      'shown yet',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: TwoSwarms.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        f.app.newSwarm(name: 'Atlas');
        f.app.bindSuperTab(f.app.activeSwarmId, otherId, 'Atlas');
        f.app.newSwarm(name: 'Desktop');
        final before = f.app.activeSwarmId;
        expect(f.app.superTabs.peek(otherId), isNull);
        final click = await clicker(tester, f);
        await click('$otherId/gone');
        expect(f.app.activeSwarmId, before);
        expect(f.app.superTabs.peek(otherId), isNull);
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'a click opens from the one read that confirmed the tag: a refusal '
      'after it changes nothing, as no second read decides',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: RefusingTags.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        tagInOffline(f.connection.server);
        final swarmTab = f.app.activeSwarmId;
        f.app.newSwarm(name: 'Desktop');
        final click = await clicker(tester, f);
        final connection = f.connection as RefusingTags;
        final c = f.app.superTabs.peek(tabId)!;
        // What was read before does not hold the new tag: only the click's
        // own read can supply it.
        expect(SuperTabMentions.of(c).waiting.map((m) => m.id), ['mention-1']);
        final reads = connection.waitingReads;
        connection.refuseAfterNextWaiting = true;
        await click('$tabId/mention-2');
        expect(connection.waitingReads, reads + 1);
        expect(f.app.activeSwarmId, swarmTab);
        expect(c.noticeRequest, isNull);
        expect(c.selectedId, 'offline');
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'an older tag refresh still on its way cannot replace the read that '
      'confirmed the click',
      (tester) async {
        final f = SuperTabLaunchFixture(
          connectionFactory: StaleTagRefresh.new,
          systemNotifications: clicks(),
        );
        await tester.runAsync(() => openWithNotices(f));
        final swarmTab = f.app.activeSwarmId;
        f.app.newSwarm(name: 'Desktop');
        final click = await clicker(tester, f);
        final connection = f.connection as StaleTagRefresh;
        final c = f.app.superTabs.peek(tabId)!;
        final tags = SuperTabMentions.of(c);
        // A refresh read before the new tag, answering only after the click's.
        connection.holdNextWaiting = true;
        final refresh = tags.load();
        for (var i = 0; i < 8; i++) {
          await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        }
        expect(connection.releaseOld, isNotNull);
        tagInOffline(connection.server);
        void releaseStale() {
          if (tags.waiting.any((m) => m.id == 'mention-2') &&
              !connection.releaseOld!.isCompleted) {
            connection.releaseOld!.complete();
          }
        }

        tags.addListener(releaseStale);
        await click('$tabId/mention-2');
        await tester.runAsync(() => refresh);
        tags.removeListener(releaseStale);
        expect(f.app.activeSwarmId, swarmTab);
        expect(c.noticeRequest, isNull);
        expect(c.selectedId, 'offline');
        // The older answer did not take the tag away afterwards either.
        expect(tags.waiting.map((m) => m.id), contains('mention-2'));
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  });

  group('the menu bar draws Activity\'s one list (#2914)', () {
    test('the same rows, in Activity\'s order: Needs you, then every unread '
        'tag', () async {
      final f = SuperTabLaunchFixture(local: true);
      await openWithEverything(f);
      expect(menuRows(f), everything);
    });

    test('its count is Activity\'s red number', () async {
      final f = SuperTabLaunchFixture(local: true);
      final activity = await openWithEverything(f);
      expect(activity.count, everything.length);
      expect(statusMenuSwarmEntries(f.app), hasLength(activity.count));
    });

    test(
      'a tag in a quiet chat the snapshot does not hold is in both',
      () async {
        final f = SuperTabLaunchFixture(local: true);
        final activity = await openWithEverything(f);
        expect(activity.controller.snapshot!.conversation('quiet'), isNull);
        final listed = [for (final r in activity.mentionRows) ...r.all];
        expect(listed.map((m) => m.id), contains('mention-3'));
        expect(menuRows(f), contains(('mention', 'mention-3')));
      },
    );

    testWidgets('Activity draws the same list, in the same order, folding '
        'only neighbouring tags from one author', (tester) async {
      final f = SuperTabLaunchFixture(local: true);
      final activity = (await tester.runAsync(() => openWithEverything(f)))!;
      await tester.binding.setSurfaceSize(const Size(1000, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabActivityView(
              activity: activity,
              onOpenMention: (_) {},
              onOpenThread: (_, _) {},
              onOpenConversation: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      List<(String, String)> drawn() => [
        for (final w in tester.widgetList(
          find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(
                  'super-activity-row-',
                ),
          ),
        ))
          switch ((w.key! as ValueKey<String>).value
              .substring('super-activity-row-'.length)
              .split(':')) {
            [final kind, final id] => (kind, id),
            _ => ('?', '?'),
          },
      ];
      final needs = drawn();
      await tester.tap(
        find.byKey(const ValueKey('super-activity-tab-mentions')),
      );
      await tester.pumpAndSettle();
      final tags = drawn();
      expect(
        [...needs, ...tags],
        [
          ('reminder', 'reminder-message-1'),
          ('agent', 'offline'),
          ('decision', 'decision-1'),
          ('mention', 'mention-1'),
          ('mention', 'mention-3'),
        ],
      );
      // The folded one is mention-2, right behind mention-1 in the menu.
      expect(find.text('+1 more from Wren'), findsOneWidget);
      expect(menuRows(f), everything);
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    });

    test('each row says who asks and what', () async {
      final f = SuperTabLaunchFixture(local: true);
      await openWithEverything(f);
      final rows = statusMenuSwarmEntries(f.app);
      expect(rows.map((r) => (r['title'], r['message'])).take(4), [
        ('Reminder', 'Look at the preview again'),
        ('Kestrel is waiting on you', 'Which port should the preview use?'),
        ('Wren asks you', 'Ship it behind a flag?'),
        ('Wren tagged you', 'Please confirm the release.'),
      ]);
    });
  });
}
