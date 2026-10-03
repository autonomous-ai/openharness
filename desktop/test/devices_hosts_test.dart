import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/devices/device_hosts.dart';
import 'package:harness/devices/devices_controller.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/dial_status.dart';
import 'package:harness/ws/ws_conn.dart';

import 'devices_controller_test.dart' show deviceStatus;
import 'experimental_features_test.dart' show AccountSettings;
import 'swarm_state_test.dart' show MemoryStore, createApp;

class _DeviceConnection extends WsConn {
  _DeviceConnection(String id)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: id,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final requests = <(String, Map<String, dynamic>)>[];
  DialStatus device = deviceStatus('same-usb-id');
  int revision = 1;
  Completer<Map<String, dynamic>>? held;
  bool unsupported = false;
  Map<String, dynamic> get snapshot => {
    'revision': revision,
    'status': {
      'attached': device.attached,
      'devices': [
        {
          'id': device.id,
          'mac': device.mac,
          'attached': device.attached,
          'settings': device.settings!.toJson(),
        },
      ],
    },
  };
  @override
  Future<void> waitUntilReady({
    Duration timeout = const Duration(seconds: 20),
  }) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type, payload));
    if (unsupported) {
      throw WsRequestFailure(
        responseType: '${type}_result',
        code: 'UNSUPPORTED',
      );
    }
    if (type == 'harness_devices_list') return held?.future ?? snapshot;
    if (type == 'harness_device_settings') {
      expect(payload['id'], device.id);
      device = DialStatus.fromJson({
        'id': device.id,
        'mac': device.mac,
        'attached': true,
        'settings': {...device.settings!.toJson(), ...payload['patch'] as Map},
      });
      revision++;
      return {'ok': true, ...snapshot};
    }
    return {};
  }
}

