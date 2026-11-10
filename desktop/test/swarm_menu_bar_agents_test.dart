import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/state/status_menu.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_swarm.dart' show addAskingAgent, swarm;
import 'super_tab_mentions_test.dart' show showView;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_screen_test.dart' show mount;

/// [f]'s app with a Swarm tab whose agent kai wrote to its person in its own chat (Swarm v4: what asks them).
Future<SuperTabController> openWithKai(SuperTabLaunchFixture f) async {
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  addAskingAgent(f.connection.server, 'kai');
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  return c;
}

void main() {
  test('the menu bar lists each agent that asks, by the name Your Team shows, '
      'with its unread words once they are held', () async {
    final f = SuperTabLaunchFixture(local: true);
    expect(statusMenuSwarmEntries(f.app), isEmpty);
    final server = f.connection.server;
    final c = await openWithKai(f);
    // Renamed since its chat was made: the row says what Your Team says.
    (server.state['agents'] as List).cast<Map>().last['displayName'] =
        'Kestrel';
    await c.refresh();
    var rows = statusMenuSwarmEntries(f.app);
    expect(rows.map((r) => (r['kind'], r['id'], r['title'])), [
      ('chat', 'agent-chat-kai', 'Kestrel'),
    ]);
    expect(rows.single['swarmTabId'], tabId);
    expect(rows.single['tabName'], 'Pilot');
    // Its words are not held until its chat is read from the server.
    expect(rows.single['message'], isNull);
    await c.select('agent-chat-kai');
    rows = statusMenuSwarmEntries(f.app);
    expect(rows.single['message'], 'Which build?');
    expect(rows.single['receivedAt'], isA<int>());
    expect(tabWaitingLabel(f.app, f.app.activeSwarm), '1 agent asks you');

    // Read: nothing asks.
    c.markRead('agent-chat-kai', explicit: true);
    expect(statusMenuSwarmEntries(f.app), isEmpty);
    expect(tabWaitingLabel(f.app, f.app.activeSwarm), isNull);
    await c.flush();
    f.dispose();
  });

  testWidgets('from the menu bar, an agent that asks opens in its own chat, '
      'its Swarm tab brought forward', (tester) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final updates = <Map>[];
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return true;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final f = SuperTabLaunchFixture(local: true);
    final c = (await tester.runAsync(() => openWithKai(f)))!;
    final swarmTab = f.app.activeSwarmId;
    f.app.newSwarm(name: 'Desktop');
    await mount(tester, f.app, nativeTabs: true);
    await tester.pump();
    final rows = (updates.last['statusMenuSwarmEntries'] as List).cast<Map>();
    expect(rows.map((r) => r['title']), ['kai']);
    expect(updates.last['dockBadge'], 1);

    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        MethodCall('openSwarmNotice', rows.single),
      ),
      (_) {},
    );
    await tester.pump();
    await tester.pump();
    expect(f.app.activeSwarmId, swarmTab);
    // Its Swarm's view takes it as it shows (below).
    expect(c.noticeRequest, (kind: 'chat', id: 'agent-chat-kai'));

    await tester.pumpWidget(const SizedBox());
    expect(updates.last['statusMenuSwarmEntries'], isNull);
    await tester.runAsync(c.flush);
    f.dispose();
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('the Swarm view opens the agent\'s chat the menu bar asked '
      'for', (tester) async {
    final server = swarm();
    addAskingAgent(server, 'kai');
    final c = await showView(tester, server);
    expect(c.selectedId, isNot('agent-chat-kai'));
    c.openNotice('chat', 'agent-chat-kai');
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-kai');
    expect(c.noticeRequest, isNull);
    expect(find.byKey(const ValueKey('swarm-agent-header')), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
  });
}
