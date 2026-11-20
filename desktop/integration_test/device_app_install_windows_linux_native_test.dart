// This run's debug build of Harness Device, downloaded, verified, installed,
// found and started by Desktop's own installer, probe and opener, on Windows
// or Linux. From `desktop/`:
//
//   FLUTTER_TEST=1 HARNESS_DEVICE_TEST_PACKAGE=<the setup.exe or .AppImage> \
//     flutter test -d <windows|linux> --no-pub integration_test/device_app_install_windows_linux_native_test.dart
//
// Never production: the manifest is a stand-in on loopback naming the package
// with its real sha256 and size, at the CDN address a release would give it.
// It installs the real app for this account (Windows: its installer, per
// user; Linux: the AppImage at ~/.local/opt and its app-list entry), so it
// runs only on a disposable runner, with a scratch HOME and XDG folders on
// Linux: the temporary workflow's desktop-device-app-e2e. It ends the app and
// removes what it installed.
//
// Windows' signature step is the real one. The Desktop under test is the debug
// runner `flutter test` builds, which nothing signs, so Authenticode reads it
// NotSigned and the installer is held to its sha256 alone, Task 41's rule for
// a local build; the install check asserts that first.

import 'dart:convert';
import 'dart:io';

import 'package:cryptography/dart.dart' show DartSha256;
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/linux_app_image.dart';
import 'package:harness/core/runtime_architecture.dart';
import 'package:harness/core/runtime_platform.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_installer.dart';
import 'package:harness/devices/device_app_launcher.dart';
import 'package:harness/devices/device_app_probe.dart';
import 'package:harness/devices/device_app_setup.dart';
import 'package:harness/update/update_signature.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;

const _pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

Future<String> _sha256Of(String path) async {
  final sink = const DartSha256().newHashSink();
  await for (final chunk in File(path).openRead()) {
    sink.add(chunk);
  }
  sink.close();
  return sink
      .hashSync()
      .bytes
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
}