void main() {
  test('account devices discover and address the right owned host; offline and shared hosts are read-only', () async {
    final connections = {
      for (final id in ['m', 'remote']) id: _DeviceConnection(id),
    };
    final storage = MemoryStore();
    final app = createApp(
      store: storage,
      connected: true,
      connectionForTest: (id) => connections[id]!,
    );
    addTearDown(app.dispose);
    app.machineStates['m']!.localOnly = true;
    for (final id in ['remote', 'offline', 'shared']) {
      final machine = Machine(
        machineId: id,
        authMode: MachineAuthMode.remote,
        name: '$id computer',
        isShared: id == 'shared',
      );
      app.machineStates[id] = MachineState(machine)
        ..nodeOnline = id != 'offline'
        ..connectionStatus = id == 'offline'
            ? ConnectionStatus.disconnected
            : ConnectionStatus.connected;
    }
    app.experimentalFeatures.bind('a', transport: AccountSettings('a'));
    await app.experimentalFeatures.refresh();
    await app.experimentalFeatures.set(ExperimentalFeature.devicesTab, true);
    final controller = DevicesController(
      hosts: app.deviceHosts,
      accountId: 'a',
      storage: storage,
      sendHostSettings: app.setHostDeviceSettings,
    );
    addTearDown(controller.dispose);
    await controller.load();
    await app.refreshDevices();
    expect(controller.devices, hasLength(2));
    expect(
      controller.devices.map((d) => d.key).toSet(),
      hasLength(2),
      reason: 'Even identical USB ids and MACs on two computers stay separate',
    );
    final local = controller.devices.firstWhere((d) => d.machineId == 'm');
    final remote = controller.devices.firstWhere(
      (d) => d.machineId == 'remote',
    );
    expect(remote.machineName, 'remote computer');
    await controller.update(remote.key, {'brightness': 35});
    expect(controller.device(remote.key)!.status.settings!.brightness, 35);
    expect(controller.device(local.key)!.status.settings!.brightness, 80);
    expect(controller.saving(remote.key), isFalse);
    expect(
      connections['m']!.requests.where(
        (r) => r.$1 == 'harness_device_settings',
      ),
      isEmpty,
    );
    expect(connections['remote']!.requests.last.$2, {
      'id': 'same-usb-id',
      'patch': {'brightness': 35},
    });
    app.machineStates['remote']!
      ..nodeOnline = false
      ..connectionStatus = ConnectionStatus.disconnected;
    app.notifyListeners();
    expect(controller.device(remote.key)!.canEdit, isFalse);
    expect(controller.device(remote.key)!.connectionLabel, 'Computer offline');
    expect(controller.device(remote.key)!.status.settings!.brightness, 35);
    expect(
      await app.setHostDeviceSettings('remote', 'same-usb-id', {
        'brightness': 90,
      }),
      isFalse,
    );
    expect(
      await app.setHostDeviceSettings('shared', 'same-usb-id', {
        'brightness': 90,
      }),
      isFalse,
    );
    app.machineStates['remote']!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.notifyListeners();
    expect(
      controller.device(remote.key)!.canEdit,
      isFalse,
      reason: 'Reconnection requires fresh device status',
    );
    await app.refreshDevices();
    expect(controller.device(remote.key)!.canEdit, isTrue);
    await controller.settled;
    final restored = DevicesController(
      hosts: DeviceHosts(),
      accountId: 'a',
      storage: storage,
      sendHostSettings: (_, _, _) async => false,
    );
    await restored.load();
    expect(restored.devices, hasLength(2));
    expect(restored.devices.every((d) => !d.canEdit), isTrue);
    expect(restored.device(remote.key)!.machineName, 'remote computer');
    restored.dispose();
  });

  test('late replies cannot cross an account change; old remote daemons never fall back to a local cable', () async {
    final connection = _DeviceConnection('m');
    final app = createApp(
      connected: true,
      connectionForTest: (_) => connection,
    );
    addTearDown(app.dispose);
    app.currentUser = const CurrentUserProfile(
      id: 'a',
      email: 'a@example.test',
    );
    app.experimentalFeatures.bind('a', transport: AccountSettings('a'));
    await app.experimentalFeatures.refresh();
    await app.experimentalFeatures.set(ExperimentalFeature.devicesTab, true);
    connection.unsupported = true;
    await app.refreshDevices();
    expect(app.deviceHosts.host('m')!.available, isFalse);
    expect(app.deviceHosts.host('m')!.error, contains('Update Harness'));
    expect(
      await app.setHostDeviceSettings('m', 'same-usb-id', {'muted': false}),
      isFalse,
    );
    connection.unsupported = false;
    connection.held = Completer();
    final read = app.refreshDevices();
    await Future<void>.delayed(Duration.zero);
    app.currentUser = const CurrentUserProfile(
      id: 'b',
      email: 'b@example.test',
    );
    connection.held!.complete(connection.snapshot);
    await read;
    expect(app.deviceHosts.hosts, isEmpty);
  });

  test('newer device reports beat stale replies, and firmware updates cancel pending edits', () async {
    final hosts = DeviceHosts();
    hosts.reconcile([const DeviceHost(id: 'm', name: 'Mac', online: true)]);
    DialStatus snapshot(DialStatus device) =>
        DialStatus(attached: true, devices: [device]);
    hosts.receive(
      'm',
      snapshot(deviceStatus('usb', brightness: 70)),
      revision: 2,
    );
    final controller = DevicesController(
      hosts: hosts,
      accountId: 'a',
      sendHostSettings: (_, _, _) async => true,
    );
    await controller.load();
    final key = controller.devices.single.key;
    hosts.receive(
      'm',
      snapshot(deviceStatus('usb', brightness: 20)),
      revision: 1,
    );
    expect(controller.device(key)!.status.settings!.brightness, 70);
    await controller.update(key, {'muted': false});
    hosts.receive(
      'm',
      snapshot(deviceStatus('usb', updating: 'new firmware')),
      revision: 3,
    );
    expect(controller.saving(key), isFalse);
    expect(controller.deviceError(key), contains('updating'));
    hosts.receive(
      'm',
      snapshot(const DialStatus(id: 'usb', attached: false)),
      revision: 4,
    );
    expect(controller.device(key)!.status.settings, isNotNull);
    hosts.receive(
      'm',
      snapshot(const DialStatus(id: 'usb', attached: true)),
      revision: 5,
    );
    expect(
      controller.device(key)!.canEdit,
      isFalse,
      reason: 'An incomplete reconnect is not fresh settings',
    );
    controller.dispose();
    hosts.dispose();
  });
}
