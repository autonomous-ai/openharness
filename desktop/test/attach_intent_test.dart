// Who may take a terminal: only a person at THIS window.
//
// A terminal has one controller, and an ordinary `terminal_open` wins it. Every
// other reason a pane attaches — a tab another Mac opened arriving over the
// desk, a reconnect, a machine answering its agent list, the dial turning —
// must open as a WATCHER (`takeover: false`) or not at all, so somebody typing
// on another screen keeps what they are typing into.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/desk_sync.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

DeskTab _tab(String id, List<String> agents) => DeskTab(
  id: id,
  name: 'Shared',
  nameIsCustom: true,
  panes: [for (final a in agents) DeskPaneRef(machineId: 'm', agentId: a)],
);

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  DeskDoc? doc = const DeskDoc(revision: 0, tabs: []);
  Map<String, dynamic>? _json(DeskDoc d) => {
    'revision': d.revision,
    'tabs': [for (final t in d.tabs) t.toJson()],
  };
  @override
  Future<Map<String, dynamic>?> desk() async => _json(doc!);
  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    doc = DeskDoc(
      revision: doc!.revision + 1,
      tabs: applyDeskOps(doc!.tabs, ops),
    );
    return _json(doc!);
  }
}

class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final opens = <Map<String, dynamic>>[];

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (type == 'terminal_open') opens.add(payload);
    return true;
  }
}

