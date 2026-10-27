import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/status_menu.dart';
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/notifications.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';
import 'swarm_screen_test.dart' show mount;

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
  });
}
