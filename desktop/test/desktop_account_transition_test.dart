import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/viewer/device_log_sync.dart' show DeviceLogDeparted;

import 'swarm_state_test.dart' show MemoryStore;

class _Login extends CliLogin {
  var logins = 0;
  Completer<void>? pending;
  bool fail = false;

  @override
  Future<void> logout() async {}

  @override
  Future<void> login({
    required void Function(String) onAuthorizeUrl,
    SignInProvider? provider,
  }) async {
    logins++;
    await pending?.future;
    if (fail) throw StateError('Fixture sign-in failed.');
  }
}

class _Api extends ApiClient {
  _Api()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );

  @override
  Future<Map<String, dynamic>?> me() async => null;
}

/// An account desk that records what this window sends it.
class _DeskApi extends _Api {
  final ops = <Map<String, dynamic>>[];
  final _tabs = <Object?>[];
  var _revision = 0;

  Map<String, dynamic> get _doc => {'revision': _revision, 'tabs': _tabs};

  @override
  Future<Map<String, dynamic>?> desk() async => _doc;

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> sent) async {
    ops.addAll(sent);
    for (final op in sent) {
      if (op['op'] == 'seed') _tabs.addAll(op['tabs'] as List);
    }
    _revision++;
    return _doc;
  }
}

class _Desktop extends AppNotifier {
  _Desktop(this.storage, this.loginFixture)
    : super(
        config: AppConfig.dev,
        configStore: null,
        authSession: AuthSession(storage: MemoryStore()),
        cliLogin: loginFixture,
        paneLayoutStore: PaneLayoutStore(storage: storage),
      ) {
    api = _Api();
    status = AppStatus.authenticated;
  }

  final MemoryStore storage;
  final _Login loginFixture;
  var guestInventoryAvailable = true;
  var daemonGates = 0;

  @override
  Future<void> ensureCliDaemonReady() async {
    daemonGates++;
  }

  @override
  Future<bool> refreshMachines() async {
    machines = [];
    machineStates.clear();
    if (!signedIn && !guestInventoryAvailable) return true;
    final id = signedIn ? 'account-local' : 'computer-local';
    final machine = Machine(
      machineId: id,
      computerId: 'computer-local',
      authMode: MachineAuthMode.remote,
      name: 'This computer',
    );
    machines = [machine];
    machineStates[id] = MachineState(machine)..localOnly = true;
    return true;
  }

  Future<void> arrange({Completer<bool>? detach}) async {
    await refreshMachines();
    await PaneLayoutStore(storage: storage).saveLocalMachineId('account-local');
    renameSwarm(activeSwarmId, 'Research');
    for (final (machine, agent) in [
      ('account-local', 'local-agent'),
      ('remote', 'remote-agent'),
    ]) {
      adoptSessionForTest(
        TerminalSession(
          machineId: machine,
          agentId: agent,
          agentName: agent,
          engineId: 'codex',
          send: (type, _) => type == 'terminal_close' && detach != null
              ? detach.future
              : Future.value(true),
          sendBinary: (_) async => true,
        )..streamId = agent,
      );
    }
    renameSwarm(activeSwarmId, 'Research');
    await flushPaneLayout();
  }
}

class _HeldWrite extends MemoryStore {
  bool hold = false;
  final writing = Completer<void>();
  final release = Completer<void>();

  @override
  Future<void> write(String key, String value) async {
    if (hold && key == 'swarm_layout_v1') {
      hold = false;
      writing.complete();
      await release.future;
    }
    await super.write(key, value);
  }
}

class _RefusingWrite extends MemoryStore {
  bool fail = false;

  @override
  Future<void> write(String key, String value) async {
    if (fail && key == 'swarm_layout_v1') throw StateError('Fixture disk full');
    await super.write(key, value);
  }
}