/// Asks [holds] until it says so or [within] passes.
Future<bool> _until(
  Future<bool> Function() holds, {
  Duration within = const Duration(seconds: 60),
}) async {
  final deadline = DateTime.now().add(within);
  while (!await holds()) {
    if (DateTime.now().isAfter(deadline)) return false;
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  return true;
}

/// The first of `status`'s `Uid:` fields, the real uid.
String? _realUid(String status) => const LineSplitter()
    .convert(status)
    .where((line) => line.startsWith('Uid:'))
    .map((line) => line.substring(4).trim().split(RegExp(r'\s+')).first)
    .firstOrNull;

/// This user's processes that are the app, as `linuxDeviceAppRunning` counts
/// them: `comm` is `harness-device`, the real uid is this process's.
List<int> _linuxAppPids() {
  final uid = _realUid(File('/proc/self/status').readAsStringSync());
  final pids = <int>[];
  for (final entry in Directory('/proc').listSync(followLinks: false)) {
    final pid = int.tryParse(p.basename(entry.path));
    if (pid == null) continue;
    try {
      if (File('${entry.path}/comm').readAsStringSync().trim() ==
              'harness-device' &&
          _realUid(File('${entry.path}/status').readAsStringSync()) == uid) {
        pids.add(pid);
      }
    } on FileSystemException {
      // It ended while the list was read.
    }
  }
  return pids;
}

void main() {
  final package = Platform.environment['HARNESS_DEVICE_TEST_PACKAGE'] ?? '';
  if (!kUnderTest ||
      !(Platform.isWindows || Platform.isLinux) ||
      package.isEmpty) {
    throw StateError(
      'Run this Windows or Linux fixture with FLUTTER_TEST=1 and '
      'HARNESS_DEVICE_TEST_PACKAGE',
    );
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  // FLUTTER_TEST makes defaultTargetPlatform Android in this app too, so the
  // OS is named.
  final platform = Platform.isWindows
      ? TargetPlatform.windows
      : TargetPlatform.linux;
  final os = Platform.isWindows ? 'windows' : 'linux';
  final arch = runtimeArchitecture;
  final place =
      deviceAppPlace(platform: platform) ??
      (throw StateError('No place for the app: no LOCALAPPDATA or HOME'));
  // The release's file name for this runner's key (device-manifest.py).
  final fileName = Platform.isWindows
      ? 'Harness-Device-$os-$arch-setup.exe'
      : 'Harness-Device-$os-$arch.AppImage';
  final url = 'https://cdn.autonomous.ai/harness/device/0.0.0/$fileName';
  final urlPath = Uri.parse(url).path;

  // Built as deviceAppOfferForThisComputer builds them.
  final probe = deviceAppProbeFor(platform);
  final open = deviceAppOpenFor(platform);

  /// The tools the installer ran, by name: the installer or chmod.
  final runs = <String>[];
  Future<ProcessResult> run(
    String executable,
    List<String> arguments, {
    Duration timeout = const Duration(seconds: 60),
  }) {
    runs.add(p.basename(executable));
    debugPrint('run ${p.basename(executable)}');
    return runDeviceAppTool(executable, arguments, timeout: timeout);
  }

  late Directory root;
  late String sha256, base;
  HttpServer? server;

  /// Set once this account was seen to have no copy: from then on what is at
  /// the place is this test's to remove.
  var ours = false;

  /// What the server serves, by path.
  final files = <String, String>{};

  setUpAll(() async {
    if (FileSystemEntity.typeSync(place, followLinks: false) !=
        FileSystemEntityType.notFound) {
      throw StateError(
        'Harness Device is installed for this account already: this test '
        'removes only the copy it installs',
      );
    }
    ours = true;
    root = Directory.systemTemp.createTempSync('device-app-win-linux-test-');
    final size = File(package).lengthSync();
    sha256 = await _sha256Of(package);
    debugPrint('package $size bytes');
    final manifest = p.join(root.path, 'metadata.json');
    File(manifest).writeAsStringSync(
      jsonEncode({
        'device-$os-$arch': {
          'version': '0.0.0',
          'url': url,
          'sha256': sha256,
          'size': size,
        },
      }),
    );
    files['/metadata.json'] = manifest;
    final loopback = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server = loopback;
    base = 'http://${loopback.address.host}:${loopback.port}';
    loopback.listen((request) async {
      final file = files[request.uri.path];
      if (file == null) {
        request.response.statusCode = HttpStatus.notFound;
      } else {
        request.response.contentLength = File(file).lengthSync();
        await request.response.addStream(File(file).openRead());
      }
      await request.response.close();
    });
  });

  /// Ends the app and removes what the install put there. The Linux
  /// app-list entry stays, for check 8 to see it go.
  Future<void> removeApp() async {
    if (Platform.isWindows) {
      await Process.run('taskkill', ['/IM', deviceAppWindowsExe, '/F']);
      await _until(() async => !await windowsDeviceAppRunning());
      final folder = p.dirname(place);
      final uninstaller = p.join(folder, 'uninstall.exe');
      if (File(uninstaller).existsSync()) {
        // It copies itself away and returns at once: what it removes is
        // waited for.
        await Process.start(uninstaller, const [
          '/S',
        ], mode: ProcessStartMode.detached);
        await _until(() async => !Directory(folder).existsSync());
      }
    } else {
      for (final signal in const [
        ProcessSignal.sigterm,
        ProcessSignal.sigkill,
      ]) {
        for (final pid in _linuxAppPids()) {
          Process.killPid(pid, signal);
        }
        if (await _until(
          () async => _linuxAppPids().isEmpty,
          within: const Duration(seconds: 10),
        )) {
          break;
        }
      }
      if (File(place).existsSync()) File(place).deleteSync();
    }
  }

  tearDownAll(() async {
    if (!ours) return;
    await server?.close(force: true);
    await removeApp();
    if (Platform.isLinux) await forgetGoneDeviceAppLauncher();
    root.deleteSync(recursive: true);
  });

  /// The app's own installer for this OS, its signature check and place
  /// included.
  DeviceAppInstaller installer() => deviceAppInstallerFor(
    platform,
    open: open,
    manifestUrl: '$base/metadata.json',
    // The manifest's CDN address of the package, sent to loopback.
    dio: Dio()
      ..interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            if (options.uri.toString() == url) {
              options.path = '$base$urlPath';
            }
            handler.next(options);
          },
        ),
      ),
    run: run,
  );

  testWidgets(
    'a package with one byte changed fails at the checksum, and nothing is '
    'installed',
    (tester) async {
      final bytes = File(package).readAsBytesSync();
      bytes[bytes.length ~/ 2] ^= 0xff;
      final changed = p.join(root.path, 'changed');
      File(changed).writeAsBytesSync(bytes);
      files[urlPath] = changed;
      runs.clear();

      final result = await installer().install();

      expect(result.failed, DeviceAppInstallStep.checksum);
      expect(result.installedAt, isNull);
      expect(runs, isEmpty);
      expect(
        FileSystemEntity.typeSync(place, followLinks: false),
        FileSystemEntityType.notFound,
      );
    },
  );

  testWidgets('before: neither installed nor running', (tester) async {
    final presence = await probe.lookup();

    expect(presence.installed, isFalse);
    expect(presence.running, isFalse);
  });

  testWidgets('install: done, at the place', (tester) async {
    if (Platform.isWindows) {
      final signers = await readWindowsSignerPair(
        file: package,
        runningExe: RuntimePlatform.resolvedExecutable,
      );
      debugPrint(
        'Desktop ${signers.running.status}, installer ${signers.file.status}',
      );
      expect(
        signers.running.status,
        'NotSigned',
        reason: 'an unsigned Desktop checks the sha256 alone',
      );
    }
    files[urlPath] = package;
    runs.clear();

    final result = await installer().install();

    expect(result.failed, isNull);
    expect(result.installedAt, place);
    expect(File(place).existsSync(), isTrue);
    expect(runs, [Platform.isWindows ? 'Harness-Device-setup.exe' : 'chmod']);
  });

  testWidgets('the probe sees it installed and running', (tester) async {
    var presence = const DeviceAppPresence(installed: false, running: false);

    final seen = await _until(() async {
      presence = await probe.lookup();
      return presence.installed && presence.running;
    });

    debugPrint(
      'lookup installed ${presence.installed}, running ${presence.running}',
    );
    expect(seen, isTrue);
  });

  testWidgets(
    'linux: the app runs with APPIMAGE at the place and no other',
    skip: !Platform.isLinux,
    (tester) async {
      final pids = _linuxAppPids();

      expect(pids, isNotEmpty);
      for (final pid in pids) {
        final environment = File('/proc/$pid/environ')
            .readAsStringSync(encoding: latin1)
            .split('\x00');
        expect(environment.where((line) => line.startsWith('APPIMAGE=')), [
          'APPIMAGE=$place',
        ]);
      }
    },
  );

  testWidgets(
    'a second install is done at the place and installs nothing again',
    (tester) async {
      final before = Platform.isWindows ? File(place).lastModifiedSync() : null;
      runs.clear();

      final result = await installer().install();

      expect(result.failed, isNull);
      expect(result.installedAt, place);
      expect(runs, isEmpty);
      if (Platform.isWindows) {
        expect(File(place).lastModifiedSync(), before);
      } else {
        expect(await _sha256Of(place), sha256);
      }
    },
  );

  testWidgets(
    "linux: the app list starts the place, with the AppImage's own icon",
    skip: !Platform.isLinux,
    (tester) async {
      final data = launcherDataHome(Platform.environment)!;
      final icon = '$data/icons/harness-device.png';

      expect(
        File('$data/applications/$deviceAppLauncherName').readAsStringSync(),
        '[Desktop Entry]\n'
        'Type=Application\n'
        'Name=Harness Device\n'
        'Comment=The app for your Harness device.\n'
        'Exec=${quoteLauncherExec(place)}\n'
        'Icon=$icon\n'
        'Terminal=false\n'
        'Categories=Utility;\n',
      );
      final png = File(icon).readAsBytesSync();
      expect(png.take(_pngMagic.length), _pngMagic);
    },
  );

  testWidgets(
    'windows: ended and uninstalled, the app is gone',
    skip: !Platform.isWindows,
    (tester) async {
      await removeApp();

      expect(await windowsDeviceAppRunning(), isFalse);
      expect(Directory(p.dirname(place)).existsSync(), isFalse);
    },
  );

  testWidgets(
    'linux: ended and its AppImage removed, its entry and icon go',
    skip: !Platform.isLinux,
    (tester) async {
      final data = launcherDataHome(Platform.environment)!;
      await removeApp();
      expect(_linuxAppPids(), isEmpty);

      await forgetGoneDeviceAppLauncher();

      expect(
        File('$data/applications/$deviceAppLauncherName').existsSync(),
        isFalse,
      );
      expect(File('$data/icons/harness-device.png').existsSync(), isFalse);
    },
  );
}
