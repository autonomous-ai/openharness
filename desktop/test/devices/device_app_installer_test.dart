import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:cryptography/dart.dart' show DartSha256;
import 'package:dio/dio.dart';
import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/home_dir.dart';
import 'package:harness/devices/device_app.dart';
import 'package:harness/devices/device_app_installer.dart';
import 'package:harness/devices/device_app_manifest.dart';
import 'package:path/path.dart' as p;

/// The installer against a loopback server, temporary folders, a recording
/// signature check and a recording opener: nothing here installs on, or opens
/// anything on, the computer it runs on.
const _archivePath = '/harness/device/0.0.0/Harness-Device.app.tar.gz';
const _plist =
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<plist version="1.0"><dict><key>CFBundleIdentifier</key>'
    '<string>ai.autonomous.harness.device</string></dict></plist>\n';

/// Where the Windows installer and the Linux AppImage are served, under the
/// CDN, and stand-ins for their bytes: nothing here is ever run.
const _setupPath = '/harness/device/0.0.0/Harness-Device-windows-x64-setup.exe';
const _appImagePath = '/harness/device/0.0.0/Harness-Device-linux-x64.AppImage';
final _setup = utf8.encode('MZ stand-in installer');
final _appImage = utf8.encode('\x7fELF stand-in AppImage');

/// `ditto` is macOS's; the cases that reach it run only there.
final String? _needsDitto = Platform.isMacOS
    ? null
    : 'needs /usr/bin/ditto (macOS)';

/// The Linux step runs `/bin/chmod` and the case reads the mode it set.
final String? _needsChmod = Platform.isWindows
    ? 'needs /bin/chmod and POSIX modes'
    : null;

typedef _Handler = void Function(HttpRequest request);

/// chmod(2) from this process, macOS only (`mode_t` is 16 bits there).
/// Starting `chmod` for it would fork this process once more each time, and
/// a test runner translated by Rosetta has been seen to hang for good in a
/// fork racing a worker thread's exit.
final _chmod = DynamicLibrary.process()
    .lookupFunction<
      Int32 Function(Pointer<Utf8>, Uint16),
      int Function(Pointer<Utf8>, int)
    >('chmod');

void _setMode(String path, int mode) {
  final native = path.toNativeUtf8();
  try {
    expect(_chmod(native, mode), 0, reason: 'chmod $path');
  } finally {
    malloc.free(native);
  }
}

List<int> _json(Object? value) => utf8.encode(jsonEncode(value));

String _sha256(List<int> bytes) => const DartSha256()
    .hashSync(bytes)
    .bytes
    .map((b) => b.toRadixString(16).padLeft(2, '0'))
    .join();

/// A manifest entry for [archive] at [path] under the CDN; the sha256 and size
/// are the archive's own unless given.
Map<String, Object?> _entry(
  List<int> archive, {
  String path = _archivePath,
  String? sha256,
  int? size,
}) => {
  'version': '0.0.0',
  'url': 'https://cdn.autonomous.ai$path',
  'sha256': sha256 ?? _sha256(archive),
  'size': size ?? archive.length,
};

List<int> _tarGz(List<ArchiveFile> entries) {
  final archive = Archive();
  entries.forEach(archive.add);
  return GZipEncoder().encodeBytes(TarEncoder().encodeBytes(archive));
}

ArchiveFile _infoPlist(String bundle) =>
    ArchiveFile.string('$bundle/Contents/Info.plist', _plist);

/// A made-up `Harness Device.app`, packed as a release is.
List<int> _bundleArchive() => _tarGz([
  _infoPlist('Harness Device.app'),
  ArchiveFile.string(
    'Harness Device.app/Contents/MacOS/harness-device',
    '#!/bin/sh\n',
  )..mode = 0x1ed,
]);

_Handler _respond(int status, List<int> body) => (request) {
  request.response
    ..statusCode = status
    ..add(body)
    ..close().ignore();
};

_Handler _redirect(String path) => (request) {
  request.response
    ..statusCode = HttpStatus.found
    ..headers.set(HttpHeaders.locationHeader, path)
    ..close().ignore();
};

/// A body that never ends: 1 MiB, far past what any case allows, then the
/// connection held open. Bounded because once the client has gone, `flush`
/// answers at once and an endless loop would starve the event loop.
Future<void> _endless(HttpRequest request) async {
  final chunk = List<int>.filled(64 * 1024, 0x20);
  try {
    for (var i = 0; i < 16; i++) {
      request.response.add(chunk);
      await request.response.flush();
    }
  } catch (_) {
    // The client stopped reading, which is what the case waits for.
  }
}

