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
    final (f, c) = await open();
    f.app.newSwarm(newTabPage: true);
    await f.app.closeSwarm(
      f.app.swarms.firstWhere((s) => s.superTabId == tabId).id,
    );
    expect(f.app.swarms.any((s) => s.superTabId == tabId), isFalse);
    await pick(f, tabId, 'design');
    await settle();
    final tab = f.app.swarms.singleWhere((s) => s.superTabId == tabId);
    expect(f.app.activeSwarmId, tab.id);
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
}