void main() {
  late _Api api;
  late _Conn conn;
  late AppNotifier app;
  late SwarmProjectStore projects;

  setUp(() {
    api = _Api();
    conn = _Conn();
    app = createApp(connectionForTest: (_) => conn)..api = api;
    projects = SwarmProjectStore();
  });

  /// [noTakeover]: whether this machine's daemon can open a terminal without
  /// taking it from whoever holds it.
  void seedMachine({bool noTakeover = true}) {
    app.stateOf('m')!
      ..nodeOnline = true
      ..terminalCapabilityAvailable = true
      ..terminalNoTakeoverAvailable = noTakeover
      ..agents = [
        const Agent(id: 'a0', name: 'A0', terminalAvailable: true),
        const Agent(id: 'a1', name: 'A1', terminalAvailable: true),
      ];
  }

  Future<void> mount(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: false,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
  }

  Future<void> finish(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    projects.dispose();
  }

  /// The other Mac opens [agents] in the shared tab; this window learns by
  /// fetching, as the `desk_changed` push and the poll both do.
  Future<void> deskSays(WidgetTester tester, List<String> agents) async {
    api.doc = DeskDoc(
      revision: api.doc!.revision + 1,
      tabs: [_tab('d1', agents)],
    );
    await app.deskFetchForTest();
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('a pane the other Mac opened is watched here, never taken', (
    tester,
  ) async {
    seedMachine();
    api.doc = DeskDoc(
      revision: 1,
      tabs: [
        _tab('d1', ['a0']),
      ],
    );
    await app.deskStartForTest();
    await tester.pump(const Duration(milliseconds: 60));
    app.selectSwarm('d1');
    await mount(tester);
    conn.opens.clear();

    await deskSays(tester, ['a0', 'a1']);

    expect(
      app.swarms.firstWhere((s) => s.id == 'd1').panes.map((p) => p.agentId),
      containsAll(['a0', 'a1']),
      reason: 'the tab the other Mac opened is here',
    );
    final opened = conn.opens.where((o) => o['agentId'] == 'a1');
    expect(opened, hasLength(1), reason: 'it still shows the terminal');
    expect(
      opened.single['takeover'],
      isFalse,
      reason: 'but it does not take it from whoever is typing',
    );
    await finish(tester);
  });

  testWidgets('an older daemon cannot be polite, so nothing opens by itself', (
    tester,
  ) async {
    seedMachine(noTakeover: false);
    api.doc = DeskDoc(
      revision: 1,
      tabs: [
        _tab('d1', ['a0']),
      ],
    );
    await app.deskStartForTest();
    await tester.pump(const Duration(milliseconds: 60));
    app.selectSwarm('d1');
    await mount(tester);
    conn.opens.clear();

    await deskSays(tester, ['a0', 'a1']);

    expect(conn.opens, isEmpty, reason: 'every open here would be a takeover');
    // The tile says so, and offers the one way in.
    expect(find.text('Open here'), findsWidgets);
    await finish(tester);
  });

  testWidgets('a person choosing the pane takes the terminal', (tester) async {
    seedMachine(noTakeover: false);
    // Not awaited: the attach waits for the tile to measure itself, which only
    // happens once the tree below is pumped.
    unawaited(app.addAgentToSwarm('m', 'a0'));
    await mount(tester);
    final opened = List<Map<String, dynamic>>.from(conn.opens);
    conn.opens.clear();

    // The tile was put there by a person too, so its own open already claimed
    // the terminal — which is the frame this checks.
    expect(conn.opens, isEmpty, reason: 'nothing left to open');
    expect(
      opened.single.containsKey('takeover'),
      isFalse,
      reason: 'absent is the takeover an open has always been',
    );
    await finish(tester);
  });

  test('a watcher renders but does not type, and a person may ask', () async {
    final sent = <Map<String, dynamic>>[];
    final session = TerminalSession(
      machineId: 'm',
      agentId: 'a0',
      agentName: 'A0',
      engineId: 'codex',
      takeover: false,
      send: (type, payload) async {
        if (type == 'terminal_open') sent.add(payload);
        return true;
      },
      sendBinary: (_) async => true,
    );
    addTearDown(session.dispose);

    await session.open(initialCols: 80, initialRows: 24);
    expect(sent.single['takeover'], isFalse);
    await session.handleFrame('terminal_ready', {
      'requestId': sent.single['requestId'],
      'protocolVersion': 3,
      'streamId': 's1',
      'agentId': 'a0',
      'readOnly': true,
    });
    expect(session.watching, isTrue);
    expect(session.acceptsInput, isFalse, reason: 'the daemon would refuse it');
    expect(
      session.takeover,
      isFalse,
      reason: 'watching is not a claim on the terminal',
    );

    // The first keyframe is what makes a stream live; stand in for it, since
    // the band only shows on a pane that is rendering something.
    session.status = TerminalSessionStatus.controlling;

    // The band's button: one takeover, asked for by a person.
    await session.reopen(force: true);
    expect(sent, hasLength(2), reason: 'it asked again');
    expect(
      sent.last.containsKey('takeover'),
      isFalse,
      reason: 'and asked for the terminal itself this time',
    );
  });

  testWidgets('a click takes back every stream, watchers included', (
    tester,
  ) async {
    seedMachine();
    // Two panes this window is only watching: the desk put them here, so
    // neither carries a claim of its own.
    api.doc = DeskDoc(
      revision: 1,
      tabs: [
        _tab('d1', ['a0', 'a1']),
      ],
    );
    await app.deskStartForTest();
    await tester.pump(const Duration(milliseconds: 60));
    app.selectSwarm('d1');
    await mount(tester);
    for (final pane in app.panes) {
      final session = pane.session;
      if (session == null) continue;
      await session.handleFrame('terminal_ready', {
        'requestId': conn.opens.lastWhere(
          (o) => o['agentId'] == pane.agentId,
        )['requestId'],
        'protocolVersion': 3,
        'streamId': 'stream-${pane.agentId}',
        'agentId': pane.agentId,
        'readOnly': true,
      });
      session.status = TerminalSessionStatus.controlling;
    }
    expect(app.panes.every((p) => p.session?.watching == true), isTrue);
    conn.opens.clear();

    await app.retakeTakenOverPanes();
    await tester.pump(const Duration(milliseconds: 200));

    expect(conn.opens, hasLength(2), reason: 'both asked again');
    expect(
      conn.opens.any((o) => o.containsKey('takeover')),
      isFalse,
      reason: 'and asked for the terminals themselves',
    );
    await finish(tester);
  });

  test('a polite open that loses says so, and does not ask again', () async {
    final sent = <Map<String, dynamic>>[];
    final session = TerminalSession(
      machineId: 'm',
      agentId: 'a0',
      agentName: 'A0',
      engineId: 'codex',
      takeover: false,
      send: (type, payload) async {
        if (type == 'terminal_open') sent.add(payload);
        return true;
      },
      sendBinary: (_) async => true,
    );
    addTearDown(session.dispose);

    await session.open(initialCols: 80, initialRows: 24);
    await session.handleFrame('terminal_error', {
      'requestId': sent.single['requestId'],
      'code': 'CONTROL_LEASE_HELD',
    });
    expect(session.status, TerminalSessionStatus.takenOver);
    expect(
      sent,
      hasLength(1),
      reason: 'retrying would ask for as long as the other client stayed',
    );
  });
}
