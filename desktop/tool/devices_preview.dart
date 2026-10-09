// Interactive review combining the Devices work from site-apple and ab-mac-3.
// Build with scripts/build-devices-review.sh. All hardware and storage are fake.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/devices/devices_controller.dart';
import 'package:harness/devices/devices_harness_controller.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/dial_status.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:window_manager/window_manager.dart';

Future<void> main() async {
  if (!kDebugMode ||
      !kUnderTest ||
      !const bool.fromEnvironment('DEVICES_REVIEW')) {
    throw StateError(
      'Preview requires HARNESS_TEST and DEVICES_REVIEW in a debug build.',
    );
  }
  WidgetsFlutterBinding.ensureInitialized();
  grid.AppTheme.palette.value = HarnessPalette.paper;
  grid.AppTheme.brightness.value = Brightness.light;
  await windowManager.ensureInitialized();
  await const MethodChannel(
    'harness/swarm_tabs',
  ).invokeMethod('configure', {'palette': HarnessPalette.paper.nativeColors});
  await windowManager.setSize(const Size(1360, 1040));
  await windowManager.setTitle('Devices Review — sample hardware');
  final app = DevicesReviewApp();
  await app.prepare();
  runApp(_Preview(app: app));
  await windowManager.show();
  await windowManager.focus();
}

class DevicesReviewStorage implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

class _Experiments implements ExperimentalSettingsTransport {
  final features = {
    for (final feature in ExperimentalFeature.values) feature.id: false,
  };
  int revision = 0;
  @override
  Future<Map<String, dynamic>> read() async => {
    'accountId': 'preview',
    'revision': revision,
    'features': Map.of(features),
  };
  @override
  Future<Map<String, dynamic>> write(
    String account,
    ExperimentalFeature feature,
    bool enabled,
  ) async {
    features[feature.id] = enabled;
    revision++;
    return read();
  }
}

/// Shared by the standalone review and native integration test. Never talks to
/// the real daemon or writes the signed-in person's preferences.
class DevicesReviewApp extends AppNotifier {
  DevicesReviewApp() : this._(DevicesReviewStorage());
  DevicesReviewApp._(this.storage)
    : super(
        config: const AppConfig(
          apiBaseUrl: 'http://127.0.0.1:1',
          localCliBaseUrl: 'http://127.0.0.1:1',
        ),
        authSession: AuthSession(),
        paneLayoutStore: PaneLayoutStore(storage: storage),
        experimentalSettingsTransport: _Experiments(),
      ) {
    if (!kUnderTest) throw StateError('Devices review requires test mode.');
    status = AppStatus.authenticated;
    hasNavigationRail = false;
    currentUser = const CurrentUserProfile(
      id: 'preview',
      email: 'preview@example.test',
    );
    const hosts = [
      Machine(
        machineId: 'studio-mac',
        authMode: MachineAuthMode.remote,
        name: 'Studio Mac',
      ),
      Machine(
        machineId: 'office-mac',
        authMode: MachineAuthMode.remote,
        name: 'Office Mac',
      ),
      Machine(
        machineId: 'workshop-pc',
        authMode: MachineAuthMode.remote,
        name: 'Workshop PC',
      ),
    ];
    machines = hosts;
    for (final host in hosts) {
      machineStates[host.machineId] = MachineState(host)
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..localOnly = host.machineId == 'studio-mac'
        ..nodeOnline = host.machineId != 'workshop-pc'
        ..connectionStatus = host.machineId == 'workshop-pc'
            ? ConnectionStatus.disconnected
            : ConnectionStatus.connected;
    }
    notifyListeners();
  }

  final DevicesReviewStorage storage;
  final _samples = <DialStatus>[];
  final _sampleHosts = <String>[];
  final writes = <(String, String, Map<String, Object?>)>[];
  bool _ended = false;

