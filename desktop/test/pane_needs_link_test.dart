// A tile whose machine is not linked is not a dead end.
//
// It used to say "<machine> is not linked to this computer yet." and stop
// there: the only way on was to know that ⌘M opens the Machines panel, find
// the row and press Connect. The way in belongs where the person is looking,
// so the tile asks for the machine's remote password itself — the same card
// the panel opens, which closes on its own the moment the link lands.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'swarm_screen_test.dart' show terminal;

class _Link implements CliLink {
  _Link(this.onConnect);
  final Future<CliLinkConnectResult> Function(String machineId, String password)
  onConnect;
  final asked = <String>[];

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) {
    asked.add(password);
    return onConnect(machineId, password);
  }

  @override
  Future<RemotePasswordSetResult> setRemotePassword(String password) async =>
      const RemotePasswordSetResult();

  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async =>
      const RemotePasswordStatus(hasPassword: false);

  @override
  Future<String?> clearRemotePassword() async => null;

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();

  @override
  Future<String?> unlink(String machineId) async => null;
}

void main() {
  late _Link link;
  late AppNotifier app;

  AppNotifier appWith({bool local = false}) {
    final built = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLink: link,
    )..hasNavigationRail = false;
    const machine = Machine(
      machineId: 'remote-1',
      authMode: MachineAuthMode.remote,
      name: 'build-box',
    );
    built.machines = [machine];
    built.machineStates['remote-1'] = MachineState(machine)
      ..localOnly = local
      ..nodeOnline = true
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink
      ..agents = [const Agent(id: 'a0', name: 'A0', terminalAvailable: true)];
    return built;
  }

  setUp(() {
    link = _Link(
      (machineId, _) async => CliLinkConnectResult(linkedMachineId: machineId),
    );
  });

  Future<void> pump(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1100, 760);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: app,
            builder: (_, _) => PaneGrid(notifier: app, swarmMode: false),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  Future<void> finish(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  }

  /// A tile on the unlinked machine, with nothing attached to it.
  void placeEmptyPane() {
    app.activeSwarm.panes.add(
      TerminalPane(id: 1, machineId: 'remote-1', agentId: 'a0'),
    );
  }

  testWidgets('the tile says how, and its button asks for the password', (
    tester,
  ) async {
    app = appWith();
    placeEmptyPane();
    await pump(tester);

    expect(
      find.textContaining('is not linked to this computer yet'),
      findsOneWidget,
    );
    expect(
      find.textContaining('remote password'),
      findsWidgets,
      reason: 'the sentence says what the button will ask for',
    );

    await tester.tap(find.text('Link…'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('remote-password-connect-field')),
      findsOneWidget,
    );
    await finish(tester);
  });

  testWidgets('the password links the machine and the card closes itself', (
    tester,
  ) async {
    app = appWith();
    placeEmptyPane();
    await pump(tester);
    await tester.tap(find.text('Link…'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('remote-password-connect-field')),
      'correct horse battery staple',
    );
    await tester.tap(find.text('enter  link machine'));
    await tester.pumpAndSettle();

    expect(link.asked, ['correct horse battery staple']);
    expect(app.stateOf('remote-1')!.needsLink, isFalse);
    expect(
      find.byKey(const Key('remote-password-connect-field')),
      findsNothing,
      reason: 'the card is done the moment the link lands',
    );
    await finish(tester);
  });

  testWidgets('a tile still showing its last screen gets the same way out', (
    tester,
  ) async {
    app = appWith();
    final session = terminal('a0', <TerminalBinaryFrame>[]);
    app.adoptSessionForTest(session);
    app.panes.single.machineId = 'remote-1';
    await pump(tester);

    // The header's own button, over the retained output — the detail sits in
    // its tooltip, so the label is what is on screen.
    expect(
      find.byKey(const Key('remote-password-connect-field')),
      findsNothing,
      reason: 'nothing asked yet',
    );
    await tester.tap(find.text('Link required'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('remote-password-connect-field')),
      findsOneWidget,
    );
    await finish(tester);
  });

  testWidgets('a linked machine says nothing about linking', (tester) async {
    app = appWith();
    app.stateOf('remote-1')!
      ..needsLink = false
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..terminalCapabilityAvailable = true;
    placeEmptyPane();
    await pump(tester);

    expect(find.text('Link…'), findsNothing);
    await finish(tester);
  });
}
