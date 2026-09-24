import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show MemoryStore;

class WorkspaceAccountLogin extends CliLogin {
  var logins = 0;
  @override
  Future<void> logout() async {}
  @override
  Future<void> login({required void Function(String) onAuthorizeUrl}) async {
    logins++;
  }

  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<LocalCliProbe> ensureRunning({
    Duration timeout = const Duration(seconds: 15),
    Duration readyTimeout = LocalCliDiscovery.defaultReadyTimeout,
  }) async => const LocalCliProbe.down('fixture signed out');
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

class _Api extends ApiClient {
  _Api()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  var inventoryRequests = 0;
  @override
  Future<Map<String, dynamic>?> me() async => {
    'user': {'id': 'fixture-account', 'email': 'fixture@example.invalid'},
  };
  @override
  Future<List<Machine>> machines() async {
    inventoryRequests++;
    return [];
  }
}

class WorkspaceAccountFixture extends AppNotifier {
  WorkspaceAccountFixture(MemoryStore storage, this.cli)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(storage: MemoryStore()),
        cliLogin: cli,
        localCliDiscovery: _Discovery(),
        paneLayoutStore: PaneLayoutStore(storage: storage),
      ) {
    api = _Api();
    status = AppStatus.authenticated;
  }
  final WorkspaceAccountLogin cli;
  int get inventoryRequests => (api as _Api).inventoryRequests;

  /// The id a signed-out daemon serves this computer under, for a test whose
  /// guest window should find this computer in its machine list and re-seat
  /// the desk onto it. Left null, the guest's list names no machine, and the
  /// desk is not re-seated at all.
  String? guestComputerId;

  @override
  Future<bool> refreshMachines() async {
    final id = guestComputerId;
    if (signedIn || id == null) return super.refreshMachines();
    final machine = Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: 'This computer',
    );
    machines = [machine];
    machineStates
      ..clear()
      ..[id] = (MachineState(machine)..localOnly = true);
    return true;
  }

  var expiring = false;
  @override
  Future<void> ensureCliDaemonReady() async {
    if (!expiring) return;
    expiring = false;
    await super.ensureCliDaemonReady();
  }

  /// The session ends underneath a running window: the daemon gate finds the
  /// daemon gone and the CLI signed out.
  ///
  /// The window no longer drops to a sign-in wall; it becomes a guest, and a
  /// daemon now comes back WITHOUT a session, so every later gate passes. This
  /// waits for that guest transition to land on the desk.
  Future<void> expire() async {
    expiring = true;
    try {
      await ensureCliDaemonReady();
    } on StateError {
      // THIS probe's daemon did not start, and the gate still says so; the
      // guest transition it handed the window to does not depend on it.
    }
    for (var turn = 0; turn < 100; turn++) {
      await Future<void>.value();
    }
  }
}

class _HeldStore extends MemoryStore {
  String? blocked;
  final reading = Completer<void>();
  final answer = Completer<String?>();
  @override
  Future<String?> read(String key) {
    if (key == blocked) {
      blocked = null;
      reading.complete();
      return answer.future;
    }
    return super.read(key);
  }
}

Future<void> arrangeAccountWorkspace(WorkspaceAccountFixture app) async {
  app.renameSwarm(app.activeSwarmId, 'Research');
  app.adoptSessionForTest(terminal('a', []));
  final second = app.adoptSessionForTest(terminal('b', []));
  app.togglePinPane(second.id);
  app.setPreset(2, PanePreset.rows);
  app.toggleZoomPane();
  app.newSwarm(name: 'Build');
  app.adoptSessionForTest(terminal('c', []));
  // Adopting fixture sessions does not write layout until an actual UI action.
  app.renameSwarm(app.activeSwarmId, 'Build');
  await app.flushPaneLayout();
}

