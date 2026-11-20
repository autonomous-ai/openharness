// The real release of the Harness menu-bar app (`Harness Device.app`),
// downloaded, verified and installed end to end, on a Mac. From `desktop/`:
//
//   FLUTTER_TEST=1 flutter test -d macos --no-pub integration_test/device_app_install_native_test.dart
//
// (An Intel Mac: add `--no-enable-impeller`.) It reads the release's public
// manifest and archive and runs the real `tar`, `ditto` and `codesign`, and it
// installs only into temporary folders it deletes. The opener records, so no
// second menu-bar app starts, and the real `open` never runs. Pull request CI
// does not run it: it reads the network.

import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:cryptography/dart.dart' show DartSha256;
import 'package:dio/dio.dart';
import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/runtime_architecture.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_installer.dart';
import 'package:harness/devices/device_app_manifest.dart';
import 'package:harness/devices/device_app_probe.dart';
import 'package:harness/update/update_signature.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;

/// The release's Team ID. Passed in: the test runner is an unsigned debug
/// build, so it cannot be read from the running bundle as Desktop does.
const _team = '54DJVWMJCC';

/// Where the stand-in's manifest says it is, under the CDN prefix; the
/// interceptor sends it to loopback.
const _standInUrl =
    'https://cdn.autonomous.ai/harness/device/0.0.0/Harness-Device.app.tar.gz';

/// chmod(2) from this process (`mode_t` is 16 bits on macOS): a test runner
/// translated by Rosetta has been seen to hang for good forking `chmod`.
final _chmod = DynamicLibrary.process()
    .lookupFunction<
      Int32 Function(Pointer<Utf8>, Uint16),
      int Function(Pointer<Utf8>, int)
    >('chmod');

void _setMode(String path, int mode) {
  final native = path.toNativeUtf8();
  try {
    expect(_chmod(native, mode), 0, reason: 'chmod');
  } finally {
    malloc.free(native);
  }
}

String _sha256(List<int> bytes) => const DartSha256()
    .hashSync(bytes)
    .bytes
    .map((b) => b.toRadixString(16).padLeft(2, '0'))
    .join();

List<String> _namesIn(String folder) => Directory(folder).existsSync()
    ? [for (final entry in Directory(folder).listSync()) p.basename(entry.path)]
    : const [];

/// Prints one line per request (`manifest 200`, `download <n> bytes`), never
/// a URL, and sends each of [loopback]'s URLs to its loopback stand-in.
Dio _dio({Map<String, String> loopback = const {}}) => Dio()
  ..interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) {
        options.path = loopback[options.uri.toString()] ?? options.path;
        handler.next(options);
      },
      onResponse: (response, handler) {
        if (response.requestOptions.uri.path.endsWith('/metadata.json')) {
          debugPrint('manifest ${response.statusCode}');
        } else if (response.data case final ResponseBody body) {
          var received = 0;
          body.stream = body.stream.transform(
            StreamTransformer<Uint8List, Uint8List>.fromHandlers(
              handleData: (chunk, sink) {
                received += chunk.length;
                sink.add(chunk);
              },
              handleDone: (sink) {
                debugPrint('download $received bytes');
                sink.close();
              },
            ),
          );
        }
        handler.next(response);
      },
      onError: (error, handler) {
        debugPrint(
          'request failed ${error.response?.statusCode ?? error.type.name}',
        );
        handler.next(error);
      },
    ),
  );

Future<ProcessResult> _run(
  String executable,
  List<String> arguments, {
  Duration? timeout,
}) async {
  final result = timeout == null
      ? await runDeviceAppTool(executable, arguments)
      : await runDeviceAppTool(executable, arguments, timeout: timeout);
  debugPrint('${p.basename(executable)} exit ${result.exitCode}');
  return result;
}

Future<bool> _verify(String bundle) async {
  final verified = await verifyMacBundle(
    bundle: bundle,
    team: _team,
    identifier: deviceAppBundleId,
  );
  debugPrint(verified ? 'codesign ok' : 'codesign refused');
  return verified;
}

/// The release this Mac installs, from the real manifest.
Future<DeviceAppRelease> _realRelease() async {
  final manifest = await Dio().get<Object?>(deviceAppManifestUrl);
  final data = manifest.data;
  final release = parseDeviceAppManifest(
    data is String ? jsonDecode(data) : data,
    architecture: runtimeArchitecture,
    platform: TargetPlatform.macOS,
  );
  expect(release, isNotNull, reason: 'the real manifest names no release');
  return release!;
}

