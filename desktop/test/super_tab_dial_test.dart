import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<(SuperTabLaunchFixture, SuperTabController)> open() async {
    final f = SuperTabLaunchFixture(local: true);
    final server = f.connection.server;
    server.state['projects'] = [
      projectFixture('lead', 'Lamp OS', 'lead'),
      projectFixture('design', 'Design', 'design-lead'),
    ];
    (server.state['conversations'] as List).add({
      ...conversationFixture('design-lead', 'Lead'),
      'projectId': 'design',
    });
    f.app.adoptPoolConnectionForTest('m', f.connection);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    return (f, c);
  }

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  List<Map<String, dynamic>> announces(SuperTabLaunchFixture f) => [
    for (final call in f.connection.terminalCalls)
      if (call.$1 == 'app_swarms') call.$2,
  ];

  Map<String, dynamic> row(Map<String, dynamic> announce) =>
      (announce['swarms'] as List).cast<Map<String, dynamic>>().singleWhere(
        (s) => s['superTabId'] == tabId,
      );

  Future<void> pick(SuperTabLaunchFixture f, String tab, String project) =>
      f.app.handleEventForTest('m', {
        'type': 'dial_super_tab',
        'payload': {'superTabId': tab, 'projectId': project},
      });

  test('a Swarm row carries its tab and the selected project', () async {
    final (f, c) = await open();
    f.app.announceWindowForeground();
    await settle();
    expect(row(announces(f).last)['projectId'], 'lead');
    expect(announces(f).last.containsKey('fromDevice'), isFalse);
    c.select('design-lead');
    await settle();
    expect(row(announces(f).last)['projectId'], 'design');
  });

  test('a Swarm tab restored on its project chat names that project once the Swarm loads', () async {
    // Diego's dial, 2026-10-28: the app came back on the Swarm's project
    // chat (`project-<id>`), the dial was told the tab before the Swarm had
    // loaded, and nothing told it again once it had.
    final f = SuperTabLaunchFixture(local: true);
    final server = f.connection.server;
    server.state['projects'] = [
      projectFixture('lead', 'Lamp OS', 'lead'),
      projectFixture('design', 'Design', 'project-design'),
    ];
    (server.state['conversations'] as List).add({
      ...conversationFixture('project-design', 'Lead'),
      'projectId': 'design',
    });
    await f.store.write(
      'super_tab.owner.$tabId',
      '{"tabId":"$tabId","accountId":"owner","selectedId":"project-design"}',
    );
    f.app.adoptPoolConnectionForTest('m', f.connection);
    final hold = server.holdReads = Completer<void>();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    expect(c.selectedId, 'project-design');
    f.app.announceWindowForeground();
    await settle();
    expect(row(announces(f).last).containsKey('projectId'), isFalse);
    final before = announces(f).length;
    server.holdReads = null;
    hold.complete();
    await c.refresh();
    await settle();
    expect(c.snapshot, isNotNull);
    final after = announces(f).skip(before).toList();
    expect(after, isNotEmpty);
    expect(row(after.last)['projectId'], 'design');
  });

  test('a draft tab has no tab id', () async {
    final (f, _) = await open();
    f.app.newSwarm(newTabPage: true);
    f.app.announceWindowForeground();
    await settle();
    final rows = (announces(f).last['swarms'] as List).cast<Map>();
    expect(rows.where((r) => r.containsKey('superTabId')), hasLength(1));
  });

  test('a pick for an open Swarm focuses it and opens the Lead chat', () async {
    final (f, c) = await open();
    final tab = f.app.activeSwarmId;
    f.app.newSwarm(newTabPage: true);
    expect(f.app.activeSwarmId, isNot(tab));
    final before = announces(f).length;
    await pick(f, tabId, 'design');
    await settle();
    expect(f.app.activeSwarmId, tab);
    expect(c.selectedId, 'design-lead');
    final after = announces(f).skip(before).toList();
    expect(after, isNotEmpty);
    expect(after.every((a) => a['fromDevice'] == true), isTrue);
    expect(row(after.last)['projectId'], 'design');
    f.app.announceWindowForeground();
    await settle();
    expect(announces(f).last.containsKey('fromDevice'), isFalse);
  });

  test('a pick for a closed Swarm opens it first', () async {
    final (f, closed) = await open();
    f.app.newSwarm(newTabPage: true);
    await f.app.closeSwarm(
      f.app.swarms.firstWhere((s) => s.superTabId == tabId).id,
    );
    expect(f.app.swarms.any((s) => s.superTabId == tabId), isFalse);
    await pick(f, tabId, 'design');
    await settle();
    final tab = f.app.swarms.singleWhere((s) => s.superTabId == tabId);
    expect(f.app.activeSwarmId, tab.id);
    // Closing let go of the Swarm: it opened again with a fresh read.
    final c = f.app.superTabs.peek(tabId)!;
    expect(c, isNot(same(closed)));
    expect(c.selectedId, 'design-lead');
    // Opening the Swarm announces too, with the tab's old project; each of
    // those is the pick's, up to the one that names the picked project.
    final all = announces(f).where((a) => a['swarms'] != null).toList();
    final landed = all.indexWhere(
      (a) =>
          (a['swarms'] as List).any((s) => (s as Map)['projectId'] == 'design'),
    );
    expect(landed, isNonNegative);
    expect(all.skip(all.length - 1).single['fromDevice'], isTrue);
    expect(all.first['fromDevice'], isNot(isFalse));
  });

  test('selecting what is already selected still tags one announce', () async {
    final (f, c) = await open();
    expect(c.selectedId, 'lead');
    await pick(f, tabId, 'lead');
    await settle();
    expect(announces(f).last['fromDevice'], isTrue);
  });

  test('a slow refresh keeps every announce marked until it lands', () async {
    final f = SuperTabLaunchFixture(local: true);
    final server = f.connection.server;
    server.state['projects'] = [
      projectFixture('lead', 'Lamp OS', 'lead'),
      projectFixture('design', 'Design', 'design-lead'),
    ];
    (server.state['conversations'] as List).add({
      ...conversationFixture('design-lead', 'Lead'),
      'projectId': 'design',
    });
    f.app.adoptPoolConnectionForTest('m', f.connection);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final hold = server.holdReads = Completer<void>();
    final before = announces(f).length;
    final done = pick(f, tabId, 'design');
    await Future<void>.delayed(const Duration(milliseconds: 400));
    f.app.announceWindowForeground();
    await settle();
    final waiting = announces(f).skip(before).toList();
    expect(waiting, isNotEmpty);
    expect(waiting.every((a) => a['fromDevice'] == true), isTrue);
    hold.complete();
    await done;
    await settle();
    final c = await f.app.superTabs.open(tabId);
    expect(c.selectedId, 'design-lead');
    expect(row(announces(f).last)['projectId'], 'design');
    expect(announces(f).last['fromDevice'], isTrue);
    f.app.announceWindowForeground();
    await settle();
    expect(announces(f).last.containsKey('fromDevice'), isFalse);
  });

  test('an abandoned pick stops marking announces after 5 seconds', () async {
    final f = SuperTabLaunchFixture(local: true);
    f.connection.server.state['projects'] = [
      projectFixture('lead', 'Lamp OS', 'lead'),
    ];
    f.app.adoptPoolConnectionForTest('m', f.connection);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final hold = f.connection.server.holdReads = Completer<void>();
    unawaited(pick(f, tabId, 'lead'));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    f.app.announceWindowForeground();
    await settle();
    expect(announces(f).last['fromDevice'], isTrue);
    await Future<void>.delayed(const Duration(milliseconds: 5100));
    f.app.announceWindowForeground();
    await settle();
    expect(announces(f).last.containsKey('fromDevice'), isFalse);
    hold.complete();
    await settle();
  });

  test('unknown tabs and projects are ignored', () async {
    final (f, c) = await open();
    final active = f.app.activeSwarmId;
    final count = f.app.swarms.length;
    await pick(f, 'ffffffffffffffffffffffff', 'lead');
    await f.app.handleEventForTest('m', {
      'type': 'dial_super_tab',
      'payload': {'superTabId': 7},
    });
    await settle();
    expect(announces(f).where((a) => a['fromDevice'] == true), isEmpty);
    await pick(f, tabId, 'nope');
    await settle();
    expect(f.app.activeSwarmId, active);
    expect(f.app.swarms, hasLength(count));
    expect(c.selectedId, 'lead');
    // The flag does not outlive the pick that found nothing.
    f.app.announceWindowForeground();
    await settle();
    expect(announces(f).last.containsKey('fromDevice'), isFalse);
  });

  // The round dial's face follows the chat the window has open (design
  // 2026-10-28-round-dial-swarm-chat): the Lead's, Chat with PM or a group.
  Future<(SuperTabLaunchFixture, SuperTabController)> openChats() async {
    final f = SuperTabLaunchFixture(local: true);
    final server = f.connection.server;
    server.state['projects'] = [
      projectFixture('lead', 'Lamp OS', 'lead'),
      projectFixture('design', 'Design', 'design-lead'),
    ];
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      {...conversationFixture('design-lead', 'Lead'), 'projectId': 'design'},
      // The reader's Buddy chat, where the PM's private lines land.
      {
        ...conversationFixture('design-pm', "owner's Buddy"),
        'projectId': 'design',
        'kind': 'buddy',
        'buddyOwnerId': 'owner',
      },
      {
        ...conversationFixture('design-fix', 'Fix login'),
        'projectId': 'design',
      },
    ]);
    f.app.adoptPoolConnectionForTest('m', f.connection);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    return (f, c);
  }

  // The desktop follows the round dial into Buddy chats (Diego, 10-30): the
  // dial's side, and a tap on its Buddy's notification, open the chat in the
  // Swarm tab, never a terminal tab of its own.
  Future<void> follow(
    SuperTabLaunchFixture f,
    String project,
    String chat, {
    String tab = tabId,
  }) => f.app.handleEventForTest('m', {
    'type': 'dial_super_tab',
    'payload': {'superTabId': tab, 'projectId': project, 'chat': chat},
  });

  test('the dial\'s Buddy side opens the project\'s Buddy chat in the Swarm tab, with no new tab', () async {
    final (f, c) = await openChats();
    final swarm = f.app.activeSwarmId;
    f.app.newSwarm(newTabPage: true);
    final count = f.app.swarms.length;
    final before = announces(f).length;
    await follow(f, 'design', 'buddy');
    await settle();
    expect(f.app.activeSwarmId, swarm);
    expect(f.app.swarms, hasLength(count));
    expect(c.selectedId, 'design-pm');
    final after = announces(f).skip(before).toList();
    expect(after, isNotEmpty);
    // Each announce is the dial's own move: the daemon keeps the dial's side
    // and sends no focus back.
    expect(after.every((a) => a['fromDevice'] == true), isTrue);
    expect(row(after.last)['conversationId'], 'design-pm');
    f.app.announceWindowForeground();
    await settle();
    expect(announces(f).last.containsKey('fromDevice'), isFalse);
  });

  test('the dial\'s PM side opens the project\'s Lead chat', () async {
    final (f, c) = await openChats();
    final count = f.app.swarms.length;
    await follow(f, 'design', 'buddy');
    await settle();
    expect(c.selectedId, 'design-pm');
    final before = announces(f).length;
    await follow(f, 'design', 'pm');
    await settle();
    expect(c.selectedId, 'design-lead');
    expect(f.app.swarms, hasLength(count));
    final after = announces(f).skip(before).toList();
    expect(after.every((a) => a['fromDevice'] == true), isTrue);
    expect(row(after.last)['conversationId'], 'design-lead');
  });

  // Diego, 11-02: with one Buddy per Swarm the reader's Buddy chat is the
  // Swarm's (kind swarm-buddy, no project). The dial's Buddy side, a swipe or a
  // tap on its Buddy used to look for a chat of the project and land on the
  // earlier project chat (history) or the Lead chat.
  Future<(SuperTabLaunchFixture, SuperTabController)> openOneBuddy() async {
    final (f, c) = await openChats();
    final server = f.connection.server;
    server.state['swarmBuddy'] = true;
    (server.state['conversations'] as List).add(
      {
        ...conversationFixture('swarm-buddy-owner', "owner's Buddy"),
        'kind': 'swarm-buddy',
        'buddyOwnerId': 'owner',
      }..remove('projectId'),
    );
    await c.refresh();
    return (f, c);
  }

  test('with one Buddy per Swarm the dial\'s Buddy side opens the Swarm chat, from any project, never the earlier project chat', () async {
    final (f, c) = await openOneBuddy();
    expect(c.oneBuddy, isTrue);
    for (final project in ['design', 'lead']) {
      c.select('design-fix');
      await settle();
      await follow(f, project, 'buddy');
      await settle();
      expect(c.selectedId, 'swarm-buddy-owner');
    }
    // Back to the PM side from there: the project's Lead chat.
    await follow(f, 'design', 'pm');
    await settle();
    expect(c.selectedId, 'design-lead');
  });

  test('another person\'s Swarm Buddy chat is never opened, and the Lead chat opens instead', () async {
    final (f, c) = await openOneBuddy();
    final server = f.connection.server;
    for (final row in (server.state['conversations'] as List).cast<Map>()) {
      if (row['kind'] == 'swarm-buddy') row['buddyOwnerId'] = 'sam';
    }
    (server.state['conversations'] as List).removeWhere(
      (row) => (row as Map)['id'] == 'design-pm',
    );
    await c.refresh();
    await follow(f, 'design', 'buddy');
    await settle();
    expect(c.selectedId, 'design-lead');
  });

  test(
    'an older Swarm keeps the project\'s Buddy chat for the dial\'s Buddy side',
    () async {
      final (f, c) = await openChats();
      expect(c.oneBuddy, isFalse);
      await follow(f, 'design', 'buddy');
      await settle();
      expect(c.selectedId, 'design-pm');
    },
  );

  test('a Buddy side where the reader has no Buddy chat opens the Lead chat and makes none', () async {
    final (f, c) = await openChats();
    final server = f.connection.server;
    // Another person's Buddy chat in the project is never the reader's.
    (server.state['conversations'] as List).add({
      ...conversationFixture('lead-sam', "sam's Buddy"),
      'projectId': 'lead',
      'kind': 'buddy',
      'buddyOwnerId': 'sam',
    });
    await c.refresh();
    c.select('design-fix');
    await settle();
    await follow(f, 'lead', 'buddy');
    await settle();
    expect(c.selectedId, 'lead');
    final ids = [
      for (final g in (server.state['conversations'] as List).cast<Map>())
        g['id'],
    ];
    expect(ids.where((id) => '$id'.startsWith('buddy-')), isEmpty);
  });

  test('access revoked while the dial\'s Buddy open is in flight opens nothing', () async {
    final (f, c) = await openChats();
    final server = f.connection.server;
    final hold = server.holdReads = Completer<void>();
    // The Swarm's rows are gone when the pick arrives; its read is answered
    // with the access already removed.
    c.revokeAccess('Access removed.');
    server.state['conversations'] = <Map<String, dynamic>>[];
    server.state['projects'] = <Map<String, dynamic>>[];
    final picking = follow(f, 'design', 'buddy');
    await settle();
    server.holdReads = null;
    hold.complete();
    await picking;
    await settle();
    expect(c.selectedId, isNot('design-pm'));
    expect(c.buddyChat('design'), isNull);
    // The device's mark does not outlive the pick that found nothing.
    f.app.announceWindowForeground();
    await settle();
    expect(announces(f).last.containsKey('fromDevice'), isFalse);
  });

  test('an unknown chat, tab or project from the dial opens nothing new', () async {
    final (f, c) = await openChats();
    final count = f.app.swarms.length;
    await follow(f, 'design', 'terminal');
    await settle();
    // An unknown chat reads as the older pick: the project's Lead chat.
    expect(c.selectedId, 'design-lead');
    await follow(f, 'nope', 'buddy');
    await follow(f, 'design', 'buddy', tab: 'ffffffffffffffffffffffff');
    await settle();
    expect(c.selectedId, 'design-lead');
    expect(f.app.swarms, hasLength(count));
  });

  test('a Swarm tab announces the open conversation\'s id', () async {
    final (f, c) = await openChats();
    f.app.announceWindowForeground();
    await settle();
    expect(row(announces(f).last)['conversationId'], 'lead');
    for (final id in ['design-lead', 'design-pm', 'design-fix']) {
      c.select(id);
      await settle();
      expect(row(announces(f).last)['conversationId'], id);
      expect(row(announces(f).last)['projectId'], 'design');
    }
  });

  test('selecting another conversation re-announces', () async {
    final (f, c) = await openChats();
    c.select('design-pm');
    await settle();
    final before = announces(f).length;
    // Another chat of the same project: the project is unchanged, the chat is news.
    c.select('design-fix');
    await settle();
    final after = announces(f).skip(before).toList();
    expect(after, isNotEmpty);
    expect(row(after.last)['conversationId'], 'design-fix');
  });

  // Diego's dial, 2026-11-03: a thread open on Desktop was neither shown nor
  // answered on the dial.
  test('the Swarm row names the open thread while its pane shows, and not after it closes', () async {
    final (f, c) = await openChats();
    c.select('design-fix');
    await settle();
    expect(row(announces(f).last).containsKey('threadRoot'), isFalse);
    c.openThread('m-root');
    await settle();
    expect(row(announces(f).last)['conversationId'], 'design-fix');
    expect(row(announces(f).last)['threadRoot'], 'm-root');
    c.closeThread();
    await settle();
    expect(row(announces(f).last)['conversationId'], 'design-fix');
    expect(row(announces(f).last).containsKey('threadRoot'), isFalse);
    // A thread of another conversation is not on screen beside this one.
    c.openThread('m-root');
    c.select('design-lead');
    await settle();
    expect(row(announces(f).last)['conversationId'], 'design-lead');
    expect(row(announces(f).last).containsKey('threadRoot'), isFalse);
  });

  Future<void> pickThread(
    SuperTabLaunchFixture f,
    String project,
    Object? root, {
    bool withRoot = true,
  }) => f.app.handleEventForTest('m', {
    'type': 'dial_super_tab',
    'payload': {
      'superTabId': tabId,
      'projectId': project,
      if (withRoot) 'threadRoot': root,
    },
  });

  // Diego's dial, 2026-11-03: the dial's thread opens in the app too.
  test('a dial pick with threadRoot opens that thread beside the chat', () async {
    final (f, c) = await openChats();
    f.connection.server.append('Fix it', conversationId: 'design-lead');
    await pickThread(f, 'design', 'message-${f.connection.server.revision}');
    await settle();
    expect(c.selectedId, 'design-lead');
    expect(c.openedThread?.conversationId, 'design-lead');
    expect(c.openedThread?.root, 'message-${f.connection.server.revision}');
    // A root that is no message of the chat opens nothing.
    c.closeThread();
    await pickThread(f, 'design', 'nope');
    await settle();
    expect(c.openedThread, isNull);
  });

  test('a root posted a moment before the pick opens once the chat reads it', () async {
    final (f, c) = await openChats();
    final server = f.connection.server;
    final root = 'message-${server.revision + 1}';
    await pickThread(f, 'design', root);
    await settle();
    expect(c.openedThread, isNull);
    server.append('Fix it', conversationId: 'design-lead');
    await c.refresh();
    await settle();
    expect(c.openedThread?.root, root);
    expect(c.openedThread?.conversationId, 'design-lead');
  });

  test('a pending root is dropped when the dial picks another chat', () async {
    final (f, c) = await openChats();
    final server = f.connection.server;
    final root = 'message-${server.revision + 1}';
    await pickThread(f, 'design', root);
    await settle();
    await pickThread(f, 'lead', null, withRoot: false);
    await settle();
    server.append('Fix it', conversationId: 'design-lead');
    await c.refresh();
    await settle();
    expect(c.openedThread, isNull);
  });

  test('threadRoot null closes the open thread', () async {
    final (f, c) = await openChats();
    c.select('design-lead');
    await settle();
    c.openThread('m-root');
    expect(c.openedThread, isNotNull);
    await pickThread(f, 'design', null);
    await settle();
    expect(c.openedThread, isNull);
  });

  test('no threadRoot keeps today\'s pick', () async {
    final (f, c) = await openChats();
    c.select('design-lead');
    await settle();
    c.openThread('m-root');
    await pickThread(f, 'design', null, withRoot: false);
    await settle();
    expect(c.selectedId, 'design-lead');
    expect(c.openedThread?.root, 'm-root');
  });

  test('a decisions view or an unloaded Swarm leaves conversationId out', () async {
    final (f, c) = await openChats();
    c.select('design-pm');
    await settle();
    // The Swarm's machines view (the one view here that is no conversation; its
    // decisions are a panel beside the chat, which keeps the chat selected).
    c.selectDevices();
    f.app.announceWindowForeground();
    await settle();
    expect(row(announces(f).last).containsKey('conversationId'), isFalse);

    // A Swarm tab shown before its Swarm loaded names no conversation.
    final g = SuperTabLaunchFixture(local: true);
    g.app.adoptPoolConnectionForTest('m', g.connection);
    final hold = g.connection.server.holdReads = Completer<void>();
    g.app.bindSuperTab(g.app.activeSwarmId, tabId, 'Pilot');
    await g.app.superTabs.open(tabId);
    g.app.announceWindowForeground();
    await settle();
    expect(row(announces(g).last).containsKey('conversationId'), isFalse);
    g.connection.server.holdReads = null;
    hold.complete();
    await settle();
  });
}