  Future<void> prepare({
    bool empty = false,
    bool conversationReady = true,
  }) async {
    await experimentalFeatures.refresh();
    if (!empty) {
      for (var i = 0; i < 5; i++) {
        connectSample(
          machineId: i < 2
              ? 'studio-mac'
              : i < 4
              ? 'office-mac'
              : 'workshop-pc',
        );
      }
      const names = [
        'Studio',
        'Home office',
        'Design desk',
        'Workshop',
        'Travel',
      ];
      await storage.write(
        'harness_devices_v1.preview',
        jsonEncode([
          for (var i = 0; i < _samples.length; i++)
            HarnessDevice(
              key:
                  '${_sampleHosts[i]}/${DevicesController.identity(_samples[i])}',
              name: names[i],
              model: i < 2
                  ? HarnessDeviceModel.harness
                  : HarnessDeviceModel.pro,
              status: _samples[i],
              machineId: _sampleHosts[i],
              machineName: machineStates[_sampleHosts[i]]!.machine.displayName,
            ).toJson(),
        ]),
      );
    }
    openDevices();
    if (!conversationReady) return;
    machineStates['studio-mac']!.agents = [
      const Agent(
        id: 'review-devices',
        name: 'Devices',
        engine: 'codex',
        dsh: devicesHarnessId,
        terminalAvailable: true,
      ),
    ];
    await showDevicesTerminal('studio-mac', 'review-devices');
  }

  @override
  Future<void> showDevicesTerminal(String machineId, String agentId) async {
    final tab = swarms.where((tab) => tab.isDevices).firstOrNull;
    if (tab == null || tab.panes.any((pane) => pane.agentId == agentId)) return;
    tab.panes.firstWhere((pane) => pane.isDevices)
      ..machineId = machineId
      ..ownerAgentId = agentId;
    final session =
        TerminalSession(
            machineId: machineId,
            agentId: agentId,
            agentName: 'Devices',
            engineId: 'codex',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'devices-review';
    session.terminal.write(
      'Devices\r\n\r\nYour Harness hardware, across your computers.\r\n\r\nTry the controls in the dashboard.\r\n\r\nThis review uses sample hardware and a\r\nsample conversation. No agent is running.\r\n',
    );
    final pane = tab.panes
        .where((pane) => !pane.isViewer && pane.agentId == null)
        .firstOrNull;
    if (pane != null) {
      pane
        ..machineId = machineId
        ..agentId = agentId
        ..session = session;
    } else {
      tab.panes.add(
        TerminalPane(id: 900001, machineId: machineId, agentId: agentId)
          ..session = session,
      );
    }
    tab.paneSizes['2:manual'] = PaneArrangement.viewerBesideTerminal;
    notifyListeners();
  }

  void connectSample({bool attached = true, String machineId = 'studio-mac'}) {
    final i = _samples.length;
    _sampleHosts.add(machineId);
    _samples.add(
      DialStatus.fromJson({
        'id': 'preview-$i',
        'mac': '02:00:00:00:00:${i.toRadixString(16).padLeft(2, '0')}',
        'attached': attached,
        'fw': '0.0.101',
        'settings': {
          'brightness': 80,
          'character': 2,
          'face': 466,
          'round': true,
          'muted': true,
          'quiet': false,
          'straightTitle': true,
          'focusFace': false,
          'scrollReversed': false,
          'voiceLang': 'en',
        },
      }),
    );
    _publish();
  }

  DialStatus _copy(
    DialStatus device, {
    bool? attached,
    Map<String, Object?>? patch,
  }) => DialStatus(
    id: device.id,
    mac: device.mac,
    fw: device.fw,
    attached: attached ?? device.attached,
    settings: patch == null
        ? device.settings
        : DeviceSettings.fromJson({...device.settings!.toJson(), ...patch}),
  );

  void setConnected(bool connected) {
    for (final host in machineStates.values) {
      host.nodeOnline = connected;
      host.connectionStatus = connected
          ? ConnectionStatus.connected
          : ConnectionStatus.disconnected;
    }
    for (var i = 0; i < _samples.length; i++) {
      _samples[i] = _copy(_samples[i], attached: connected);
    }
    _publish();
  }

  void _publish() {
    notifyListeners();
    for (final host in machineStates.values) {
      final devices = [
        for (var i = 0; i < _samples.length; i++)
          if (_sampleHosts[i] == host.machine.machineId) _samples[i],
      ];
      final snapshot = DialStatus(
        attached: devices.any((d) => d.attached),
        devices: devices,
      );
      deviceHosts.receive(host.machine.machineId, snapshot);
      if (host.isLocalMachine) dial.apply(snapshot);
    }
  }

  @override
  Future<void> refreshDevices() async {
    await Future<void>.delayed(Duration.zero);
    if (!_ended) _publish();
  }

  @override
  Future<bool> setHostDeviceSettings(
    String machineId,
    String id,
    Map<String, Object?> patch,
  ) async {
    writes.add((machineId, id, Map.of(patch)));
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (_ended) return false;
    final i = _samples.indexWhere((d) => d.id == id && d.attached);
    if (i < 0 ||
        _sampleHosts[i] != machineId ||
        deviceHosts.host(machineId)?.online != true) {
      return false;
    }
    _samples[i] = _copy(_samples[i], patch: patch);
    _publish();
    return true;
  }

  @override
  void dispose() {
    _ended = true;
    super.dispose();
  }
}

class _Preview extends StatefulWidget {
  const _Preview({required this.app});
  final DevicesReviewApp app;
  @override
  State<_Preview> createState() => _PreviewState();
}

class _PreviewState extends State<_Preview> {
  late DevicesReviewApp app = widget.app;
  bool dark = false, empty = false, switching = false;