/// Runs [script] under `/bin/sh` with [files] as `$1`, `$2`…, until a run times
/// out after the script wrote its pid to [files].first (once its trap is set).
/// The timeout counts from the start, and a loaded computer can take longer
/// than that to start `/bin/sh`: a TERM that comes first proves nothing, so
/// that run is repeated with twice the timeout. Each run starts with none of
/// [files]. Returns the pid.
Future<int> _timeOutOnceTrapped(String script, List<File> files) async {
  for (var timeout = const Duration(seconds: 1); ; timeout *= 2) {
    for (final file in files.where((file) => file.existsSync())) {
      file.deleteSync();
    }
    await expectLater(
      runDeviceAppTool('/bin/sh', [
        '-c',
        script,
        'sh',
        for (final file in files) file.path,
      ], timeout: timeout),
      throwsA(isA<TimeoutException>()),
    );
    final pid = files.first.existsSync()
        ? int.tryParse(files.first.readAsStringSync().trim())
        : null;
    if (pid != null) return pid;
    if (timeout >= const Duration(seconds: 8)) {
      fail('/bin/sh did not set its trap within $timeout');
    }
  }
}

/// Four runs of [_timeOutOnceTrapped] take up to 15 s of timeouts and 5 s of
/// waiting on TERM each, more than the default 30 s.
const _trapTimeout = Timeout(Duration(minutes: 1));

