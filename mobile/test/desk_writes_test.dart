import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// A machine that starts and deletes the agents it is asked to, and answers
/// everything else with nothing.
class _Conn extends PagerConn {
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => switch (type) {
    'agent_create' => {
      'creationId': payload['creationId'],
      'state': 'created',
      'agent': {
        'id': 'new',
        'name': 'new',
        'engine': 'claude',
        'terminal': {'available': true},
      },
    },
    _ => {},
  };
}

/// What the phone tells the desk, and what the desk tells the phone.
///
/// The phone FOLLOWS the tabs — it never projects its own panes onto them, see
/// `state/phone_desk.dart` — so there are exactly two things it says, and both
/// are a person acting on this phone.
void main() {
  List<String> agentsOf(AppNotifier app, String tabId) => [
    for (final pane in app.deskTabs.firstWhere((t) => t.id == tabId).panes)
      pane.agentId,
  ];

  test('an agent created on the phone joins the tab the phone is in', () async {
    final app = await deskApp(
      _Conn(),
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );
    addTearDown(app.dispose);
    // What the home screen records every time it draws — see `noteDeskTab`.
    app.noteDeskTab('t2');

    final error = await app.createAgent('m', engine: 'claude', folder: '/work');
    await pumpEventQueue();

    expect(error, isNull);
    expect(agentsOf(app, 't2'), ['c', 'new']);
    expect(deskApiOf(app).written, [
      {'op': 'pane.add', 'tabId': 't2', 'machineId': 'm', 'agentId': 'new'},
    ]);
  });

  test('an agent deleted on the phone leaves the tabs it was on', () async {
    final app = await deskApp(
      _Conn(),
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['b']),
      ],
    );
    addTearDown(app.dispose);

    final error = await app.deleteAgent('m', 'b');
    await pumpEventQueue();

    expect(error, isNull);
    expect(agentsOf(app, 't1'), ['a']);
    expect(agentsOf(app, 't2'), isEmpty);
    expect(deskApiOf(app).written.map((op) => op['tabId']), ['t1', 't2']);
  });

  test('a desk_changed push brings the tabs from the other computer', () async {
    final app = await deskApp(
      _Conn(),
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
      ],
    );
    addTearDown(app.dispose);

    deskApiOf(app).tabs = [
      deskTab('t1', 'Desktop', ['a', 'b']),
      deskTab('t2', 'Docker', ['c']),
    ];
    deskApiOf(app).revision++;
    await app.handleEventForTest('m', {
      'type': 'desk_changed',
      'payload': {'revision': deskApiOf(app).revision},
    });
    await pumpEventQueue();

    expect([for (final tab in app.deskTabs) tab.name], ['Desktop', 'Docker']);
    expect(agentsOf(app, 't1'), ['a', 'b']);
  });
}
