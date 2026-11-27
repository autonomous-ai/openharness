// This run's debug build of Harness Device, downloaded, verified, installed,
// found and started by Desktop's own installer, probe and opener, on Windows
// or Linux. Run by hand on a throwaway GitHub-hosted runner (see below), from
// `desktop/`:
//
//   FLUTTER_TEST=1 HARNESS_DEVICE_TEST_PACKAGE=<the setup.exe or .AppImage> \
//     flutter test -d <windows|linux> --no-pub integration_test/device_app_install_windows_linux_native_test.dart
//
// Never production: the manifest is a stand-in on loopback naming the package
// with its real sha256 and size, at the CDN address a release would give it.
// It installs the real app for this account (Windows: its installer, per
// user; Linux: the AppImage at ~/.local/opt and its app-list entry), so it
// refuses to run but on a CI runner (GITHUB_ACTIONS), on Linux with HOME and
// the XDG folders in the runner's scratch (RUNNER_TEMP), and refuses an
// account where the app is installed or runs. It ends only the app processes
// it saw start, and removes what it installed.
//
// Windows' signature step is the real one. The Desktop under test is the debug
// runner `flutter test` builds, which nothing signs, so Authenticode reads it
// NotSigned and the installer is held to its sha256 alone, Task 41's rule for
// a local build; the install check asserts that first.
//
// Linux's signature step is the real one too, with a key made for the run: it
// signs the package as the Device release does, and the installer trusts that
// key alone.

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
import 'package:harness/devices/device_app_install_location_native.dart';
import 'package:harness/devices/device_app_installer.dart';
import 'package:harness/devices/device_app_launcher.dart';
import 'package:harness/devices/device_app_probe.dart';
import 'package:harness/devices/device_app_setup.dart';
import 'package:harness/update/tauri_signature.dart';
import 'package:harness/update/update_signature.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;

import '../test/support/tauri_test_signer.dart';

const _pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// The rule every writer of the app-list entry follows, as data.
final _vectors = jsonDecode(
  File('../tests/fixtures/app-list-entry-vectors.json').readAsStringSync(),
) as Map<String, dynamic>;

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

/// This user's processes that are the app on Windows, by tasklist filtered as
/// `windowsDeviceAppRunning` filters it, and bounded as it is. Throws when
/// tasklist fails: an empty list would read as every app ended.
Future<List<int>> _windowsAppPids() async {
  final listed = await runDeviceAppTool('tasklist', [
    '/FI',
    'IMAGENAME eq $deviceAppWindowsExe',
    '/FI',
    'USERNAME eq ${Platform.environment['USERNAME']}',
    '/FO',
    'CSV',
    '/NH',
  ], timeout: const Duration(seconds: 10));
  if (listed.exitCode != 0) {
    throw ProcessException('tasklist', const [], 'failed', listed.exitCode);
  }
  return [
    for (final row in const LineSplitter().convert('${listed.stdout}'))
      if (tasklistNamesDeviceApp(row))
        int.parse(row.split(',')[1].replaceAll('"', '')),
  ];
}