  Future<void> _toggleSamples() async {
    if (switching) return;
    setState(() => switching = true);
    // Unmount before replacing the app: disposal clears its native channel.
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted) return;
    app.dispose();
    final next = DevicesReviewApp();
    await next.prepare(empty: !empty);
    if (!mounted) {
      next.dispose();
      return;
    }
    setState(() {
      app = next;
      empty = !empty;
      switching = false;
    });
  }

  @override
  void dispose() {
    app.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(
      brightness: dark ? Brightness.dark : Brightness.light,
    ),
    builder: (context, child) => grid.BrightnessScope(child: child!),
    home: Column(
      children: [
        Material(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Wrap(
              spacing: 12,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                const Text('Devices review · Sample hardware'),
                TextButton(
                  onPressed: () => setState(() {
                    dark = !dark;
                    grid.AppTheme.palette.value = dark
                        ? HarnessPalette.graphite
                        : HarnessPalette.paper;
                    grid.AppTheme.brightness.value = dark
                        ? Brightness.dark
                        : Brightness.light;
                  }),
                  child: Text(dark ? 'Light appearance' : 'Dark appearance'),
                ),
                TextButton(
                  onPressed: switching ? null : _toggleSamples,
                  child: Text(empty ? 'Show five devices' : 'Show empty state'),
                ),
                TextButton(
                  onPressed: switching ? null : () => app.connectSample(),
                  child: const Text('Connect sample device'),
                ),
                ListenableBuilder(
                  listenable: app.dial,
                  builder: (context, _) => TextButton(
                    onPressed: switching
                        ? null
                        : () => app.setConnected(
                            !app.dial.devices.any((d) => d.attached),
                          ),
                    child: Text(
                      app.dial.devices.any((d) => d.attached)
                          ? 'Disconnect devices'
                          : 'Reconnect devices',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        Expanded(
          child: switching
              ? const SizedBox.expand()
              : SwarmScreen(
                  key: ObjectKey(app),
                  notifier: app,
                  nativeTabs: true,
                  projectStore: SwarmProjectStore(storage: app.storage),
                ),
        ),
      ],
    ),
  );
}
