import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/hidden_process.dart';
import 'package:harness/devices/device_app_probe.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const applications = '/Applications/Harness Device.app';
  const trash = '/Users/a/.Trash/Harness Device.app';
  const volumeTrash = '/Volumes/X/.Trashes/501/Harness Device.app';
  const diskImage = '/Volumes/Harness Device/Harness Device.app';

  Future<bool> Function(String) existing(Set<String> paths) =>
      (path) async => paths.contains(path);

  Future<bool> installed(List<String> paths, {Set<String>? exists}) =>
      deviceAppInstalledAt(paths, exists: existing(exists ?? paths.toSet()));

  group('which copy counts as installed', () {
    test('a copy in Applications counts', () async {
      expect(await installed([applications]), isTrue);
      expect(
        await installed(['/Users/a/Applications/Harness Device.app']),
        isTrue,
      );
    });

    test('a copy in a Trash does not count', () async {
      expect(await installed([trash]), isFalse);
      expect(await installed([volumeTrash]), isFalse);
    });

    test('a copy under /Volumes/ does not count', () async {
      expect(await installed([diskImage]), isFalse);
    });

    test('a path that is gone does not count', () async {
      expect(await installed([applications], exists: {}), isFalse);
    });

    test('one good copy among others is enough', () async {
      expect(await installed([trash, diskImage, applications]), isTrue);
      expect(await installed([]), isFalse);
    });

    test('a folder that only looks like a Trash counts', () async {
      expect(
        await installed(['/Users/a/Apps.Trash/Harness Device.app']),
        isTrue,
      );
      expect(await installed(['/Users/a/VolumesX/Harness Device.app']), isTrue);
    });

    test('the real check reads the disk', () async {
      final dir = await Directory.systemTemp.createTemp('device_app_probe');
      addTearDown(() => dir.delete(recursive: true));
      final app = await Directory('${dir.path}/Harness Device.app').create();
      expect(await deviceAppInstalledAt([app.path]), isTrue);
      await app.delete(recursive: true);
      expect(await deviceAppInstalledAt([app.path]), isFalse);
    });
  });

  group('the channel', () {
    const channel = MethodChannel('harness/device_app');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final probe = ChannelDeviceAppProbe(
      exists: existing({trash, applications}),
    );

    void reply(Object? value, [List<MethodCall>? calls]) =>
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls?.add(call);
          return value;
        });

    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    test('asks lookup, with no argument, and filters the paths', () async {
      final calls = <MethodCall>[];
      reply({
        'paths': [trash, applications],
        'running': false,
      }, calls);
      final presence = await probe.lookup();
      expect(calls, hasLength(1));
      expect(calls.single.method, 'lookup');
      expect(calls.single.arguments, isNull);
      expect(presence.installed, isTrue);
      expect(presence.running, isFalse);

      reply({
        'paths': [trash],
        'running': false,
      });
      expect((await probe.lookup()).installed, isFalse);
    });

    test('running is read as it comes', () async {
      reply({'paths': <String>[], 'running': true});
      final presence = await probe.lookup();
      expect(presence.installed, isFalse);
      expect(presence.running, isTrue);
    });

    test('a reply of the wrong shape is refused', () async {
      for (final value in <Object?>[
        {'paths': <String>[]},
        {'running': false},
        {'paths': applications, 'running': false},
        {
          'paths': [7],
          'running': false,
        },
        {'paths': <String>[], 'running': 0},
        {'installed': true, 'running': false},
        'yes',
        null,
      ]) {
        reply(value);
        await expectLater(
          probe.lookup(),
          throwsA(isA<FormatException>()),
          reason: '$value',
        );
      }
    });

    test('a Mac whose app has no such channel throws', () async {
      await expectLater(probe.lookup(), throwsA(isA<MissingPluginException>()));
    });
  });

  group('Windows and Linux: the place and the process list', () {
    const place = '/home/p q/.local/opt/Harness-Device.AppImage';

    Future<({bool installed, bool running})> look({
      String? at = place,
      bool there = false,
      bool runs = false,
    }) async {
      final presence = await PlaceDeviceAppProbe(
        place: () => at,
        running: () async => runs,
        exists: existing(there ? {place} : {}),
      ).lookup();
      return (installed: presence.installed, running: presence.running);
    }

    test('installed: the place is there, or the app runs', () async {
      expect(await look(), (installed: false, running: false));
      expect(await look(there: true), (installed: true, running: false));
      expect(await look(runs: true), (installed: true, running: true));
      expect(await look(there: true, runs: true), (
        installed: true,
        running: true,
      ));
    });

    test('no place: installed only while it runs', () async {
      expect(await look(at: null), (installed: false, running: false));
      expect(await look(at: null, runs: true), (
        installed: true,
        running: true,
      ));
    });

    // On Windows an install registers where it went, so each lookup asks.
    test('each lookup asks for the place again', () async {
      const elsewhere = '/media/p/Harness-Device.AppImage';
      var at = place;
      final probe = PlaceDeviceAppProbe(
        place: () => at,
        running: () async => false,
        exists: existing({elsewhere}),
      );

      expect((await probe.lookup()).installed, isFalse);
      at = elsewhere;
      expect((await probe.lookup()).installed, isTrue);
    });

    test('a lookup whose process list fails throws', () async {
      final probe = PlaceDeviceAppProbe(
        place: () => place,
        running: () async => throw const ProcessException('tasklist', []),
        exists: existing({place}),
      );
      await expectLater(probe.lookup(), throwsA(isA<ProcessException>()));
    });
  });

  group('tasklist', () {
    const environment = {
      'SystemRoot': r'C:\Windows',
      'USERNAME': 'Nguyễn Văn A',
    };

    test('tasklist asks for harness-device.exe of this user, as CSV with no header', () async {
      final calls = <(String, List<String>)>[];
      final running = await windowsDeviceAppRunning(
        environment: environment,
        run: (executable, arguments) async {
          calls.add((executable, arguments));
          return ProcessResult(1, 0, '', '');
        },
      );
      expect(running, isFalse);
      expect(calls, hasLength(1));
      expect(calls.single.$1, r'C:\Windows\System32\tasklist.exe');
      expect(calls.single.$2, [
        '/FI',
        'IMAGENAME eq harness-device.exe',
        '/FI',
        'USERNAME eq Nguyễn Văn A',
        '/FO',
        'CSV',
        '/NH',
      ]);
    });

    test("tasklist's rows: harness-device.exe in any case counts; a localized no-tasks line does not", () {
      expect(
        tasklistNamesDeviceApp(
          '"HARNESS-DEVICE.EXE","4242","Console","1","52,120 K"\r\n',
        ),
        isTrue,
      );
      expect(
        tasklistNamesDeviceApp(
          'INFO: No tasks are running which match the specified criteria.\r\n',
        ),
        isFalse,
      );
      expect(
        tasklistNamesDeviceApp(
          'Information: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.\r\n',
        ),
        isFalse,
      );
      expect(
        tasklistNamesDeviceApp(
          '"harness-device.exe.old","1","Console","1","1 K"\r\n',
        ),
        isFalse,
      );
    });

    test('tasklist that fails, or no USERNAME, throws', () async {
      var asked = 0;
      Future<ProcessResult> answer(String _, List<String> _) async {
        asked++;
        return ProcessResult(1, 1, '', 'ERROR');
      }

      await expectLater(
        windowsDeviceAppRunning(environment: environment, run: answer),
        throwsA(anything),
      );
      expect(asked, 1);
      await expectLater(
        windowsDeviceAppRunning(
          environment: const {'SystemRoot': r'C:\Windows'},
          run: answer,
        ),
        throwsA(anything),
      );
      expect(asked, 1);
    });

    test(
      'a hidden copy of ping named harness-device.exe is found by tasklist',
      () async {
        final dir = await Directory.systemTemp.createTemp('device_app_probe');
        addTearDown(() => dir.delete(recursive: true));
        final root = Platform.environment['SystemRoot'] ?? r'C:\Windows';
        final copy = await File('$root\\System32\\PING.EXE')
            .copy('${dir.path}\\harness-device.exe');
        final ping = await startHidden(copy.path, const [
          '-n',
          '30',
          '127.0.0.1',
        ]);
        ping.stdout.drain<void>();
        ping.stderr.drain<void>();
        expect(await windowsDeviceAppRunning(), isTrue);
        ping.kill();
        await ping.exitCode;
        expect(await windowsDeviceAppRunning(), isFalse);
      },
      skip: !Platform.isWindows,
    );
  });

  group('/proc', () {
    Future<Directory> fakeProc() async {
      final dir = await Directory.systemTemp.createTemp('device_app_proc');
      addTearDown(() => dir.delete(recursive: true));
      Future<void> entry(String name, {String? comm, String? uid}) async {
        final folder = await Directory('${dir.path}/$name').create();
        if (comm != null) await File('${folder.path}/comm').writeAsString(comm);
        if (uid != null) {
          await File('${folder.path}/status').writeAsString(
            'Name:\t$comm\nState:\tS (sleeping)\nUid:\t$uid\t$uid\t$uid\t$uid\n'
            'Gid:\t1000\t1000\t1000\t1000\n',
          );
        }
      }

      await entry('self', comm: 'harness', uid: '1000');
      await entry('11', comm: 'harness-device\n', uid: '1001');
      await entry('12', comm: 'harness-device2\n', uid: '1000');
      await entry('13');
      return dir;
    }

    test("/proc: a harness-device of this user counts; another user's, another name or a vanished entry does not", () async {
      final proc = await fakeProc();
      expect(await linuxDeviceAppRunning(proc: proc.path), isFalse);
      final ours = await Directory('${proc.path}/10').create();
      await File('${ours.path}/comm').writeAsString('harness-device\n');
      await File(
        '${ours.path}/status',
      ).writeAsString('Name:\tharness-device\nUid:\t1000\t1000\t1000\t1000\n');
      expect(await linuxDeviceAppRunning(proc: proc.path), isTrue);
    });

    test('an unreadable self/status throws', () async {
      final dir = await Directory.systemTemp.createTemp('device_app_proc');
      addTearDown(() => dir.delete(recursive: true));
      await expectLater(
        linuxDeviceAppRunning(proc: dir.path),
        throwsA(anything),
      );
    });

    test('a copy of sleep named harness-device is found in /proc, and not once it ends', () async {
      final dir = await Directory.systemTemp.createTemp('device_app_probe');
      addTearDown(() => dir.delete(recursive: true));
      final copy = await File('/bin/sleep').copy('${dir.path}/harness-device');
      expect((await Process.run('chmod', ['0755', copy.path])).exitCode, 0);
      final sleep = await Process.start(copy.path, const ['30']);
      expect(await linuxDeviceAppRunning(), isTrue);
      sleep.kill(ProcessSignal.sigkill);
      await sleep.exitCode;
      expect(await linuxDeviceAppRunning(), isFalse);
    }, skip: !Platform.isLinux);
  });
}
