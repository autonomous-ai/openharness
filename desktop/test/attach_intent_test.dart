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

import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';

import 'swarm_state_test.dart' show MemoryStore, createApp;

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
    // The open watchdog and any debounced layout write are armed by the work
    // above; let them fall due on a torn-down tree rather than at teardown,
    // where a pending timer fails the test for a reason nothing here is about.
    await tester.pump(const Duration(seconds: 20));
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

  group('opening the app is itself the gesture', () {
    /// A layout with two tiles, saved as a previous run would leave it.
    Future<MemoryStore> savedLayout() async {
      final storage = MemoryStore();
      final store = PaneLayoutStore(storage: storage);
      final saved = Swarm(id: 'swarm-1', name: 'Work', nameIsCustom: true)
        ..panes.addAll([
          TerminalPane(id: 1, machineId: 'm', agentId: 'a0'),
          TerminalPane(id: 2, machineId: 'm', agentId: 'a1'),
        ]);
      await store.saveSwarms([saved], 'swarm-1');
      return storage;
    }

    /// The app, opened on that layout, with its machine ready to answer.
    Future<AppNotifier> opened({
      required MemoryStore storage,
      bool noTakeover = true,
    }) async {
      final started = createApp(store: storage, connectionForTest: (_) => conn)
        ..api = api;
      started.stateOf('m')!
        ..nodeOnline = true
        ..terminalCapabilityAvailable = true
        ..terminalNoTakeoverAvailable = noTakeover
        ..agents = [
          const Agent(id: 'a0', name: 'A0', terminalAvailable: true),
          const Agent(id: 'a1', name: 'A1', terminalAvailable: true),
        ];
      await started.restorePaneLayoutForTest(claimOnAttach: true);
      return started;
    }

    /// The machine answering — the sweep that actually attaches a restored
    /// tile, and the same one a reconnect runs later.
    Future<void> machineAnswers(
      WidgetTester tester, {
      String about = 'a0',
    }) async {
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': about,
            'name': about.toUpperCase(),
            'terminal': {'available': true},
          },
        },
      });
      await tester.pump(const Duration(milliseconds: 200));
    }

    testWidgets('every tile it restores takes its terminal back', (
      tester,
    ) async {
      final storage = await savedLayout();
      app.dispose();
      app = await opened(storage: storage);
      await mount(tester);
      conn.opens.clear();

      await machineAnswers(tester);

      expect(conn.opens, hasLength(2), reason: 'both tiles opened');
      expect(
        conn.opens.any((o) => o.containsKey('takeover')),
        isFalse,
        reason: 'and both asked for the terminal itself',
      );
      await finish(tester);
    });

    testWidgets('an older daemon is no obstacle to the app opening', (
      tester,
    ) async {
      final storage = await savedLayout();
      app.dispose();
      app = await opened(storage: storage, noTakeover: false);
      await mount(tester);
      conn.opens.clear();

      await machineAnswers(tester);

      expect(
        conn.opens,
        hasLength(2),
        reason: 'a person opened the app; the polite path is not needed',
      );
      await finish(tester);
    });

    testWidgets('an agent that is not ready yet keeps its tile\'s claim', (
      tester,
    ) async {
      final storage = await savedLayout();
      app.dispose();
      app = await opened(storage: storage);
      // The machine is up, but has not verified this agent's terminal yet:
      // every sweep meanwhile refuses the tile.
      app.stateOf('m')!.agents = [
        const Agent(id: 'a0', name: 'A0'),
        const Agent(id: 'a1', name: 'A1', terminalAvailable: true),
      ];
      await mount(tester);
      conn.opens.clear();
      // A sweep about the OTHER agent, so a0 is still unverified.
      await machineAnswers(tester, about: 'a1');
      expect(
        conn.opens.any((o) => o['agentId'] == 'a0'),
        isFalse,
        reason: 'nothing to attach to yet',
      );

      // It comes ready: the tile still carries the gesture that opened the app.
      app.stateOf('m')!.agents = [
        const Agent(id: 'a0', name: 'A0', terminalAvailable: true),
        const Agent(id: 'a1', name: 'A1', terminalAvailable: true),
      ];
      await machineAnswers(tester);

      final opened0 = conn.opens.where((o) => o['agentId'] == 'a0');
      expect(opened0, hasLength(1));
      expect(
        opened0.single.containsKey('takeover'),
        isFalse,
        reason: 'a refusal must not spend the claim',
      );
      await finish(tester);
    });

    testWidgets('the claim is spent once, not carried into a reconnect', (
      tester,
    ) async {
      final storage = await savedLayout();
      app.dispose();
      app = await opened(storage: storage);
      await mount(tester);
      await machineAnswers(tester);
      expect(
        app.panes.any((p) => p.claimOnFirstAttach),
        isFalse,
        reason: 'spent on the attach it paid for',
      );
      // The daemon answers each claim: from here the session holds the lease,
      // and its own later opens rest on holding it rather than on the launch.
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
        });
      }
      conn.opens.clear();

      // The machine drops and comes back: nobody opened anything this time.
      for (final pane in app.panes) {
        pane.session?.transportLost('Harness reconnected');
      }
      await tester.pump();
      await machineAnswers(tester);

      expect(conn.opens, isNotEmpty, reason: 'it did reattach');
      expect(
        conn.opens.every((o) => o['takeover'] == false),
        isTrue,
        reason: 'reconnecting is not the same arrival: ${conn.opens}',
      );
      await finish(tester);
    });
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
