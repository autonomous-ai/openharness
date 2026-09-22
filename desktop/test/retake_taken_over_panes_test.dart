import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'swarm_state_test.dart' show createApp;

/// One gesture on the app takes back every stream another client took from
/// it — and nothing else: a pane that is fine, one that closed on its own, a
/// shared read-only view, or one the daemon would refuse are all left alone.
void main() {
  late AppNotifier app;
  final sent = <String, List<String>>{};

  TerminalSession session(
    String id, {
    String machineId = 'm',
    TerminalSessionStatus status = TerminalSessionStatus.takenOver,
    bool readOnly = false,
  }) {
    sent[id] = [];
    return TerminalSession(
      machineId: machineId,
      agentId: id,
      agentName: 'Session $id',
      engineId: 'codex',
      readOnly: readOnly,
      send: (type, _) async {
        sent[id]!.add(type);
        return true;
      },
      sendBinary: (_) async => true,
    )..status = status;
  }

  List<String> opens(String id) =>
      sent[id]!.where((t) => t == 'terminal_open').toList();

  setUp(() {
    sent.clear();
    app = createApp();
    app.stateOf('m')!
      ..nodeOnline = true
      ..terminalCapabilityAvailable = true;
  });

  tearDown(() => app.dispose());

  test(
    'reopens every taken-over pane the daemon would accept, and only those',
    () async {
      app.adoptSessionForTest(session('a0'));
      app.adoptSessionForTest(
        session('a1', status: TerminalSessionStatus.controlling),
      );
      // closed/error are the auto-reattach's business, not a person's return.
      app.adoptSessionForTest(
        session('a2', status: TerminalSessionStatus.closed),
      );
      app.adoptSessionForTest(session('a3', readOnly: true));

      await app.retakeTakenOverPanes();

      expect(opens('a0'), ['terminal_open']);
      expect(opens('a1'), isEmpty);
      expect(opens('a2'), isEmpty);
      expect(opens('a3'), isEmpty);
      expect(
        app.paneOfAgent('m', 'a0')!.session!.status,
        TerminalSessionStatus.opening,
      );

      // Already opening: a second gesture sends nothing more.
      await app.retakeTakenOverPanes();
      expect(opens('a0'), ['terminal_open']);
    },
  );

  test('a pane behind another tab is this app\'s too', () async {
    app.adoptSessionForTest(session('a0'));
    app.newSwarm();
    app.adoptSessionForTest(session('a1'));
    expect(app.activeSwarm.panes.map((p) => p.agentId), ['a1']);

    await app.retakeTakenOverPanes();
    expect(opens('a0'), ['terminal_open']);
    expect(opens('a1'), ['terminal_open']);
  });

  test('a pane the daemon would refuse keeps its band', () async {
    const offline = Machine(
      machineId: 'm2',
      authMode: MachineAuthMode.remote,
      name: 'Away',
    );
    app.machines = [...app.machines, offline];
    app.machineStates['m2'] = MachineState(offline)
      ..nodeOnline = false
      ..terminalCapabilityAvailable = true
      ..agents = const [
        Agent(
          id: 'b0',
          name: 'Away agent',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
    app.adoptSessionForTest(session('b0', machineId: 'm2'));
    app.adoptSessionForTest(session('a0'));

    await app.retakeTakenOverPanes();
    expect(opens('a0'), ['terminal_open']);
    expect(opens('b0'), isEmpty);
    expect(
      app.paneOfAgent('m2', 'b0')!.session!.status,
      TerminalSessionStatus.takenOver,
    );
  });
}