/// Why this computer is no place to run, or null. The test installs the real
/// app for this account, so a CI runner only, and on Linux every folder the
/// app or Desktop writes is in the runner's scratch.
String? _refusal(Map<String, String> environment) {
  if (environment['GITHUB_ACTIONS'] != 'true') return 'not a CI runner';
  if (!Platform.isLinux) return null;
  final scratch = environment['RUNNER_TEMP'];
  for (final name in const [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
  ]) {
    final folder = environment[name];
    if (scratch == null || folder == null || !p.isWithin(scratch, folder)) {
      return '$name is not in RUNNER_TEMP';
    }
  }
  return null;
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
  final refusal = _refusal(Platform.environment);
  if (refusal != null) {
    throw StateError(
      'This test installs Harness Device for this account: $refusal',
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
  // Asked each time, as the app asks: on Windows the installer registers
  // where it went.
  String place() =>
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
  late int size;
  HttpServer? server;

  /// The Device release's Tauri key as far as this run's installer knows.
  late TauriTestSigner signer;

  /// Linux: the package's signature, as the Device release signs it.
  late String signature;
  String trustedComment() =>
      'timestamp:${DateTime.now().millisecondsSinceEpoch ~/ 1000}\t'
      'file:$fileName\tversion:0.0.0';

  /// Set once this account was seen to have no copy and none running: from
  /// then on what is at the place is this test's to remove.
  var ours = false;

  /// The app's processes, seen once the app it opened ran: the only ones it
  /// ends.
  final started = <int>[];
  Future<List<int>> appPids() async =>
      Platform.isWindows ? await _windowsAppPids() : _linuxAppPids();

  /// What the server serves, by path.
  final files = <String, String>{};

  /// Serves the stand-in manifest naming the package by [sha256]; on Linux
  /// with Tauri's entry for the same url, carrying [signature].
  void serveManifest(String sha256) {
    final manifest = p.join(root.path, 'metadata.json');
    File(manifest).writeAsStringSync(
      jsonEncode({
        'device-$os-$arch-${Platform.isWindows ? 'exe' : 'appimage'}': {
          'version': '0.0.0',
          'url': url,
          'sha256': sha256,
          'size': size,
        },
        if (Platform.isLinux)
          'platforms': {
            'linux-${arch == 'arm64' ? 'aarch64' : 'x86_64'}': {
              'url': url,
              'signature': signature,
            },
          },
      }),
    );
    files['/metadata.json'] = manifest;
  }

  /// Linux: the app-list entry Desktop wrote, read just before it first
  /// started the app, so a write by the app's first run cannot hide in it.
  ({List<int> bytes, DateTime modified})? entryAsDesktopWrote;
  File entry() => File(
    '${launcherDataHome(Platform.environment)!}/applications/'
    '$deviceAppLauncherName',
  );

  setUpAll(() async {
    final before = await probe.lookup();
    if (before.installed ||
        before.running ||
        FileSystemEntity.typeSync(place(), followLinks: false) !=
            FileSystemEntityType.notFound) {
      throw StateError(
        'Harness Device is installed or runs for this account already: this '
        'test ends and removes only the copy it installs',
      );
    }
    ours = true;
    root = Directory.systemTemp.createTempSync('device-app-win-linux-test-');
    size = File(package).lengthSync();
    sha256 = await _sha256Of(package);
    debugPrint('package $size bytes');
    signer = await TauriTestSigner.generate();
    if (Platform.isLinux) {
      signature = await signer.sign(
        await blake2b512OfFile(package),
        trustedComment(),
      );
    }
    serveManifest(sha256);
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

  /// Ends the app processes this test started and removes what the install
  /// put there. The Linux app-list entry stays, for the last check to see it go.
  Future<void> removeApp() async {
    // Still the app: a pid that ended may be another process's now.
    Future<List<int>> stillRunning() async => [
      for (final pid in await appPids())
        if (started.contains(pid)) pid,
    ];
    if (Platform.isWindows) {
      final pids = await stillRunning();
      if (pids.isNotEmpty) {
        await Process.run('taskkill', [
          for (final pid in pids) ...['/PID', '$pid'],
          '/F',
        ]);
      }
      await _until(() async => (await stillRunning()).isEmpty);
      final folder = p.dirname(place());
      final uninstaller = p.join(folder, 'uninstall.exe');
      if (File(uninstaller).existsSync()) {
        // It copies itself away and returns at once: what it removes is
        // waited for, the uninstall entry too, which it deletes after the
        // folder.
        await Process.start(uninstaller, const [
          '/S',
        ], mode: ProcessStartMode.detached);
        await _until(
          () async =>
              !Directory(folder).existsSync() &&
              windowsDeviceAppInstallLocation() == null,
        );
      }
    } else {
      for (final signal in const [
        ProcessSignal.sigterm,
        ProcessSignal.sigkill,
      ]) {
        for (final pid in await stillRunning()) {
          Process.killPid(pid, signal);
        }
        if (await _until(
          () async => (await stillRunning()).isEmpty,
          within: const Duration(seconds: 10),
        )) {
          break;
        }
      }
      if (File(place()).existsSync()) File(place()).deleteSync();
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
    open: ({path}) async {
      if (Platform.isLinux && entry().existsSync()) {
        entryAsDesktopWrote ??= (
          bytes: entry().readAsBytesSync(),
          modified: entry().statSync().modified,
        );
      }
      return open(path: path);
    },
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
    tauriPublicKey: signer.publicKey,
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
        FileSystemEntity.typeSync(place(), followLinks: false),
        FileSystemEntityType.notFound,
      );
    },
  );

  testWidgets(
    'linux: a package changed after signing, its sha256 in the manifest, '
    'fails at the signature, and nothing is installed',
    skip: !Platform.isLinux,
    (tester) async {
      final bytes = File(package).readAsBytesSync();
      bytes[bytes.length ~/ 2] ^= 0xff;
      final changed = p.join(root.path, 'changed');
      File(changed).writeAsBytesSync(bytes);
      files[urlPath] = changed;
      serveManifest(await _sha256Of(changed));
      addTearDown(() => serveManifest(sha256));
      runs.clear();

      final result = await installer().install();

      expect(result.failed, DeviceAppInstallStep.signature);
      expect(result.installedAt, isNull);
      expect(runs, isEmpty);
      expect(
        FileSystemEntity.typeSync(place(), followLinks: false),
        FileSystemEntityType.notFound,
      );
    },
  );

  testWidgets('linux: verifying a 100 MB AppImage', skip: !Platform.isLinux, (
    tester,
  ) async {
    final appImage = p.join(root.path, 'large.AppImage');
    final sink = File(appImage).openWrite();
    // BLAKE2b's time does not depend on the bytes.
    final chunk = Uint8List(1024 * 1024);
    for (var i = 0; i < 100; i++) {
      sink.add(chunk);
    }
    await sink.close();
    final signed = await signer.sign(
      await blake2b512OfFile(appImage),
      trustedComment(),
    );

    final watch = Stopwatch()..start();
    await checkTauriSignature(
      signed,
      fileName: fileName,
      versionField: 'version:0.0.0',
      digest: () => blake2b512OfFile(appImage),
      publicKey: signer.publicKey,
    );
    watch.stop();

    debugPrint('signature check: 100 MB in ${watch.elapsedMilliseconds} ms');
  });

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
    expect(result.installedAt, place());
    expect(File(place()).existsSync(), isTrue);
    expect(runs, [Platform.isWindows ? 'Harness-Device-setup.exe' : 'chmod']);
    if (Platform.isWindows) {
      // Read from the registry, where the installer registered its folder:
      // for a first install, the default one.
      expect(windowsDeviceAppInstallLocation(), isNotNull);
      expect(
        p.windows.equals(
          place(),
          deviceAppPlace(
            platform: platform,
            environment: Platform.environment,
          )!,
        ),
        isTrue,
      );
    }
  });

  testWidgets('the probe sees it installed and running', (tester) async {
    var presence = const DeviceAppPresence(installed: false, running: false);

    final seen = await _until(() async {
      presence = await probe.lookup();
      return presence.installed && presence.running;
    });
    // None ran before this test opened it: these are the ones it started.
    started.addAll(await appPids());

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
          'APPIMAGE=${place()}',
        ]);
      }
    },
  );

  testWidgets(
    'a second install is done at the place and installs nothing again',
    (tester) async {
      final before = Platform.isWindows
          ? File(place()).lastModifiedSync()
          : null;
      runs.clear();

      final result = await installer().install();

      expect(result.failed, isNull);
      expect(result.installedAt, place());
      expect(runs, isEmpty);
      if (Platform.isWindows) {
        expect(File(place()).lastModifiedSync(), before);
      } else {
        expect(await _sha256Of(place()), sha256);
      }
    },
  );

  testWidgets(
    "linux: the app list starts the place, with the AppImage's own icon",
    skip: !Platform.isLinux,
    (tester) async {
      final data = launcherDataHome(Platform.environment)!;
      final icon = '$data/icons/harness-device.png';
      // The vectors' entry with an icon, at this run's place and data folder.
      final vector = (_vectors['entries'] as List).cast<Map>().firstWhere(
        (entry) => entry['icon'] == true,
      );

      expect(
        entry().readAsStringSync(),
        (vector['entry'] as String)
            .replaceFirst(
              'Exec=${quoteLauncherExec(vector['appImage'] as String)}\n',
              'Exec=${quoteLauncherExec(place())}\n',
            )
            .replaceFirst('Icon=${vector['dataHome']}/', 'Icon=$data/'),
      );
      final png = File(icon).readAsBytesSync();
      expect(png.take(_pngMagic.length), _pngMagic);
    },
  );

  testWidgets(
    "linux: the app's first run leaves Desktop's entry",
    skip: !Platform.isLinux,
    (tester) async {
      final logs = Directory(
        '${Platform.environment['XDG_DATA_HOME']}/'
        'ai.autonomous.harness.device/logs',
      );
      List<String> lines() => [
        if (logs.existsSync())
          for (final log in logs.listSync().whereType<File>())
            if (RegExp(r'^app-.*\.log$').hasMatch(p.basename(log.path)))
              ...log.readAsLinesSync(),
      ];
      // An AppImage run ends its app-list step in one line: this one says
      // the app decided, and left the entry.
      final kept = await _until(
        () async =>
            lines().any((line) => line.endsWith('app list: entry kept')),
      );
      final wrote = entryAsDesktopWrote;

      expect(kept, isTrue);
      expect(
        lines().where((line) => line.endsWith('app list: entry written')),
        isEmpty,
      );
      expect(wrote, isNotNull);
      expect(entry().readAsBytesSync(), wrote!.bytes);
      expect(entry().statSync().modified, wrote.modified);
    },
  );

  testWidgets(
    'windows: ended and uninstalled, the app is gone',
    skip: !Platform.isWindows,
    (tester) async {
      await removeApp();

      expect(await windowsDeviceAppRunning(), isFalse);
      expect(windowsDeviceAppInstallLocation(), isNull);
      expect(Directory(p.dirname(place())).existsSync(), isFalse);
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