void main() {
  if (!kUnderTest || !Platform.isMacOS) {
    throw StateError('Run this macOS fixture with FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late Directory root, tempRoot;
  late String first, second;
  late List<String?> opened;
  HttpServer? server;

  setUp(() {
    root = Directory.systemTemp.createTempSync('device-app-native-test-');
    first = p.join(root.path, 'first');
    Directory(first).createSync();
    // Read-only, so the installer falls back to the second folder.
    _setMode(first, 0x16d); // 0555
    // Missing until the installer makes it, as `~/Applications` may be.
    second = p.join(root.path, 'second');
    tempRoot = Directory(p.join(root.path, 'temp'))..createSync();
    opened = [];
  });

  tearDown(() async {
    await server?.close(force: true);
    server = null;
    _setMode(first, 0x1ed); // 0755
    root.deleteSync(recursive: true);
  });

  /// Serves each file of [files] at its path, from loopback, and returns the
  /// loopback URL of each path.
  Future<Map<String, String>> serve(Map<String, String> files) async {
    final loopback = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server = loopback;
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
    return {
      for (final path in files.keys)
        path: 'http://${loopback.address.host}:${loopback.port}$path',
    };
  }

  DeviceAppInstaller installer({required String manifestUrl, Dio? dio}) =>
      DeviceAppInstaller(
        manifestUrl: manifestUrl,
        targetFolders: [first, second],
        verifySignature: _verify,
        open: ({String? path}) async {
          opened.add(path);
          debugPrint('open (recorded)');
          return true;
        },
        dio: dio ?? _dio(),
        run: _run,
        // FLUTTER_TEST makes defaultTargetPlatform Android in this app too.
        platform: TargetPlatform.macOS,
        tempRoot: tempRoot,
      );

  void expectNothingInstalled(DeviceAppInstallResult result) {
    expect(result.installedAt, isNull);
    expect(_namesIn(first), isEmpty);
    expect(_namesIn(second), isNot(contains(deviceAppBundleName)));
    expect(
      _namesIn(second).where((name) => name.endsWith('.partial')),
      isEmpty,
    );
    expect(tempRoot.listSync(), isEmpty);
    expect(opened, isEmpty);
  }

  testWidgets(
    'the real release installs into the fallback folder and would open',
    (tester) async {
      final result = await installer(manifestUrl: deviceAppManifestUrl)
          .install();

      final installed = p.join(second, deviceAppBundleName);
      expect(result.failed, isNull);
      expect(result.installedAt, installed);
      expect(_namesIn(first), isEmpty);
      expect(opened, [installed]);
      expect(tempRoot.listSync(), isEmpty);

      final display = await Process.run('/usr/bin/codesign', [
        '-dv',
        '--verbose=2',
        installed,
      ]);
      expect(display.exitCode, 0);
      final lines = const LineSplitter()
          .convert('${display.stderr}')
          .where(
            (line) => [
              'Identifier=',
              'TeamIdentifier=',
              'Authority=',
              'Notarization Ticket=',
            ].any(line.startsWith),
          )
          .toList();
      lines.forEach(debugPrint);
      expect(lines, contains('Identifier=$deviceAppBundleId'));
      expect(lines, contains('TeamIdentifier=$_team'));
    },
  );

  testWidgets('a copy with one byte changed is refused at the checksum', (
    tester,
  ) async {
    final release = await _realRelease();
    final archive = await Dio().get<List<int>>(
      release.url,
      options: Options(responseType: ResponseType.bytes),
    );
    final bytes = Uint8List.fromList(archive.data!);
    expect(bytes, hasLength(release.size));
    bytes[bytes.length ~/ 2] ^= 0xff;
    final changed = p.join(root.path, 'changed.tar.gz');
    File(changed).writeAsBytesSync(bytes);
    final path = Uri.parse(release.url).path;
    final loopback = await serve({path: changed});

    final result = await installer(
      manifestUrl: deviceAppManifestUrl,
      dio: _dio(loopback: {release.url: loopback[path]!}),
    ).install();

    expect(result.failed, DeviceAppInstallStep.checksum);
    expectNothingInstalled(result);
  });

  testWidgets('a bundle signed by someone else is refused at the signature', (
    tester,
  ) async {
    // A stand-in with the app's name and identifier, signed ad hoc.
    final build = p.join(root.path, 'stand-in');
    final bundle = p.join(build, deviceAppBundleName);
    Directory(p.join(bundle, 'Contents', 'MacOS')).createSync(recursive: true);
    File(p.join(bundle, 'Contents', 'Info.plist')).writeAsStringSync('''
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>harness-device</string>
	<key>CFBundleIdentifier</key>
	<string>$deviceAppBundleId</string>
</dict>
</plist>
''');
    File('/usr/bin/true')
        .copySync(p.join(bundle, 'Contents', 'MacOS', 'harness-device'));
    final sign = await Process.run('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      bundle,
    ]);
    expect(sign.exitCode, 0, reason: '${sign.stderr}');
    // Validly signed, so only who signed it can refuse it.
    final valid = await Process.run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      bundle,
    ]);
    expect(valid.exitCode, 0, reason: '${valid.stderr}');
    final archive = p.join(root.path, 'stand-in.tar.gz');
    // No `._` files beside the bundle: the installer takes one entry only.
    final pack = await Process.run(
      '/usr/bin/tar',
      ['-czf', archive, '-C', build, deviceAppBundleName],
      environment: const {'COPYFILE_DISABLE': '1'},
    );
    expect(pack.exitCode, 0, reason: '${pack.stderr}');
    final bytes = File(archive).readAsBytesSync();
    final entry = {
      'version': '0.0.0',
      'url': _standInUrl,
      'sha256': _sha256(bytes),
      'size': bytes.length,
    };
    final manifest = p.join(root.path, 'metadata.json');
    File(manifest).writeAsStringSync(
      jsonEncode({'device-macos': entry, 'device-macos-arm64': entry}),
    );
    final archivePath = Uri.parse(_standInUrl).path;
    final loopback = await serve({
      '/metadata.json': manifest,
      archivePath: archive,
    });

    final result = await installer(
      manifestUrl: loopback['/metadata.json']!,
      dio: _dio(loopback: {_standInUrl: loopback[archivePath]!}),
    ).install();

    expect(result.failed, DeviceAppInstallStep.signature);
    expectNothingInstalled(result);
  });

  testWidgets('the real lookup answers', (tester) async {
    final presence = await const ChannelDeviceAppProbe().lookup();
    debugPrint(
      'lookup installed ${presence.installed}, running ${presence.running}',
    );
    if (Directory('/Applications/$deviceAppBundleName').existsSync()) {
      expect(presence.installed, isTrue);
    }
  });
}
