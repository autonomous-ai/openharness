// What the dial turning to an agent does to the grid.
//
// The dial's carousel walks the window's tiles, in tile order, and nothing else — swipe is "the next
// pane". So a focus arriving from the dial is always about a tile that already exists, and it does what
// a click on the rail does.
//
// It used to be more than that. The ring carried on past either end of the desk into agents with no
// tile, and landing on one put it on the desk by REPLACING the tile at the end it was reached from —
// with the daemon naming that end (`edge`), since only it holds the flat list of every agent on every
// machine. That is gone, and so are the tests that pinned it; what survives here is the ordinary path
// and the notification verb beside it, which was always different.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';

AppNotifier _notifier() => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
);

Agent _agent(String id) => Agent.fromJson({
  'id': id,
  'name': id,
  'engine': 'claude',
  'terminal': {
    'runtimes': [
      {'backend': 'tmux', 'paneId': '%1'},
    ],
  },
});

MachineState _machine(AppNotifier app, String id, List<String> agentIds) {
  final machine = Machine(
    machineId: id,
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: id,
    status: 'online',
  );
  final state = MachineState(machine)
    ..nodeOnline =
        false // keeps _attachSession from dialling out
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [for (final agentId in agentIds) _agent(agentId)];
  app.machines = [...app.machines, machine];
  app.machineStates[id] = state;
  return state;
}

List<String?> _desk(AppNotifier app) => [for (final p in app.panes) p.agentId];

Future<AppNotifier> _withTiles(List<String> agentIds) async {
  final app = _notifier();
  _machine(app, 'm1', ['a1', 'a2', 'a3', 'a4', 'a5']);
  for (final id in agentIds) {
    await app.assignAgentToPane(null, 'm1', id);
  }
  return app;
}