void main() {
  for (final expires in [false, true]) {
    test(
      '${expires ? 'expiry' : 'sign-out'} restores all tabs and their arrangement on sign-in',
      () async {
        final storage = MemoryStore();
        final app = WorkspaceAccountFixture(storage, WorkspaceAccountLogin());
        addTearDown(app.dispose);
        await arrangeAccountWorkspace(app);
        final saved = storage.values['swarm_layout_v1'];
        final selected = app.activeSwarmId;
        if (expires) {
          await app.expire();
        } else {
          await app.logout();
        }
        // The account leaving no longer puts a sign-in wall in front of the
        // desk: the window stays on it as a guest.
        expect(app.status, AppStatus.authenticated);
        expect(app.isGuest, isTrue);
        if (!expires) {
          // Signing out still takes the account's tiles off the screen.
          expect(app.allPanes, isEmpty);
          expect(app.swarms, hasLength(1));
        }
        // An expiry leaves the live desk where it is: which of its tiles
        // follow this computer is decided by the re-seat, once the guest
        // daemon says which id it serves (pinned in guest_window_test.dart).
        // Here it names no machine, so nothing is re-seated, and either way
        // the account's saved desk is not overwritten on the way out.
        expect(storage.values['swarm_layout_v1'], saved);
        await app.login();
        expect(app.status, AppStatus.authenticated);
        expect(app.swarms.map((s) => s.name), ['Research', 'Build']);
        expect(app.allPanes.map((p) => p.agentId), ['a', 'b', 'c']);
        expect(app.activeSwarmId, selected);
        final research = app.swarms.first;
        expect(research.focusedPaneId, research.panes.last.id);
        expect(research.zoomedPaneId, research.panes.last.id);
        expect(research.presets[2], PanePreset.rows);
        expect(research.pinnedSlots.keys, [research.panes.last.id]);
      },
    );
  }

  test(
    'runtime expiry clears machine inventory and recently closed work',
    () async {
      final app = WorkspaceAccountFixture(
        MemoryStore(),
        WorkspaceAccountLogin(),
      );
      addTearDown(app.dispose);
      const machine = Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'Old machine',
      );
      app.machines = [machine];
      app.machineStates['m'] = MachineState(machine);
      app.machinesAreStale = true;
      final pane = app.adoptSessionForTest(terminal('closed', []));
      await app.closePane(pane.id);
      expect(app.closedHistory, isNotEmpty);
      await app.expire();
      expect(app.isGuest, isTrue);
      expect(app.machines, isEmpty);
      expect(app.machineStates, isEmpty);
      expect(app.machinesAreStale, isFalse);
      expect(app.closedHistory, isEmpty);
      expect(app.lastError, contains('sign in again'));
    },
  );

  for (final key in [
    'swarm_layout_v1',
    'terminal_pane_presets',
    'terminal_pane_layout',
  ]) {
    for (final expires in [false, true]) {
      test(
        'late $key cannot restore work after ${expires ? 'expiry' : 'sign-out'}',
        () async {
          final storage = _HeldStore()..blocked = key;
          final app = WorkspaceAccountFixture(storage, WorkspaceAccountLogin());
          addTearDown(app.dispose);
          final restoring = app.restorePaneLayoutForTest();
          await storage.reading.future;
          if (expires) {
            await app.expire();
          } else {
            await app.logout();
          }
          storage.answer.complete(switch (key) {
            'swarm_layout_v1' => jsonEncode({
              'version': 1,
              'activeId': 'private',
              'swarms': [
                {
                  'id': 'private',
                  'name': 'Old work',
                  'panes': [
                    {'machineId': 'm', 'agentId': 'old'},
                  ],
                },
              ],
            }),
            'terminal_pane_presets' => '{"2":"rows"}',
            _ => '[{"machineId":"m","agentId":"old"}]',
          });
          await restoring;
          expect(app.allPanes, isEmpty);
          expect(app.panePresets, isEmpty);
          expect(app.swarms.single.name, isNot('Old work'));
        },
      );
    }
  }

  for (final cancel in [false, true]) {
    test(
      'sign-in ${cancel ? 'can be cancelled while waiting for' : 'waits for'} expired terminal cleanup',
      () async {
        final cli = WorkspaceAccountLogin();
        // The guest daemon names this computer, so the expiry re-seats the
        // desk: the tile on the other machine leaves with the account, and its
        // terminal detaching is the cleanup a sign-in must not overtake.
        final app = WorkspaceAccountFixture(MemoryStore(), cli)
          ..guestComputerId = 'computer-abc';
        addTearDown(app.dispose);
        final closed = Completer<bool>();
        app.adoptSessionForTest(
          TerminalSession(
            machineId: 'm',
            agentId: 'a',
            agentName: 'Fixture',
            engineId: 'codex',
            send: (type, _) =>
                type == 'terminal_close' ? closed.future : Future.value(true),
            sendBinary: (_) async => true,
          )..streamId = 'fixture',
        );
        await app.expire();
        final login = app.login();
        await Future<void>.delayed(Duration.zero);
        expect(cli.logins, 0);
        if (cancel) app.cancelLogin();
        closed.complete(true);
        await login;
        expect(cli.logins, cancel ? 0 : 1);
        expect(
          app.status,
          cancel ? AppStatus.unauthenticated : AppStatus.authenticated,
        );
      },
    );
  }
}