void main() {
  late Directory root, first, home, tempRoot;
  late HttpServer server;
  late Map<String, _Handler> routes;
  late List<String> seen;
  late List<Socket> held;
  late List<int> archive;
  late List<List<String>> calls;
  late List<Duration?> timeouts;
  late Future<ProcessResult> Function(List<String> call, ProcessResult result)
  afterTool;
  late Future<ProcessResult> Function(String setup) setupAnswer;
  late Future<bool> Function() signatureAnswer;
  late List<String> signed;
  late bool opens;
  late List<String?> opened;
  late List<String> readOnly;
  late String windowsPlace, linuxPlace;
  late List<String> launched;
  late Future<void> Function(String appImage) launcherAnswer;

  void makeReadOnly(String folder) {
    _setMode(folder, 0x16d); // 0555
    readOnly.add(folder);
  }

  /// The home's `Applications`, missing until the installer makes it.
  String second() => p.join(home.path, 'Applications');
  String bundleIn(String folder) => p.join(folder, deviceAppBundleName);
  List<String> namesIn(String folder) => Directory(folder).existsSync()
      ? [
          for (final entry in Directory(folder).listSync())
            p.basename(entry.path),
        ]
      : const [];
  Iterable<String> partialsIn(String folder) =>
      namesIn(folder).where((name) => name.endsWith('.partial'));

  void serveManifest(Map<String, Object?> manifest) =>
      routes['/metadata.json'] = _respond(200, _json(manifest));

  /// Serves [bytes] as the archive, under a manifest that names it truly.
  void publish(List<int> bytes) {
    routes[_archivePath] = _respond(200, bytes);
    serveManifest({'device-macos': _entry(bytes)});
  }

  /// Serves [bytes] as [platform]'s package under its x64 key.
  void publishFor(TargetPlatform platform, List<int> bytes) {
    final (key, path) = platform == TargetPlatform.windows
        ? ('device-windows-x64', _setupPath)
        : ('device-linux-x64', _appImagePath);
    routes[path] = _respond(200, bytes);
    serveManifest({key: _entry(bytes, path: path)});
  }

  /// What the fake Windows installer does by default: puts the app at its place.
  ProcessResult installAt(String place) {
    File(place)
      ..createSync(recursive: true)
      ..writeAsStringSync('installed');
    return ProcessResult(0, 0, '', '');
  }

  setUp(() async {
    root = Directory.systemTemp.createTempSync('device-app-installer-test-');
    first = Directory(p.join(root.path, 'Applications'))..createSync();
    home = Directory(p.join(root.path, 'home'))..createSync();
    tempRoot = Directory(p.join(root.path, 'temp'))..createSync();
    windowsPlace = p.join(
      root.path,
      'Local AppData',
      'Harness Device',
      deviceAppWindowsExe,
    );
    linuxPlace = p.join(home.path, '.local', 'opt', deviceAppImageName);
    seen = [];
    held = [];
    calls = [];
    timeouts = [];
    afterTool = (call, result) async => result;
    setupAnswer = (setup) async => installAt(windowsPlace);
    signatureAnswer = () async => true;
    signed = [];
    opens = true;
    opened = [];
    readOnly = [];
    launched = [];
    launcherAnswer = (appImage) async {};
    routes = {};
    archive = _bundleArchive();
    publish(archive);
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) {
      seen.add(request.uri.path);
      (routes[request.uri.path] ?? _respond(404, const []))(request);
    });
  });

  tearDown(() async {
    for (final socket in held) {
      socket.destroy();
    }
    await server.close(force: true);
    for (final folder in readOnly) {
      _setMode(folder, 0x1ed); // 0755
    }
    root.deleteSync(recursive: true);
  });

  Future<ProcessResult> run(
    String executable,
    List<String> arguments, {
    Duration? timeout,
  }) async {
    final call = [executable, ...arguments];
    calls.add(call);
    timeouts.add(timeout);
    // What was downloaded is never run here: the fake installer stands in.
    if (p.isWithin(tempRoot.path, executable)) return setupAnswer(executable);
    return afterTool(
      call,
      timeout == null
          ? await runDeviceAppTool(executable, arguments)
          : await runDeviceAppTool(executable, arguments, timeout: timeout),
    );
  }

  /// Sends the CDN's requests to the loopback server.
  Dio loopbackDio() => Dio()
    ..interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          final uri = options.uri;
          if (uri.host == 'cdn.autonomous.ai') {
            options.path = uri
                .replace(
                  scheme: 'http',
                  host: server.address.host,
                  port: server.port,
                )
                .toString();
          }
          handler.next(options);
        },
      ),
    );

  /// macOS's unless [platform] is given; [place] null leaves the installer's
  /// own default.
  DeviceAppInstaller installer({
    TargetPlatform platform = TargetPlatform.macOS,
    String? place,
    String architecture = 'arm64',
    Duration downloadTimeout = const Duration(minutes: 5),
  }) => DeviceAppInstaller(
    manifestUrl: 'http://${server.address.host}:${server.port}/metadata.json',
    targetFolders: [first.path, second()],
    verifySignature: (bundle) {
      signed.add(bundle);
      return signatureAnswer();
    },
    open: ({String? path}) async {
      opened.add(path);
      return opens;
    },
    dio: loopbackDio(),
    run: run,
    platform: platform,
    place: place,
    architecture: architecture,
    tempRoot: tempRoot,
    downloadTimeout: downloadTimeout,
    // Recorded, never the real one: no case writes under this computer's home.
    launcher: (appImage) {
      launched.add(appImage);
      return launcherAnswer(appImage);
    },
  );

  DeviceAppInstaller onWindows() => installer(
    platform: TargetPlatform.windows,
    place: windowsPlace,
    architecture: 'x64',
  );

  DeviceAppInstaller onLinux() => installer(
    platform: TargetPlatform.linux,
    place: linuxPlace,
    architecture: 'x64',
  );

  void expectNothingInstalled() {
    for (final folder in [first.path, second()]) {
      expect(namesIn(folder), isNot(contains(deviceAppBundleName)));
      expect(partialsIn(folder), isEmpty);
    }
    expect(tempRoot.listSync(), isEmpty);
    expect(opened, isEmpty);
  }

  Future<DeviceAppInstallStep?> failedStep() async =>
      (await installer().install()).failed;

  test(
    'a manifest that cannot be read fails at manifest and fetches nothing else',
    () async {
      final manifest = {'device-macos': _entry(archive)};
      routes['/elsewhere.json'] = _respond(200, _json(manifest));
      final unreadable = <String, _Handler>{
        'status 500': _respond(500, _json(manifest)),
        'an HTML page': _respond(200, utf8.encode('<html>')),
        'a list': _respond(200, utf8.encode('[]')),
        'a body with no end': _endless,
        'a body past 64 KiB': _respond(
          200,
          utf8.encode(
            '${jsonEncode(manifest)}${' ' * deviceAppManifestMaxBytes}',
          ),
        ),
        'a redirect': _redirect('/elsewhere.json'),
      };
      for (final MapEntry(key: name, value: handler) in unreadable.entries) {
        routes['/metadata.json'] = handler;
        expect(await failedStep(), DeviceAppInstallStep.manifest, reason: name);
        expect(seen, everyElement('/metadata.json'), reason: name);
        expectNothingInstalled();
      }
    },
  );

  test('a manifest whose entry may not be fetched fails at manifest', () async {
    const elsewhere = '/harness/desktop/0.0.0/Harness-Device.app.tar.gz';
    routes[elsewhere] = _respond(200, archive);
    serveManifest({'device-macos': _entry(archive, path: elsewhere)});

    expect(await failedStep(), DeviceAppInstallStep.manifest);
    expect(seen, ['/metadata.json']);
    expectNothingInstalled();
  });

  test(
    'Intel asks for device-macos, Apple Silicon for device-macos-arm64',
    () async {
      const arm64Path = '/harness/device/0.0.0/arm64/Harness-Device.app.tar.gz';
      routes.remove(_archivePath);
      serveManifest({
        'device-macos': _entry(archive),
        'device-macos-arm64': _entry(archive, path: arm64Path),
      });

      await installer(architecture: 'x64').install();
      expect(seen.last, _archivePath);
      await installer(architecture: 'arm64').install();
      expect(seen.last, arm64Path);
    },
  );

  test('a download that is refused fails at download', () async {
    routes[_archivePath] = _respond(404, const []);

    expect(await failedStep(), DeviceAppInstallStep.download);
    expectNothingInstalled();
  });

  test('a connection that closes early fails at download', () async {
    routes[_archivePath] = (request) async {
      request.response.contentLength = archive.length;
      final socket = await request.response.detachSocket();
      socket.add(archive.sublist(0, archive.length ~/ 2));
      await socket.flush();
      socket.destroy();
    };

    expect(await failedStep(), DeviceAppInstallStep.download);
    expectNothingInstalled();
  });

  test('a download that stalls fails at download', () async {
    routes[_archivePath] = (request) async {
      request.response.contentLength = archive.length;
      // The headers go out with the socket; the body never does.
      held.add(await request.response.detachSocket());
    };

    final result = await installer(
      downloadTimeout: const Duration(milliseconds: 200),
    ).install();
    expect(result.failed, DeviceAppInstallStep.download);
    expectNothingInstalled();
  });

  test('a body longer than the manifest says stops at download', () async {
    routes[_archivePath] = _endless;

    // Only stopping on the first byte past the size lets this return.
    expect(await failedStep(), DeviceAppInstallStep.download);
    expectNothingInstalled();
  });

  test('a shorter file fails at checksum', () async {
    final shorter = archive.sublist(0, archive.length - 1);
    routes[_archivePath] = _respond(200, shorter);
    // The hash is the shorter file's own: only its length gives it away.
    serveManifest({'device-macos': _entry(shorter, size: shorter.length + 1)});

    expect(await failedStep(), DeviceAppInstallStep.checksum);
    expectNothingInstalled();
  });

  test('a file with another sha256 fails at checksum', () async {
    final changed = [...archive];
    changed[changed.length ~/ 2] ^= 0xff;
    routes[_archivePath] = _respond(200, changed);

    expect(await failedStep(), DeviceAppInstallStep.checksum);
    expectNothingInstalled();
  });

  test('a redirect on the archive is not followed', () async {
    routes[_archivePath] = _redirect('/elsewhere.tar.gz');
    routes['/elsewhere.tar.gz'] = _respond(200, archive);

    expect(await failedStep(), DeviceAppInstallStep.download);
    expect(seen, isNot(contains('/elsewhere.tar.gz')));
    expectNothingInstalled();
  });

  test('a second install after a failure starts clean', () async {
    routes[_archivePath] = _respond(404, const []);
    expect(await failedStep(), DeviceAppInstallStep.download);
    expect(tempRoot.listSync(), isEmpty);

    final changed = [...archive];
    changed[0] ^= 0xff;
    routes[_archivePath] = _respond(200, changed);
    expect(await failedStep(), DeviceAppInstallStep.checksum);
    expect(tempRoot.listSync(), isEmpty);
    expect(seen.where((path) => path == '/metadata.json'), hasLength(2));
  });

  test('open goes by path, or by bundle id', () async {
    final ran = <List<String>>[];
    var exitCode = 0;
    Future<ProcessResult> recorder(
      String executable,
      List<String> arguments, {
      Duration? timeout,
    }) async {
      ran.add([executable, ...arguments]);
      return ProcessResult(0, exitCode, '', '');
    }

    expect(
      await openDeviceApp(recorder, path: '/x/Harness Device.app'),
      isTrue,
    );
    expect(await openDeviceApp(recorder), isTrue);
    expect(ran, [
      ['/usr/bin/open', '/x/Harness Device.app'],
      ['/usr/bin/open', '-b', 'ai.autonomous.harness.device'],
    ]);
    exitCode = 1;
    expect(await openDeviceApp(recorder), isFalse);
    expect(
      await openDeviceApp(
        (executable, arguments, {Duration? timeout}) async =>
            throw TimeoutException('open'),
      ),
      isFalse,
    );
  });

  test('the targets are Applications, then the home\'s', () {
    expect(deviceAppTargetFolders(), [
      '/Applications',
      p.join(maybeHomeDir()!, 'Applications'),
    ]);
  });

  test('a tool still running after its timeout throws', () async {
    await expectLater(
      runDeviceAppTool('/bin/sleep', [
        '30',
      ], timeout: const Duration(milliseconds: 100)),
      throwsA(isA<TimeoutException>()),
    );
  }, skip: Platform.isWindows ? 'needs /bin/sleep' : null);

  test(
    'a tool that times out has ended before the throw',
    () async {
      // It writes after it is told to stop: the cleanup that follows the throw
      // must not race it.
      final written = File(p.join(root.path, 'written'));
      await _timeOutOnceTrapped(
        r'''trap 'kill $!; sleep 0.3; : > "$2"; exit 0' TERM; echo $$ > "$1"; sleep 30 & wait''',
        [File(p.join(root.path, 'pid')), written],
      );
      expect(written.existsSync(), isTrue);
    },
    timeout: _trapTimeout,
    skip: Platform.isWindows ? 'needs /bin/sh' : null,
  );

  test(
    'a tool that ignores TERM is killed before the throw',
    () async {
      final pid = await _timeOutOnceTrapped(
        r'''trap '' TERM; echo $$ > "$1"; exec sleep 30''',
        [File(p.join(root.path, 'pid'))],
      );
      // CONT changes nothing for a process still running; one that has ended
      // and been reaped takes no signal.
      expect(Process.killPid(pid, ProcessSignal.sigcont), isFalse);
    },
    timeout: _trapTimeout,
    skip: Platform.isWindows ? 'needs /bin/sh' : null,
  );

  test(
    'installs into the first folder, opens it, and leaves nothing behind',
    () async {
      final result = await installer().install();

      final installed = bundleIn(first.path);
      expect(result.failed, isNull);
      expect(result.installedAt, installed);
      expect(
        File(p.join(installed, 'Contents', 'Info.plist')).readAsStringSync(),
        _plist,
      );
      expect(
        File(p.join(installed, 'Contents', 'MacOS', 'harness-device'))
            .existsSync(),
        isTrue,
      );
      expect(opened, [installed]);
      expect(tempRoot.listSync(), isEmpty);
      expect(partialsIn(first.path), isEmpty);

      expect(calls, hasLength(2));
      final [tar, ditto] = calls;
      final temp = p.dirname(tar[2]);
      expect(p.dirname(temp), tempRoot.path);
      expect(p.basename(temp), startsWith('harness-device-app-'));
      final unpacked = p.join(temp, 'app');
      expect(tar, [
        '/usr/bin/tar',
        '-xzf',
        p.join(temp, 'Harness-Device.app.tar.gz'),
        '-C',
        unpacked,
      ]);
      final bundle = p.join(unpacked, deviceAppBundleName);
      expect(ditto, hasLength(3));
      expect(ditto.take(2), ['/usr/bin/ditto', bundle]);
      expect(p.dirname(ditto[2]), first.path);
      expect(
        ditto[2],
        matches(RegExp(r'/\.Harness Device\.app\.[0-9a-f]{16}\.partial$')),
      );
      expect(signed, [bundle]);
    },
    skip: _needsDitto,
  );

  test(
    'a folder it cannot write falls back to the next, created if missing',
    () async {
      makeReadOnly(first.path);

      final result = await installer().install();

      final installed = bundleIn(second());
      expect(result.failed, isNull);
      expect(result.installedAt, installed);
      expect(
        File(p.join(installed, 'Contents', 'Info.plist')).existsSync(),
        isTrue,
      );
      expect(namesIn(first.path), isEmpty);
      expect(partialsIn(second()), isEmpty);
      expect(opened, [installed]);
      expect(tempRoot.listSync(), isEmpty);
    },
    skip: _needsDitto,
  );

  test('neither folder writable fails at install', () async {
    makeReadOnly(first.path);
    makeReadOnly(home.path);

    expect(await failedStep(), DeviceAppInstallStep.install);
    expectNothingInstalled();
  }, skip: _needsDitto);

  test(
    'an existing copy is installed: nothing is written and it is opened',
    () async {
      File(p.join(bundleIn(first.path), 'marker')).createSync(recursive: true);

      var result = await installer().install();

      expect(result.failed, isNull);
      expect(result.installedAt, bundleIn(first.path));
      expect(namesIn(bundleIn(first.path)), ['marker']);
      expect(
        calls.map((call) => call.first),
        isNot(contains('/usr/bin/ditto')),
      );
      expect(opened, [bundleIn(first.path)]);
      expect(tempRoot.listSync(), isEmpty);

      // The same with the copy in the home's folder, the first read-only.
      Directory(bundleIn(first.path)).deleteSync(recursive: true);
      makeReadOnly(first.path);
      File(p.join(bundleIn(second()), 'marker')).createSync(recursive: true);
      opened.clear();

      result = await installer().install();

      expect(result.failed, isNull);
      expect(result.installedAt, bundleIn(second()));
      expect(namesIn(bundleIn(second())), ['marker']);
      expect(namesIn(first.path), isEmpty);
      expect(partialsIn(second()), isEmpty);
      expect(opened, [bundleIn(second())]);
      expect(tempRoot.listSync(), isEmpty);
    },
    skip: _needsDitto,
  );

  test('an archive that is not one bundle fails at unpack', () async {
    final notOneBundle = <String, List<int>>{
      'two top-level entries': _tarGz([
        _infoPlist('Harness Device.app'),
        ArchiveFile.string('README', 'and more'),
      ]),
      'a link named as the bundle': _tarGz([
        // To the folder it is unpacked in: a directory, once followed.
        ArchiveFile.symlink('Harness Device.app', '.'),
      ]),
      'a file named as the bundle': _tarGz([
        ArchiveFile.string('Harness Device.app', 'not a bundle'),
      ]),
      'another bundle': _tarGz([_infoPlist('Other.app')]),
      'bytes that are not gzip': utf8.encode('not gzip'),
    };
    for (final MapEntry(key: name, value: bytes) in notOneBundle.entries) {
      publish(bytes);
      expect(await failedStep(), DeviceAppInstallStep.unpack, reason: name);
      expectNothingInstalled();
    }
    expect(signed, isEmpty);
  }, skip: _needsDitto);

  test(
    'an archive that reaches outside its folder writes nothing outside',
    () async {
      // The installer leaves these to tar: bsdtar, macOS's `/usr/bin/tar`,
      // refuses both unless told otherwise.
      final reachingOut = <String, List<int>>{
        'a .. entry': _tarGz([
          _infoPlist('Harness Device.app'),
          // From `<temp>/harness-device-app-*/app` up to the test's root.
          ArchiveFile.string('../../../outside', 'written'),
        ]),
        'a write through a link': _tarGz([
          _infoPlist('Harness Device.app'),
          ArchiveFile.symlink('Harness Device.app/link', root.path),
          ArchiveFile.string('Harness Device.app/link/outside', 'written'),
        ]),
      };
      for (final MapEntry(key: name, value: bytes) in reachingOut.entries) {
        publish(bytes);
        expect(await failedStep(), DeviceAppInstallStep.unpack, reason: name);
        expect(
          namesIn(root.path),
          unorderedEquals(['Applications', 'home', 'temp']),
          reason: name,
        );
        expectNothingInstalled();
      }
      expect(signed, isEmpty);
    },
    skip: Platform.isMacOS ? null : "needs macOS's bsdtar",
  );

  test('a bundle the signature check refuses fails at signature', () async {
    signatureAnswer = () async => false;
    expect(await failedStep(), DeviceAppInstallStep.signature);
    expectNothingInstalled();

    signatureAnswer = () async => throw Exception('codesign');
    expect(await failedStep(), DeviceAppInstallStep.signature);
    expectNothingInstalled();
    expect(signed, hasLength(2));
  }, skip: _needsDitto);

  test('another window finishing first counts as installed', () async {
    afterTool = (call, result) async {
      if (call.first == '/usr/bin/ditto') {
        File(p.join(bundleIn(first.path), 'marker'))
            .createSync(recursive: true);
      }
      return result;
    };

    final result = await installer().install();

    expect(result.failed, isNull);
    expect(result.installedAt, bundleIn(first.path));
    expect(namesIn(bundleIn(first.path)), ['marker']);
    expect(partialsIn(first.path), isEmpty);
    expect(opened, [bundleIn(first.path)]);
    expect(tempRoot.listSync(), isEmpty);
  }, skip: _needsDitto);

  test(
    'a partial that cannot be removed leaves the result as it was',
    () async {
      afterTool = (call, result) async {
        if (call.first == '/usr/bin/ditto') {
          File(p.join(bundleIn(first.path), 'marker'))
              .createSync(recursive: true);
          // Nothing in a folder this person cannot write can be removed.
          makeReadOnly(p.join(call[2], 'Contents'));
        }
        return result;
      };

      final result = await installer().install();

      expect(result.failed, isNull);
      expect(result.installedAt, bundleIn(first.path));
      expect(opened, [bundleIn(first.path)]);
    },
    skip: _needsDitto,
  );

  test('a partial that cannot be renamed fails at install', () async {
    afterTool = (call, result) async {
      if (call.first == '/usr/bin/ditto') {
        Directory(call[2]).deleteSync(recursive: true);
      }
      return result;
    };

    expect(await failedStep(), DeviceAppInstallStep.install);
    expectNothingInstalled();
  }, skip: _needsDitto);

  test('a copy that stops part way is removed', () async {
    afterTool = (call, result) async => call.first == '/usr/bin/ditto'
        ? ProcessResult(result.pid, 1, '', '')
        : result;

    expect(await failedStep(), DeviceAppInstallStep.install);
    expect(Directory(second()).existsSync(), isFalse);
    expectNothingInstalled();
  }, skip: _needsDitto);

  test('an app that will not open is still installed', () async {
    opens = false;

    final result = await installer().install();

    expect(result.failed, DeviceAppInstallStep.open);
    expect(result.installedAt, bundleIn(first.path));
    expect(
      File(p.join(bundleIn(first.path), 'Contents', 'Info.plist')).existsSync(),
      isTrue,
    );
    expect(opened, [bundleIn(first.path)]);
    expect(tempRoot.listSync(), isEmpty);
  }, skip: _needsDitto);

  test(
    'windows: the installer runs silently, then the app opens from its place',
    () async {
      publishFor(TargetPlatform.windows, _setup);
      List<int>? ran;
      setupAnswer = (setup) async {
        ran = File(setup).readAsBytesSync();
        return installAt(windowsPlace);
      };

      final result = await onWindows().install();

      expect(result.failed, isNull);
      expect(result.installedAt, windowsPlace);
      expect(opened, [windowsPlace]);
      final [setupRun] = calls;
      final setup = setupRun.first;
      expect(p.dirname(p.dirname(setup)), tempRoot.path);
      expect(p.basename(setup), 'Harness-Device-setup.exe');
      expect(setupRun, [setup, '/S']);
      expect(timeouts, [const Duration(minutes: 5)]);
      expect(ran, _setup);
      expect(signed, [setup]);
      expect(tempRoot.listSync(), isEmpty);
    },
  );

  test('windows: the signature is checked before the installer runs', () async {
    publishFor(TargetPlatform.windows, _setup);
    for (final answer in <Future<bool> Function()>[
      () async => false,
      () async => throw Exception('signer'),
    ]) {
      signatureAnswer = answer;
      final result = await onWindows().install();
      expect(result.failed, DeviceAppInstallStep.signature);
      expect(result.installedAt, isNull);
    }
    expect(signed, hasLength(2));
    expect(calls, isEmpty);
    expect(File(windowsPlace).existsSync(), isFalse);
    expect(opened, isEmpty);
    expect(tempRoot.listSync(), isEmpty);
  });

  test(
    'windows: an installer that fails, or leaves no app, fails at install',
    () async {
      publishFor(TargetPlatform.windows, _setup);
      final answers = <String, Future<ProcessResult> Function(String)>{
        // The app is there: only the exit code tells.
        'exit 2': (setup) async {
          installAt(windowsPlace);
          return ProcessResult(0, 2, '', '');
        },
        'exit 0 and no app': (setup) async => ProcessResult(0, 0, '', ''),
        'past its time': (setup) async => throw TimeoutException('setup'),
      };
      for (final MapEntry(key: name, value: answer) in answers.entries) {
        setupAnswer = answer;
        final result = await onWindows().install();
        expect(result.failed, DeviceAppInstallStep.install, reason: name);
        expect(result.installedAt, isNull, reason: name);
        expect(opened, isEmpty, reason: name);
        expect(tempRoot.listSync(), isEmpty, reason: name);
        if (File(windowsPlace).existsSync()) File(windowsPlace).deleteSync();
      }
      expect(calls, hasLength(3));
    },
  );

  test(
    'windows: an app already in place is opened, not installed again',
    () async {
      publishFor(TargetPlatform.windows, _setup);
      File(windowsPlace)
        ..createSync(recursive: true)
        ..writeAsStringSync('mine');

      final result = await onWindows().install();

      expect(result.failed, isNull);
      expect(result.installedAt, windowsPlace);
      expect(File(windowsPlace).readAsStringSync(), 'mine');
      expect(calls, isEmpty);
      expect(opened, [windowsPlace]);
      expect(tempRoot.listSync(), isEmpty);
    },
  );

  test('linux: the AppImage lands executable at its place and opens', () async {
    publishFor(TargetPlatform.linux, _appImage);

    final result = await onLinux().install();

    expect(result.failed, isNull);
    expect(result.installedAt, linuxPlace);
    expect(File(linuxPlace).readAsBytesSync(), _appImage);
    expect(File(linuxPlace).statSync().mode & 0x1ff, 0x1ed); // 0755
    expect(namesIn(p.dirname(linuxPlace)), [deviceAppImageName]);
    final [chmod] = calls;
    expect(chmod.take(2), ['/bin/chmod', '0755']);
    expect(p.dirname(chmod[2]), p.dirname(linuxPlace));
    expect(
      p.basename(chmod[2]),
      matches(RegExp(r'^\.Harness-Device\.AppImage\.[0-9a-f]{16}\.partial$')),
    );
    expect(opened, [linuxPlace]);
    expect(tempRoot.listSync(), isEmpty);
  }, skip: _needsChmod);

  test('linux: no signature step runs', () async {
    publishFor(TargetPlatform.linux, _appImage);
    signatureAnswer = () async => false;

    final result = await onLinux().install();

    expect(result.failed, isNull);
    expect(signed, isEmpty);
  }, skip: _needsChmod);

  test('linux: a copy already at the place is kept', () async {
    publishFor(TargetPlatform.linux, _appImage);
    File(linuxPlace)
      ..createSync(recursive: true)
      ..writeAsBytesSync(const [1, 2, 3]);

    final result = await onLinux().install();

    expect(result.failed, isNull);
    expect(result.installedAt, linuxPlace);
    expect(File(linuxPlace).readAsBytesSync(), const [1, 2, 3]);
    expect(namesIn(p.dirname(linuxPlace)), [deviceAppImageName]);
    expect(calls, isEmpty);
    expect(opened, [linuxPlace]);
    expect(tempRoot.listSync(), isEmpty);
  });

  test('linux: a copy that cannot be made executable is removed and fails at install', () async {
    publishFor(TargetPlatform.linux, _appImage);
    afterTool = (call, result) async => call.first == '/bin/chmod'
        ? ProcessResult(result.pid, 1, '', '')
        : result;

    final result = await onLinux().install();

    expect(result.failed, DeviceAppInstallStep.install);
    expect(result.installedAt, isNull);
    expect(calls.single.first, '/bin/chmod');
    expect(namesIn(p.dirname(linuxPlace)), isEmpty);
    expect(opened, isEmpty);
    expect(tempRoot.listSync(), isEmpty);
  }, skip: _needsChmod);

  test(
    'linux: the installed app is put in the app list, before it opens',
    () async {
      publishFor(TargetPlatform.linux, _appImage);
      late List<int> atLaunch;
      late List<String?> openedAtLaunch;
      launcherAnswer = (appImage) async {
        atLaunch = File(appImage).readAsBytesSync();
        openedAtLaunch = [...opened];
      };

      final result = await onLinux().install();

      expect(result.failed, isNull);
      expect(launched, [linuxPlace]);
      expect(atLaunch, _appImage);
      expect(openedAtLaunch, isEmpty);
      expect(opened, [linuxPlace]);
    },
    skip: _needsChmod,
  );

  test('linux: a copy already at the place gets its entry too', () async {
    publishFor(TargetPlatform.linux, _appImage);
    File(linuxPlace)
      ..createSync(recursive: true)
      ..writeAsBytesSync(const [1, 2, 3]);

    final result = await onLinux().install();

    expect(result.failed, isNull);
    expect(launched, [linuxPlace]);
    expect(opened, [linuxPlace]);
  });

  test('linux: a launcher that throws does not fail the install', () async {
    publishFor(TargetPlatform.linux, _appImage);
    launcherAnswer = (appImage) async =>
        throw const FileSystemException('read-only');

    final result = await onLinux().install();

    expect(result.failed, isNull);
    expect(result.installedAt, linuxPlace);
    expect(launched, [linuxPlace]);
    expect(opened, [linuxPlace]);
  }, skip: _needsChmod);

  test('windows and macOS write no launcher entry', () async {
    publishFor(TargetPlatform.windows, _setup);
    expect((await onWindows().install()).failed, isNull);

    // A bundle already in the first folder: macOS opens it without ditto.
    publish(archive);
    Directory(bundleIn(first.path)).createSync();
    expect((await installer().install()).failed, isNull);

    expect(opened, [windowsPlace, bundleIn(first.path)]);
    expect(launched, isEmpty);
  }, skip: Platform.isWindows ? 'needs /usr/bin/tar' : null);

  test('no place, no install', () async {
    // flutter test reads as Android, which has no place: the installer's
    // default never names this computer's own.
    expect(deviceAppPlace(), isNull);
    for (final (platform, bytes) in [
      (TargetPlatform.windows, _setup),
      (TargetPlatform.linux, _appImage),
    ]) {
      publishFor(platform, bytes);
      final result = await installer(
        platform: platform,
        architecture: 'x64',
      ).install();
      expect(result.failed, DeviceAppInstallStep.install, reason: '$platform');
      expect(result.installedAt, isNull, reason: '$platform');
      expect(calls, isEmpty, reason: '$platform');
      expect(opened, isEmpty, reason: '$platform');
      expect(tempRoot.listSync(), isEmpty, reason: '$platform');
    }
  });

  test("the device app starts without Desktop's AppImage variables", () async {
    final started = <(String, Map<String, String>)>[];

    final ok = await startDeviceApp(
      '/home/p q/.local/opt/Harness-Device.AppImage',
      start: (path, environment) async => started.add((path, environment)),
      environment: const {
        'APPIMAGE': '/home/p q/.local/opt/Harness.AppImage',
        'APPDIR': '/tmp/.mount_HarnessX',
        'ARGV0': 'Harness.AppImage',
        'OWD': '/home/p q',
        'HARNESS_LINUX_TITLE_BAR': 'flutter',
        'HOME': '/home/p q',
        'PATH': '/usr/bin:/bin',
      },
    );

    expect(ok, isTrue);
    final [(path, environment)] = started;
    expect(path, '/home/p q/.local/opt/Harness-Device.AppImage');
    expect(environment, {'HOME': '/home/p q', 'PATH': '/usr/bin:/bin'});
  });

  // Desktop's runner points WebView2 at its own folder; the app's WebView2
  // keeps its own, however it was started.
  test("the device app starts without Desktop's WebView2 folder", () async {
    final started = <(String, Map<String, String>)>[];

    final ok = await startDeviceApp(
      r'C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe',
      start: (path, environment) async => started.add((path, environment)),
      environment: const {
        'WEBVIEW2_USER_DATA_FOLDER':
            r'C:\Users\Nguyễn Văn A\AppData\Local\Harness\WebView2',
        'LOCALAPPDATA': r'C:\Users\Nguyễn Văn A\AppData\Local',
      },
    );

    expect(ok, isTrue);
    final [(_, environment)] = started;
    expect(environment, {
      'LOCALAPPDATA': r'C:\Users\Nguyễn Văn A\AppData\Local',
    });
  });

  test('a start that throws is a failed open', () async {
    expect(
      await startDeviceApp(
        r'C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe',
        start: (path, environment) async =>
            throw const ProcessException('harness-device.exe', [], 'gone', 2),
        environment: const {},
      ),
      isFalse,
    );
  });
}