void main() {
  test(
    'preparation retries share one tab and attach its package viewer',
    () async {
      final app = _notifier();
      final machine = _machine(app, 'm1', ['a1']);
      machine.agents = [
        Agent.fromJson({
          'id': 'a1',
          'name': 'a1',
          'engine': 'claude',
          'viewerUrl': 'http://127.0.0.1:12345',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
      ];
      try {
        final results = await Future.wait([
          app.revealPreparedAgent('m1', 'a1', 'operation1'),
          app.revealPreparedAgent('m1', 'a1', 'operation1'),
          app.revealPreparedAgent('m1', 'a1', 'operation2'),
        ]);
        expect(results, everyElement(isTrue));
        expect(app.allPanes.where((p) => p.agentId == 'a1'), hasLength(1));
        expect(
          app.allPanes.where((p) => p.isWeb && p.ownerAgentId == 'a1'),
          hasLength(1),
        );
        final tabs = app.swarms.length;
        await app.revealPreparedAgent('m1', 'a1', 'operation1');
        expect(app.swarms, hasLength(tabs));
      } finally {
        app.dispose();
      }
    },
  );
  test(
    'preparation reveals an existing agent tab without duplicating it',
    () async {
      final app = await _withTiles(['a1']);
      try {
        final tabs = app.swarms.length;
        expect(await app.revealPreparedAgent('m1', 'a1', 'operation'), isTrue);
        expect(app.swarms, hasLength(tabs));
        expect(app.allPanes.where((p) => p.agentId == 'a1'), hasLength(1));
      } finally {
        app.dispose();
      }
    },
  );

  test('the roster the daemon builds its ring from is in tile order', () {
    // The section in the rail, the tile order on screen and the dial's carousel
    // are one list. This is the end of it the window owns: what it reports is
    // the order it draws, so the numbers beside the rail rows and the steps
    // under the thumb are the same walk.
    final app = _notifier();
    _machine(app, 'm1', ['a1', 'a2', 'a3']);
    app.panes.addAll([
      TerminalPane(id: 1, machineId: 'm1', agentId: 'a3'),
      TerminalPane(id: 2, machineId: 'm1', agentId: 'a1'),
    ]);
    expect(_desk(app), ['a3', 'a1']);
    app.dispose();
  });

  test('an agent that already has a tile is focused, never duplicated', () async {
    final app = await _withTiles(['a1', 'a2']);
    await app.selectAgentFromDial('m1', 'a1');

    // Two tiles before, two after — and the one holding it is the focused one.
    expect(_desk(app), ['a1', 'a2']);
    expect(app.focusedPane?.agentId, 'a1');
    app.dispose();
  });

  test(
    'a dial-selected agent adds a view without replacing swarm membership',
    () async {
      // The carousel cannot reach this agent any more, but the pull-down switcher still names it and the
      // window is still told. What happens then is ordinary selection — the focused tile becomes it —
      // rather than the old rule, which chose a tile by which END of the desk the thumb had walked off.
      final app = await _withTiles(['a1', 'a2']);
      await app.selectAgentFromDial('m1', 'a3');

      expect(_desk(app), ['a1', 'a2', 'a3']);
      expect(app.focusedPane?.agentId, 'a3');
      app.dispose();
    },
  );

  test('with no tiles at all, one is opened', () async {
    final app = _notifier();
    _machine(app, 'm1', ['a1', 'a2']);
    await app.selectAgentFromDial('m1', 'a2');

    expect(_desk(app), ['a2']);
    app.dispose();
  });

  // ── a notification asks for a tile of its own ───────────────────────────────
  //
  // Turning the dial says where the eye is and a tile moves to match. Tapping a
  // notification is a different verb: the turn just FINISHED, so it is something
  // new to look at, not a replacement for what the person was already watching.
  test(
    'a notification for an agent in no tab opens a NEW tab for it',
    () async {
      // The window is tabs (owner, 2026-09-15): an agent nobody has open gets a
      // tab of its own, and the tab it was tapped from is left as it was.
      final app = await _withTiles(['a1', 'a2']);
      final before = app.activeSwarmId;
      await app.openAgentFromDial('m1', 'a3');

      expect(app.activeSwarmId, isNot(before));
      expect(_desk(app), ['a3']);
      expect(app.focusedPane?.agentId, 'a3');
      expect(
        app.swarms
            .firstWhere((s) => s.id == before)
            .panes
            .map((p) => p.agentId),
        ['a1', 'a2'],
        reason: 'the tab it came from is untouched',
      );
      app.dispose();
    },
  );

  test(
    'a full tab is not a capacity error — the agent gets its own tab',
    () async {
      final app = _notifier();
      _machine(app, 'm1', [
        for (var i = 0; i <= AppNotifier.maxPanes; i++) 'a$i',
      ]);
      for (var i = 0; i < AppNotifier.maxPanes; i++) {
        await app.assignAgentToPane(null, 'm1', 'a$i');
      }
      final full = app.activeSwarmId;
      final before = List.of(app.panes);
      await app.openAgentFromDial('m1', 'a${AppNotifier.maxPanes}');
      expect(app.activeSwarmId, isNot(full));
      expect(_desk(app), ['a${AppNotifier.maxPanes}']);
      expect(app.swarms.firstWhere((s) => s.id == full).panes, before);
      expect(app.lastError, isNull);
      app.dispose();
    },
  );

  test('a notification for an agent open in ANOTHER tab switches to it', () async {
    final app = await _withTiles(['a1', 'a2']);
    final first = app.activeSwarmId;
    app.newSwarm();
    await app.addAgentToSwarm('m1', 'a3', swarmId: app.activeSwarmId);
    final second = app.activeSwarmId;
    expect(second, isNot(first));

    // Back on the first tab, a tap for a3 goes to the second — no second tile.
    app.selectSwarm(first);
    await app.openAgentFromDial('m1', 'a3');
    expect(app.activeSwarmId, second);
    expect(app.focusedPane?.agentId, 'a3');
    expect(app.allPanes.where((p) => p.agentId == 'a3').length, 1);

    // And the CURRENT tab wins when both hold it.
    app.selectSwarm(first);
    await app.addAgentToSwarm('m1', 'a3', swarmId: first);
    app.focusPane(app.panes.first.id);
    await app.openAgentFromDial('m1', 'a3');
    expect(app.activeSwarmId, first);
    expect(app.focusedPane?.agentId, 'a3');
    app.dispose();
  });

  test('a notification for a tile already open only focuses it', () async {
    final app = await _withTiles(['a1', 'a2', 'a3']);
    app.focusPane(app.panes.first.id);

    await app.openAgentFromDial('m1', 'a3');

    expect(_desk(app), ['a1', 'a2', 'a3'], reason: 'nothing opened twice');
    expect(app.focusedPane?.agentId, 'a3');
    app.dispose();
  });

  // ── the wire ────────────────────────────────────────────────────────────────
  //
  // Everything above calls the method directly, which proves the rule and
  // nothing about the frame that carries it. These drive the real `dial_focus`
  // frame through the app's own handler, because a typo in one string is
  // exactly how this feature would look installed and be inert — and that is
  // the failure that actually happened, twice, on the real dial.
  Future<void> dialFocus(AppNotifier app, String agentId) =>
      app.handleEventForTest('m1', {
        'type': 'dial_focus',
        'payload': {'machineId': 'm1', 'agentId': agentId},
      });

  test('a dial_focus frame for a tile that is open only moves the focus', () async {
    // Walking WITHIN the desk. The daemon sends no edge for these, and the grid
    // must not change at all — this is the swipe people make constantly.
    final app = await _withTiles(['a1', 'a2', 'a3']);
    app.focusPane(app.panes.first.id);
    await dialFocus(app, 'a3');

    expect(_desk(app), ['a1', 'a2', 'a3']);
    expect(app.focusedPane?.agentId, 'a3');
    app.dispose();
  });

  test(
    'a dial_swarm frame switches the swarm, and an unknown id is ignored',
    () async {
      // The dial's swarm line. It sends the id it was given; the switch is the ordinary one, so the desk
      // it re-describes is the other swarm's panes — which is what the dial's carousel then walks.
      final app = await _withTiles(['a1', 'a2']);
      final first = app.activeSwarmId;
      app.newSwarm(name: 'Launch');
      final second = app.activeSwarmId;
      expect(second, isNot(first));

      await app.handleEventForTest('m1', {
        'type': 'dial_swarm',
        'payload': {'swarmId': first},
      });
      expect(app.activeSwarmId, first);
      expect(_desk(app), ['a1', 'a2']);

      await app.handleEventForTest('m1', {
        'type': 'dial_swarm',
        'payload': {'swarmId': 'swarm-nope'},
      });
      expect(
        app.activeSwarmId,
        first,
        reason: 'an id this window has no tab for changes nothing',
      );

      await app.handleEventForTest('m1', {
        'type': 'dial_swarm',
        'payload': {'swarmId': second},
      });
      expect(app.activeSwarmId, second);
      expect(_desk(app), isEmpty, reason: 'the new swarm has no panes yet');
      app.dispose();
    },
  );

  test('an edge from an older daemon is ignored, not obeyed', () async {
    // A daemon that predates this change still sends `edge` on its focus frames. The field is gone
    // here, and the frame must land as an ordinary selection rather than replacing a tile at an end
    // this build no longer has a rule for.
    final app = await _withTiles(['a2', 'a3', 'a4']);
    app.focusPane(app.panes.last.id);
    await app.handleEventForTest('m1', {
      'type': 'dial_focus',
      'payload': {'machineId': 'm1', 'agentId': 'a1', 'edge': 'head'},
    });

    expect(app.focusedPane?.agentId, 'a1');
    expect(_desk(app), ['a2', 'a3', 'a4', 'a1']);
    app.dispose();
  });

  test('dial_open and dial_focus retain the other agent views', () async {
    // The two verbs side by side, driven through the app's own handler: the same
    // agent, one frame each, and the grid ends up a different size.
    final app = await _withTiles(['a1', 'a2']);
    final first = app.activeSwarmId;
    await app.handleEventForTest('m1', {
      'type': 'dial_open',
      'payload': {'machineId': 'm1', 'agentId': 'a4'},
    });
    // dial_open: a tab of its own, the first tab intact.
    expect(_desk(app), ['a4']);
    expect(
      app.swarms.firstWhere((s) => s.id == first).panes.map((p) => p.agentId),
      ['a1', 'a2'],
    );

    // dial_focus: a tile in the CURRENT tab.
    await dialFocus(app, 'a5');
    expect(_desk(app), ['a4', 'a5'], reason: 'neither event removes a view');
    app.dispose();
  });

  test('a question on the dial brings the agent forward, and never opens a tab', () async {
    // The same frame with reason 'question': an agent on another tab is switched
    // to; one on no tab is left alone. A reconnect re-shows every unanswered
    // question, and each used to open a tab.
    final app = await _withTiles(['a1', 'a2']);
    final first = app.activeSwarmId;
    await app.handleEventForTest('m1', {
      'type': 'dial_open',
      'payload': {'machineId': 'm1', 'agentId': 'a4', 'reason': 'question'},
    });
    expect(app.swarms.length, 1, reason: 'not on screen: nothing opens');
    expect(app.activeSwarmId, first);
    expect(_desk(app), ['a1', 'a2']);

    // On screen, on another tab: that tab comes forward with the agent focused.
    app.newSwarm();
    await app.addAgentToSwarm('m1', 'a4', swarmId: app.activeSwarmId);
    app.selectSwarm(first);
    await app.handleEventForTest('m1', {
      'type': 'dial_open',
      'payload': {'machineId': 'm1', 'agentId': 'a4', 'reason': 'question'},
    });
    expect(app.swarms.length, 2);
    expect(app.activeSwarmId, isNot(first));
    expect(app.focusedPane?.agentId, 'a4');
    app.dispose();
  });

  test(
    'a dial focus adds a missing view while preserving existing members',
    () async {
      final app = await _withTiles(['a1', 'a2', 'a3']);
      app.focusPane(app.panes[1].id);
      await app.selectAgentFromDial('m1', 'a4');

      expect(_desk(app), ['a1', 'a2', 'a3', 'a4']);
      app.dispose();
    },
  );

  // ── the device focuses, a person takes ────────────────────────────────────
  //
  // A dial turned onto a pane another client holds, or a question shown there
  // for one, moves the focus and nothing else: the band stays up with its
  // button. It used to reopen — a takeover — and since the reopen redrew the
  // dialog the daemon was watching, the question came back as a new one and the
  // dial asked again, 1.5s round, until the cable came out (owner, 2026-09-22).
  group('a focus from the device never takes a terminal back', () {
    late AppNotifier app;
    final sent = <String, List<String>>{};

    TerminalSession taken(String id) {
      sent[id] = [];
      return TerminalSession(
        machineId: 'm1',
        agentId: id,
        agentName: id,
        engineId: 'claude',
        send: (type, _) async {
          sent[id]!.add(type);
          return true;
        },
        sendBinary: (_) async => true,
      )..status = TerminalSessionStatus.takenOver;
    }

    List<String> opens(String id) =>
        sent[id]!.where((t) => t == 'terminal_open').toList();

    setUp(() {
      sent.clear();
      app = _notifier();
      // Online and able, so a click WOULD reopen — that is the contrast.
      _machine(app, 'm1', ['a1', 'a2', 'a3'])
        ..nodeOnline = true
        ..terminalCapabilityAvailable = true;
      app.adoptSessionForTest(taken('a1'));
      app.adoptSessionForTest(taken('a2'));
      expect(app.focusedPane?.agentId, 'a2');
    });

    tearDown(() => app.dispose());

    test('the dial turning onto a taken pane only focuses it', () async {
      await dialFocus(app, 'a1');
      expect(app.focusedPane?.agentId, 'a1');
      expect(app.paneFocusByUser, isFalse);
      expect(opens('a1'), isEmpty);
      expect(opens('a2'), isEmpty);
      expect(
        app.paneOfAgent('m1', 'a1')!.session!.status,
        TerminalSessionStatus.takenOver,
        reason: 'the band stays; only a hand on this app presses its button',
      );
    });

    test('a question shown on the dial only brings the pane forward', () async {
      await app.handleEventForTest('m1', {
        'type': 'dial_open',
        'payload': {'machineId': 'm1', 'agentId': 'a1', 'reason': 'question'},
      });
      expect(app.focusedPane?.agentId, 'a1');
      expect(app.paneFocusByUser, isFalse);
      expect(opens('a1'), isEmpty);
      expect(opens('a2'), isEmpty);
    });

    test(
      'a question for a pane on another tab switches to it, takes nothing',
      () async {
        final first = app.activeSwarmId;
        app.newSwarm();
        app.adoptSessionForTest(taken('a3'));
        app.selectSwarm(first);
        expect(app.paneFocusByUser, isTrue, reason: 'selectSwarm by hand');

        await app.handleEventForTest('m1', {
          'type': 'dial_open',
          'payload': {'machineId': 'm1', 'agentId': 'a3', 'reason': 'question'},
        });
        expect(app.activeSwarmId, isNot(first));
        expect(app.focusedPane?.agentId, 'a3');
        expect(app.paneFocusByUser, isFalse);
        for (final id in ['a1', 'a2', 'a3']) {
          expect(opens(id), isEmpty, reason: '$id stays with its holder');
        }
      },
    );

    test('the dial picking a tab is not a person arriving on it', () async {
      final first = app.activeSwarmId;
      app.newSwarm();
      await app.handleEventForTest('m1', {
        'type': 'dial_swarm',
        'payload': {'swarmId': first},
      });
      expect(app.activeSwarmId, first);
      expect(app.paneFocusByUser, isFalse);
    });

    test('a click on the same pane still takes it back', () async {
      // The contrast: the ordinary selection reopens a dead pane, and a taken
      // pane is dead by its measure. That is the person's path and stays.
      await app.selectAgent('m1', 'a1');
      expect(app.paneFocusByUser, isTrue);
      expect(opens('a1'), ['terminal_open']);
    });
  });
}