Future<void> _settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test(
    'a failed guest layout write preserves the old identity and can retry',
    () async {
      final storage = _RefusingWrite();
      final app = _Desktop(storage, _Login());
      addTearDown(app.dispose);
      await app.arrange();
      final saved = storage.values['swarm_layout_v1'];
      storage.fail = true;
      app.expireSessionForTest('Session expired.');
      await _settle();
      expect(storage.values['swarm_layout_v1'], saved);
      expect(storage.values['local_machine_id'], 'account-local');
      expect(app.allPanes, isEmpty);
      expect(app.lastError, contains('restore'));
      storage.fail = false;
      await app.retryMachines();
      expect(app.allPanes.map((p) => (p.machineId, p.agentId)), [
        ('computer-local', 'local-agent'),
      ]);
      expect(storage.values['local_machine_id'], 'computer-local');
    },
  );

  for (final expires in [false, true]) {
    test(
      'desktop ${expires ? 'expiry' : 'sign-out'} preserves local work',
      () async {
        final storage = MemoryStore();
        final app = _Desktop(storage, _Login());
        addTearDown(app.dispose);
        await app.arrange();
        if (expires) {
          app.expireSessionForTest('Session expired. Sign in again.');
        } else {
          await app.logout();
        }
        await _settle();
        expect(app.isGuest, isTrue);
        expect(app.status, AppStatus.authenticated);
        expect(app.allPanes.map((p) => (p.machineId, p.agentId)), [
          ('computer-local', 'local-agent'),
        ]);
        expect(app.swarms.single.name, 'Research');
        expect(app.sessionExpired, expires);
        final saved = jsonDecode(storage.values['swarm_layout_v1']!);
        expect(saved['swarms'][0]['panes'], hasLength(1));
        await app.login();
        expect(app.allPanes.map((p) => (p.machineId, p.agentId)), [
          ('account-local', 'local-agent'),
        ]);
      },
    );
  }

  test(
    'a runtime sign-out forgets what was said about the old account’s devices',
    () async {
      final app = _Desktop(MemoryStore(), _Login());
      addTearDown(app.dispose);
      await app.arrange();
      app.newDevices.add(
        const NewDeviceNotice(pub: 'p', label: 'iPad', kind: 'viewer'),
      );
      app.departedDevices.add(
        const DeviceLogDeparted(
          pub: 'g',
          label: 'Phone',
          kind: 'viewer',
          machineId: '',
          fingerprint: 'AAAA',
          addedAt: 1,
          removedAt: 2,
          removedBy: 'x',
          removedByLabel: 'Mac',
          selfRemoved: false,
        ),
      );
      app.deviceConflict = DeviceConflict(
        pub: 'h',
        label: 'H',
        fingerprint: 'AAAA',
        addedAt: DateTime.fromMillisecondsSinceEpoch(1),
        afterJoin: true,
      );
      app.expireSessionForTest('Session expired.');
      await _settle();
      expect(app.newDevices, isEmpty);
      expect(app.departedDevices, isEmpty);
      expect(app.deviceConflict, isNull);
      expect(app.deviceRemovals, isEmpty);
    },
  );

  test(
    'expiry hides remote panes even when the guest daemon is unavailable',
    () async {
      final storage = MemoryStore();
      final app = _Desktop(storage, _Login())..guestInventoryAvailable = false;
      addTearDown(app.dispose);
      await app.arrange();
      final saved = storage.values['swarm_layout_v1'];
      app.expireSessionForTest('Session expired.');
      await _settle();
      expect(app.allPanes.where((pane) => pane.machineId == 'remote'), isEmpty);
      expect(storage.values['swarm_layout_v1'], saved);
      expect(app.sessionExpired, isTrue);
      app.guestInventoryAvailable = true;
      await app.retryMachines();
      expect(app.allPanes.map((p) => (p.machineId, p.agentId)), [
        ('computer-local', 'local-agent'),
      ]);
    },
  );

  for (final cancel in [false, true]) {
    test(
      'desktop sign-in ${cancel ? 'cancels during' : 'waits for'} guest teardown',
      () async {
        final cli = _Login();
        final app = _Desktop(MemoryStore(), cli);
        addTearDown(app.dispose);
        final detached = Completer<bool>();
        await app.arrange(detach: detached);
        app.expireSessionForTest('Session expired.');
        await _settle();
        final login = app.login();
        await _settle();
        expect(cli.logins, 0);
        if (cancel) app.cancelLogin();
        detached.complete(true);
        await login;
        await _settle();
        expect(cli.logins, cancel ? 0 : 1);
        expect(app.status, AppStatus.authenticated);
        expect(app.isGuest, cancel);
        expect(
          app.allPanes.map((p) => (p.machineId, p.agentId)),
          contains((
            cancel ? 'computer-local' : 'account-local',
            'local-agent',
          )),
        );
      },
    );
  }

  test(
    'cancelling a guest sign-in keeps the local workspace available',
    () async {
      final cli = _Login()..pending = Completer<void>();
      final app = _Desktop(MemoryStore(), cli)..signedIn = false;
      addTearDown(app.dispose);
      final login = app.login();
      await _settle();
      app.cancelLogin();
      expect(app.status, AppStatus.authenticated);
      expect(app.isGuest, isTrue);
      cli.pending!.complete();
      await login;
      expect(app.signedIn, isFalse);
      expect(app.status, AppStatus.authenticated);
    },
  );

  test(
    "a tab made signed out reaches the desk on the account's machine id",
    () async {
      final app = _Desktop(MemoryStore(), _Login())..signedIn = false;
      addTearDown(app.dispose);
      final desk = _DeskApi();
      app.api = desk;
      await app.refreshMachines();
      app.adoptSessionForTest(
        TerminalSession(
          machineId: 'computer-local',
          agentId: 'guest-agent',
          agentName: 'Guest',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        )..streamId = 'guest',
      );
      app.renameSwarm(app.activeSwarmId, 'Made signed out');
      await app.flushPaneLayout();

      await app.login();
      await _settle();

      final seeded = [
        for (final op in desk.ops)
          if (op['op'] == 'seed') ...(op['tabs'] as List).cast<Map>(),
      ];
      final onDesk = {
        for (final tab in seeded)
          for (final pane in (tab['panes'] as List).cast<Map>())
            pane['machineId'],
      };
      expect(onDesk, isNot(contains('computer-local')));
      expect(onDesk, contains('account-local'));
      expect(
        app.allPanes.map((pane) => pane.machineId),
        everyElement('account-local'),
      );
    },
  );

  test('failed guest sign-in keeps the local workspace available', () async {
    final app = _Desktop(MemoryStore(), _Login()..fail = true)
      ..signedIn = false;
    addTearDown(app.dispose);
    await app.login();
    expect(app.isGuest, isTrue);
    expect(app.status, AppStatus.authenticated);
    expect(app.lastError, contains('Fixture sign-in failed'));
  });

  test(
    'sign-in waits for a guest layout write and follows its committed identity',
    () async {
      final storage = _HeldWrite();
      final cli = _Login();
      final app = _Desktop(storage, cli);
      addTearDown(app.dispose);
      await app.arrange();
      storage.hold = true;
      app.expireSessionForTest('Session expired.');
      await storage.writing.future;
      final login = app.login();
      await _settle();
      expect(cli.logins, 0);
      storage.release.complete();
      await login;
      await _settle();
      expect(cli.logins, 1);
      expect(storage.values['local_machine_id'], 'account-local');
      expect(app.allPanes.map((p) => (p.machineId, p.agentId)), [
        ('account-local', 'local-agent'),
      ]);
    },
  );
}
