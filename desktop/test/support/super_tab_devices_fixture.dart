import 'package:harness/state/dial_status.dart';

import '../devices_controller_test.dart' show deviceStatus;
import '../super_tab_launch_test.dart';

/// A connected, in-memory daemon: Devices reads never wait on a real socket.
class SuperTabDevicesConnection extends SuperTabFixtureConnection {
  SuperTabDevicesConnection(super.store);
  bool hasDevice = false;
  var device = deviceStatus('fixture-device');
  int deviceRevision = 1;

  Map<String, dynamic> get deviceSnapshot => {
    'revision': deviceRevision,
    'status': {
      'attached': hasDevice,
      'devices': [
        if (hasDevice)
          {
            'id': device.id,
            'mac': device.mac,
            'attached': true,
            'settings': device.settings!.toJson(),
          },
      ],
    },
  };

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'harness_devices_list') {
      calls.add((type, Map.of(payload)));
      return Future.value(deviceSnapshot);
    }
    if (type == 'harness_device_settings') {
      calls.add((type, Map.of(payload)));
      device = DialStatus.fromJson({
        'id': device.id,
        'mac': device.mac,
        'attached': true,
        'settings': {...device.settings!.toJson(), ...payload['patch'] as Map},
      });
      deviceRevision++;
      return Future.value({'ok': true, ...deviceSnapshot});
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

SuperTabLaunchFixture superTabDevicesFixture() =>
    SuperTabLaunchFixture(connectionFactory: SuperTabDevicesConnection.new);
