import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart' show WsRequestTimeout;

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// A machine that starts and deletes the agents it is asked to, and answers
/// everything else with nothing.
///
/// [losesFirstReply] drops the answer to the first `agent_create` the way a
/// relay that went away does, and answers the Check status after it.
class _Conn extends PagerConn {
  _Conn({this.losesFirstReply = false});

  final bool losesFirstReply;
  var _creates = 0;

  static Map<String, dynamic> _created(Map<String, dynamic> payload) => {
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': {
      'id': 'new',
      'name': 'new',
      'engine': 'claude',
      'terminal': {'available': true},
    },
  };

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_create' && losesFirstReply && _creates++ == 0) {
      throw const WsRequestTimeout('agent_create');
    }
    return switch (type) {
      'agent_create' || 'agent_create_status' => _created(payload),
      _ => {},
    };
  }
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

  test(
    'an agent created for a picked tab joins it, not the tab the phone is in',
    () async {
      final app = await deskApp(
        _Conn(),
        opensTerminals: false,
        tabs: [
          deskTab('t1', 'Desktop', ['a']),
          deskTab('t2', 'Docker', ['c']),
        ],
      );
      addTearDown(app.dispose);
      // The tab of the harness Find was opened over; Find was narrowed to Docker.
      app.noteDeskTab('t1');

      final error = await app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        deskTabId: 't2',
      );
      await pumpEventQueue();

      expect(error, isNull);
      expect(agentsOf(app, 't1'), ['a']);
      expect(agentsOf(app, 't2'), ['c', 'new']);
      expect(app.activeDeskTabId, 't2');
      expect(deskApiOf(app).written, [
        {'op': 'pane.add', 'tabId': 't2', 'machineId': 'm', 'agentId': 'new'},
      ]);
    },
  );

  test('a Check status after a lost reply keeps the tab picked', () async {
    final app = await deskApp(
      _Conn(losesFirstReply: true),
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );
    addTearDown(app.dispose);
    app.noteDeskTab('t1');
    final attempt = AgentCreationAttempt();

    final lost = await app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      deskTabId: 't2',
      attempt: attempt,
    );
    expect(lost, contains('has not confirmed the new harness yet'));
    expect(deskApiOf(app).written, isEmpty);

    // Asked about with what it was first made with — no tab handed in again.
    final checked = await app.checkAgentCreation(attempt);
    await pumpEventQueue();

    expect(checked, isNull);
    expect(agentsOf(app, 't1'), ['a']);
    expect(agentsOf(app, 't2'), ['c', 'new']);
  });

  test(
    'an agent created for a new tab opens a tab of its own, not the tab picked',
    () async {
      final app = await deskApp(
        _Conn(),
        opensTerminals: false,
        tabs: [
          deskTab('t1', 'Desktop', ['a']),
          deskTab('t2', 'Docker', ['c']),
        ],
      );
      addTearDown(app.dispose);
      app.noteDeskTab('t1');

      final error = await app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        deskTabId: 't2',
        newDeskTab: true,
      );
      await pumpEventQueue();

      expect(error, isNull);
      expect(app.deskTabs, hasLength(3));
      final made = app.deskTabs.last;
      expect(agentsOf(app, 't1'), ['a']);
      expect(agentsOf(app, 't2'), ['c']);
      expect(agentsOf(app, made.id), ['new']);
      expect(app.activeDeskTabId, made.id);
      expect(deskApiOf(app).written.map((op) => op['op']), [
        'tab.create',
        'pane.add',
      ]);
    },
  );

  test('a Check status after a lost reply keeps the new tab', () async {
    final app = await deskApp(
      _Conn(losesFirstReply: true),
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Desktop', ['a']),
      ],
    );
    addTearDown(app.dispose);
    app.noteDeskTab('t1');
    final attempt = AgentCreationAttempt();

    final lost = await app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      newDeskTab: true,
      attempt: attempt,
    );
    expect(lost, contains('has not confirmed the new harness yet'));
    expect(deskApiOf(app).written, isEmpty);

    // Asked about with what it was first made with — the new tab is not asked for again.
    final checked = await app.checkAgentCreation(attempt);
    await pumpEventQueue();

    expect(checked, isNull);
    expect(app.deskTabs, hasLength(2));
    expect(agentsOf(app, 't1'), ['a']);
    expect(agentsOf(app, app.deskTabs.last.id), ['new']);
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
