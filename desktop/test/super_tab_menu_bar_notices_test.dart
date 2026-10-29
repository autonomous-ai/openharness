import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/state/status_menu.dart';
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/notifications.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';
import 'swarm_screen_test.dart' show mount;

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

    test('leaves the menu at once, though its lists still hold it', () async {
      final f = await askedInOffline();
      final c = f.app.superTabs.peek(tabId)!;
      await c.refresh();
      expect(c.snapshot!.conversation('offline'), isNull);
      expect(SuperTabMentions.of(c).waiting, isNotEmpty);
      expect(statusMenuSwarmEntries(f.app), isEmpty);
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
      expect(find.byType(SuperTabNotifications), findsNothing);
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
      expect(find.byType(SuperTabNotifications), findsOneWidget);
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
    /// notice as the macOS runner sends it back.
    Future<Future<void> Function(String agentId)> clicker(
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
      return (agentId) async {
        messenger.handlePlatformMessage(
          'harness/notifications',
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('tapped', {
              'machineId': SystemNotifications.mentionNoticeMachine,
              'agentId': agentId,
            }),
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
        final f = SuperTabLaunchFixture(connectionFactory: TwoSwarms.new);
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

    testWidgets(
      'a click on a tag in a Swarm not loaded yet loads it, checks the tag, '
      'and opens it',
      (tester) async {
        final f = SuperTabLaunchFixture(connectionFactory: TwoSwarms.new);
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
        final f = SuperTabLaunchFixture(connectionFactory: TwoSwarms.new);
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
        final f = SuperTabLaunchFixture(connectionFactory: TwoSwarms.new);
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
  });
}
