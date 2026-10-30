import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/serial_port_lease.dart';
import 'package:harness/core/config.dart';
import 'package:harness/ws/local_cli_discovery.dart';

void main() {
  test('per-run Windows leases and the legacy marker each block until retired or stale', () {
    final dir = Directory.systemTemp.createTempSync('flasher-leases-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final environment = {'HARNESS_FLASHER_CACHE': dir.path};
    final current = '${DateTime.now().millisecondsSinceEpoch ~/ 1000}\n';
    final owned = File('${dir.path}/flashing.${'a' * 32}')
      ..writeAsStringSync(current);
    final foreign = File('${dir.path}/flashing.${'b' * 32}')
      ..writeAsStringSync(current);
    final legacy = File('${dir.path}/flashing')..writeAsStringSync(current);
    expect(
      SerialPortLease.heldByAnotherProcess(environment: environment),
      isTrue,
    );
    legacy.deleteSync();
    expect(
      SerialPortLease.heldByAnotherProcess(environment: environment),
      isTrue,
    );
    owned.deleteSync();
    expect(
      SerialPortLease.heldByAnotherProcess(environment: environment),
      isTrue,
    );
    foreign.writeAsStringSync(
      '${DateTime.now().subtract(const Duration(hours: 2)).millisecondsSinceEpoch ~/ 1000}\n',
    );
    // Other cache files must not become leases merely because they hold a fresh number.
    File('${dir.path}/flashing.backup').writeAsStringSync(current);
    File('${dir.path}/cancel').writeAsStringSync(current);
    expect(
      SerialPortLease.heldByAnotherProcess(environment: environment),
      isFalse,
    );
  });

  test(
    'the flasher folder uses HARNESS_FLASHER_CACHE, else the Harness home',
    () {
      expect(
        SerialPortLease.flasherDirectory(
          environment: {
            'HARNESS_FLASHER_CACHE': '/x/f',
            'HOME': '/h',
            'USERPROFILE': '/h',
          },
        ),
        '/x/f',
      );
      expect(
        SerialPortLease.flasherDirectory(
          environment: {'HOME': '/h', 'USERPROFILE': '/h'},
        ),
        HarnessFileStore.defaultDirectoryPath(
          environment: {'HOME': '/h', 'USERPROFILE': '/h'},
          name: 'flasher',
        ),
      );
    },
  );

  test('a flash started in a terminal also stops the daemon being restarted', () async {
    // The case that matters most for a device already in someone's hands: they run `harness flash`
    // themselves while the app is open, and the app's five-second supervisor takes the port back
    // underneath them. The flasher writes this file before it stops the daemon.
    final dir = Directory.systemTemp.createTempSync('flasher-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final flag = File('${dir.path}/flashing');

    flag.writeAsStringSync(
      '${DateTime.now().millisecondsSinceEpoch ~/ 1000}\n',
    );
    expect(
      SerialPortLease.heldByAnotherProcess(
        environment: {'HARNESS_FLASHER_CACHE': dir.path},
      ),
      isTrue,
    );

    // A script killed with -9 cannot clean up. Believing its flag for ever would leave the daemon
    // unsupervised on that machine permanently — worse than the collision it guards against.
    final stale = DateTime.now().subtract(const Duration(hours: 2));
    flag.writeAsStringSync('${stale.millisecondsSinceEpoch ~/ 1000}\n');
    expect(
      SerialPortLease.heldByAnotherProcess(
        environment: {'HARNESS_FLASHER_CACHE': dir.path},
      ),
      isFalse,
    );

    flag.deleteSync();
    expect(
      SerialPortLease.heldByAnotherProcess(
        environment: {'HARNESS_FLASHER_CACHE': dir.path},
      ),
      isFalse,
    );
  });

  test('the daemon is not spawned while the port is leased', () async {
    var spawned = false;
    final discovery = LocalCliDiscovery(
      // Points at a port nothing is listening on, so discovery finds no daemon
      // — exactly the state a flash leaves behind.
      config: const AppConfig(
        apiBaseUrl: 'https://harness-api.autonomous.ai',
        localCliBaseUrl: 'http://127.0.0.1:1',
      ),
      spawnCommand: () async => spawned = true,
    );

    // A run-id lease of its own in the real flasher folder, so a flash the
    // machine may really be running keeps its shared flag untouched.
    final dir = Directory(SerialPortLease.flasherDirectory())
      ..createSync(recursive: true);
    final lease = File('${dir.path}/flashing.${'e' * 32}')
      ..writeAsStringSync('${DateTime.now().millisecondsSinceEpoch ~/ 1000}\n');
    addTearDown(() {
      if (lease.existsSync()) lease.deleteSync();
    });

    // Flashing stops the daemon first, so discovery finds nothing and the
    // old code went straight on to start it again — taking back the port
    // esptool was writing through.
    final probe = await discovery.ensureRunning();
    expect(probe.state, LocalCliProbeState.down);
    expect(probe.endpoint, isNull);

    expect(spawned, isFalse);
  });
}
