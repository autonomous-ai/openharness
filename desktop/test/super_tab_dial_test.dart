import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
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

  test('a hidden thread pane still names its root to the dial', () async {
    final (f, c) = await openChats();
    c.select('design-fix');
    c.openThread('m-root');
    await settle();
    final before = announces(f).length;
    c.threadPaneHidden();
    await settle();
    // Hiding the pane re-announces nothing and keeps the root in the row.
    expect(announces(f).length, before);
    expect(row(announces(f).last)['threadRoot'], 'm-root');
    f.app.announceWindowForeground();
    await settle();
    expect(row(announces(f).last)['threadRoot'], 'm-root');
  });

  test('closing the pane drops the root from the announce', () async {
    final (f, c) = await openChats();
    c.select('design-fix');
    c.openThread('m-root');
    c.threadPaneHidden();
    await settle();
    c.closeThread();
    await settle();
    expect(row(announces(f).last).containsKey('threadRoot'), isFalse);
  });

  Future<void> threadOnly(
    SuperTabLaunchFixture f,
    String conversation,
    Object? root,
  ) => f.app.handleEventForTest('m', {
    'type': 'dial_super_tab',
    'payload': {
      'superTabId': tabId,
      'conversationId': conversation,
      'threadRoot': root,
      'threadOnly': true,
    },
  });

  test('a threadOnly open does not raise the window or change the active Swarm', () async {
    final (f, c) = await openChats();
    final tab = f.app.activeSwarmId;
    f.app.newSwarm(newTabPage: true);
    final other = f.app.activeSwarmId;
    var raised = 0;
    final sub = f.app.deviceWindowRequests.listen((_) => raised++);
    f.connection.server.append('Fix it', conversationId: 'design-lead');
    final root = 'message-${f.connection.server.revision}';
    await threadOnly(f, 'design-lead', root);
    await settle();
    await sub.cancel();
    expect(raised, 0);
    expect(f.app.activeSwarmId, other);
    expect(f.app.activeSwarmId, isNot(tab));
    expect(c.openedThread?.conversationId, 'design-lead');
    expect(c.openedThread?.root, root);
  });

  test('a threadOnly open in a group chat opens the group\'s thread', () async {
    final (f, c) = await openChats();
    f.connection.server.append('Fix it', conversationId: 'design-fix');
    final root = 'message-${f.connection.server.revision}';
    await threadOnly(f, 'design-fix', root);
    await settle();
    expect(c.selectedId, 'design-fix');
    expect(c.openedThread?.conversationId, 'design-fix');
    expect(c.openedThread?.root, root);
  });

  test('a threadOnly close closes only that conversation\'s thread', () async {
    final (f, c) = await openChats();
    c.select('design-fix');
    c.openThread('m-root');
    await threadOnly(f, 'design-fix', null);
    await settle();
    expect(c.openedThread, isNull);
    expect(c.selectedId, 'design-fix');
  });

  test('a threadOnly close for another conversation changes nothing', () async {
    final (f, c) = await openChats();
    c.select('design-fix');
    c.openThread('m-root');
    await threadOnly(f, 'design-lead', null);
    await settle();
    expect(c.openedThread?.root, 'm-root');
    expect(c.selectedId, 'design-fix');
  });

  // A dial open that waits for its root (the post is still on its way).
  String nextRoot(SuperTabLaunchFixture f) =>
      'message-${f.connection.server.revision + 1}';

  Future<void> arrive(SuperTabLaunchFixture f, SuperTabController c) async {
    f.connection.server.append('Fix it', conversationId: 'design-lead');
    await c.refresh();
    await settle();
  }

  test('a thread the person opens while a dial open waits is kept', () async {
    final (f, c) = await openChats();
    final root = nextRoot(f);
    await threadOnly(f, 'design-lead', root);
    await settle();
    expect(c.openedThread, isNull);
    c.openThread('m-root');
    await arrive(f, c);
    expect(c.openedThread?.root, 'm-root');
  });

  test('a leave while the dial\'s thread still waits opens nothing later', () async {
    final (f, c) = await openChats();
    final root = nextRoot(f);
    await threadOnly(f, 'design-lead', root);
    await settle();
    await threadOnly(f, 'design-lead', null);
    await settle();
    await arrive(f, c);
    expect(c.openedThread, isNull);
  });

  test('a newer dial thread replaces a pending one', () async {
    final (f, c) = await openChats();
    final first = 'message-2';
    await threadOnly(f, 'design-lead', first);
    await settle();
    f.connection.server.append('Other', conversationId: 'design-lead');
    final second = 'message-${f.connection.server.revision}';
    await threadOnly(f, 'design-lead', second);
    await settle();
    await arrive(f, c);
    expect(c.openedThread?.root, second);
  });

  test('a thread the dial opens in a background tab marks nothing read until shown', () async {
    final (f, c) = await openChats();
    final server = f.connection.server..threads = true;
    server.append('Fix it', conversationId: 'design-lead');
    final root = 'message-${server.revision}';
    server.append('Reply', conversationId: 'design-lead');
    server.messages.last
      ..['thread'] = root
      ..['replyTo'] = root;
    await threadOnly(f, 'design-lead', root);
    await settle();
    await c.loadThread();
    await settle();
    expect(c.openedThread?.root, root);
    expect(server.threadMarkPosts, isEmpty);
    c.threadPaneShown();
    await settle();
    expect(server.threadMarkPosts, hasLength(1));
  });

  // Review of #2756 (ENGINEERING.md §1, §2): only the thread-only message
  // opens or closes the dial's thread. An ordinary pick, which nothing sends
  // with a root, keeps whatever thread the person has open.
  test('an ordinary dial pick leaves the open thread as it is, whatever root it names', () async {
    final (f, c) = await openChats();
    f.connection.server.append('Fix it', conversationId: 'design-lead');
    final posted = 'message-${f.connection.server.revision}';
    c.select('design-lead');
    await settle();
    c.openThread('m-root');
    for (final root in [posted, null]) {
      await f.app.handleEventForTest('m', {
        'type': 'dial_super_tab',
        'payload': {
          'superTabId': tabId,
          'projectId': 'design',
          'threadRoot': root,
        },
      });
      await settle();
      expect(c.selectedId, 'design-lead');
      expect(c.openedThread?.root, 'm-root', reason: '$root');
    }
  });

  // Review of #2756 (ENGINEERING.md §6): a dial thread whose root never
  // reaches the chat is given up, and the log says so, without its root.
  test('a dial thread whose root never arrives is given up, and logged', () async {
    final lines = <String>[];
    final previous = appLog;
    appLog = _RecordingLog(lines);
    addTearDown(() => appLog = previous);
    final (f, c) = await openChats();
    f.app.dialThreadWaitForTest = const Duration(milliseconds: 20);
    await threadOnly(f, 'design-lead', 'message-never');
    // Waits for the give-up's log line itself, never a fixed time (ENGINEERING.md §3).
    final given = DateTime.now().add(const Duration(seconds: 5));
    while (!lines.any((l) => l.contains('thread')) &&
        DateTime.now().isBefore(given)) {
      await settle();
    }
    expect(c.openedThread, isNull);
    expect(lines.where((l) => l.contains('thread')), hasLength(1));
    expect(lines.join('\n'), isNot(contains('message-never')));
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

class _RecordingLog implements AppLog {
  _RecordingLog(this.lines);
  final List<String> lines;
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message');
}
