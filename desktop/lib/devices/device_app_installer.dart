import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/dart.dart' show DartSha256;
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../core/hidden_process.dart';
import '../core/home_dir.dart';
import '../core/runtime_architecture.dart';
import '../core/runtime_platform.dart';
import 'device_app.dart';
import 'device_app_manifest.dart';

typedef DeviceAppRun = Future<ProcessResult> Function(
  String executable,
  List<String> arguments, {
  Duration timeout,
});
typedef DeviceAppSignatureCheck = Future<bool> Function(String bundle);
typedef DeviceAppStart = Future<void> Function(
  String path,
  Map<String, String> environment,
);

/// The Windows installer's bound: it may fetch WebView2 first.
const deviceAppSetupTimeout = Duration(minutes: 5);

/// What Desktop's own AppImage runtime set for Desktop. The Device app would
/// take Desktop's AppImage for its own (its login entry and its updater
/// follow `APPIMAGE`).
const _desktopAppImageVariables = {'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'};

/// The app at [path], with no argument, detached: it outlives Desktop and is
/// no child of it.
Future<void> startDeviceAppDetached(
  String path,
  Map<String, String> environment,
) async {
  await Process.start(
    path,
    const [],
    environment: environment,
    includeParentEnvironment: false,
    mode: ProcessStartMode.detached,
  );
}

/// Starts the app at [path] (Windows and Linux, which have no `open`) with
/// [environment], by default this process's, minus Desktop's AppImage
/// variables. True when the start succeeded, as `open`'s exit 0 is on macOS;
/// the app's own single instance makes a second start harmless.
Future<bool> startDeviceApp(
  String path, {
  DeviceAppStart start = startDeviceAppDetached,
  Map<String, String>? environment,
}) async {
  try {
    await start(path, {
      for (final MapEntry(:key, :value)
          in (environment ?? RuntimePlatform.environment).entries)
        if (!_desktopAppImageVariables.contains(key)) key: value,
    });
    return true;
  } on Exception {
    // A program that cannot start has not opened the app.
    return false;
  }
}

/// tar, ditto, chmod, open and the Windows installer through [startHidden]; a tool still running after [timeout] is stopped and throws.
Future<ProcessResult> runDeviceAppTool(
  String executable,
  List<String> arguments, {
  Duration timeout = const Duration(seconds: 60),
}) async {
  final process = await startHidden(executable, arguments);
  const output = Utf8Decoder(allowMalformed: true);
  final stdout = process.stdout.transform(output).join();
  final stderr = process.stderr.transform(output).join();
  try {
    final code = await process.exitCode.timeout(timeout);
    return ProcessResult(process.pid, code, await stdout, await stderr);
  } on TimeoutException {
    // Ended before the throw, so the cleanup that follows does not race a
    // tool still writing; one that outlasts TERM gets KILL. 5 s each, then
    // the throw goes on without it.
    for (final signal in const [ProcessSignal.sigterm, ProcessSignal.sigkill]) {
      process.kill(signal);
      try {
        await process.exitCode.timeout(const Duration(seconds: 5));
        break;
      } on TimeoutException {
        // Still running.
      }
    }
    rethrow;
  }
}

/// `/usr/bin/open <path>`, or `/usr/bin/open -b ai.autonomous.harness.device` when [path] is null.
Future<bool> openDeviceApp(DeviceAppRun run, {String? path}) async {
  try {
    final opened = await run(
      '/usr/bin/open',
      path == null ? const ['-b', deviceAppBundleId] : [path],
    );
    return opened.exitCode == 0;
  } on Exception {
    // An `open` that cannot start or does not finish has not opened the app.
    return false;
  }
}

/// `/Applications`, then `<home>/Applications` ([maybeHomeDir]; left out when nothing names a home).
List<String> deviceAppTargetFolders() {
  final home = maybeHomeDir();
  return ['/Applications', if (home != null) p.join(home, 'Applications')];
}

/// Downloads, verifies, installs and opens the Harness menu-bar app in seven
/// named steps, the first that fails named in the result. macOS unpacks
/// `Harness Device.app` into the first target folder that takes it; Windows
/// runs the per-user installer, which puts the app at its place
/// ([deviceAppPlace]); Linux puts the AppImage there. Neither unpacks, and
/// Linux checks no signature (an AppImage carries none).
class DeviceAppInstaller {
  DeviceAppInstaller({
    required this._manifestUrl,
    required this._targetFolders,
    required this._verifySignature,
    required this._open,
    Dio? dio,
    this._run = runDeviceAppTool,
    TargetPlatform? platform,
    String? place,
    this._architecture,
    this._tempRoot,
    this._manifestTimeout = const Duration(seconds: 15),
    this._downloadTimeout = const Duration(minutes: 5),
  }) : _platform = platform ?? defaultTargetPlatform,
       _place = place ?? deviceAppPlace(),
       _dio =
           dio ??
           Dio(
             BaseOptions(
               connectTimeout: const Duration(seconds: 10),
               receiveTimeout: const Duration(seconds: 30),
             ),
           );

  final String _manifestUrl;
  final List<String> _targetFolders;
  final DeviceAppSignatureCheck _verifySignature;
  final DeviceAppOpen _open;
  final Dio _dio;
  final DeviceAppRun _run;
  final TargetPlatform _platform;
  final String? _place;
  final String? _architecture;
  final Directory? _tempRoot;
  final Duration _manifestTimeout;
  final Duration _downloadTimeout;

  /// Never throws: every failure is a step. Removes its temporary directory whatever happened.
  Future<DeviceAppInstallResult> install() async {
    var step = DeviceAppInstallStep.manifest;
    Directory? temp;
    String? installed;
    try {
      final release = await _readManifest();
      step = DeviceAppInstallStep.download;
      temp = await (_tempRoot ?? Directory.systemTemp).createTemp(
        'harness-device-app-',
      );
      // A fixed name: nothing the network sends names a file on disk.
      final download = p.join(temp.path, switch (_platform) {
        TargetPlatform.windows => 'Harness-Device-setup.exe',
        TargetPlatform.linux => deviceAppImageName,
        _ => 'Harness-Device.app.tar.gz',
      });
      await _download(release, download);
      step = DeviceAppInstallStep.checksum;
      _require(
        await File(download).length() == release.size &&
            await _sha256OfFile(download) == release.sha256,
      );
      switch (_platform) {
        case TargetPlatform.windows:
          step = DeviceAppInstallStep.signature;
          _require(await _verifySignature(download));
          step = DeviceAppInstallStep.install;
          installed = await _runSetup(download);
        case TargetPlatform.linux:
          step = DeviceAppInstallStep.install;
          installed = await _placeAppImage(download);
        default:
          step = DeviceAppInstallStep.unpack;
          final bundle = await _unpack(download, p.join(temp.path, 'app'));
          step = DeviceAppInstallStep.signature;
          _require(await _verifySignature(bundle));
          step = DeviceAppInstallStep.install;
          installed = await _install(bundle);
      }
      step = DeviceAppInstallStep.open;
      _require(await _open(path: installed));
      return DeviceAppInstallResult.done(installed);
    } catch (_) {
      return DeviceAppInstallResult.failed(step, installedAt: installed);
    } finally {
      try {
        await temp?.delete(recursive: true);
      } on FileSystemException {
        // The result stands; what is left sits in the system's temporary
        // folder.
      }
    }
  }

  /// The manifest is the bucket's, never the CDN's, which could still serve
  /// the copy from before a release.
  Future<DeviceAppRelease> _readManifest() =>
      _within(_manifestTimeout, (cancel) async {
        final body = BytesBuilder(copy: false);
        await for (final chunk in await _get(_manifestUrl, cancel)) {
          body.add(chunk);
          _require(body.length <= deviceAppManifestMaxBytes);
        }
        return parseDeviceAppManifest(
              jsonDecode(utf8.decode(body.takeBytes())),
              architecture: _architecture ?? runtimeArchitecture,
              platform: _platform,
            ) ??
            (throw const _Refused());
      });

  Future<void> _download(DeviceAppRelease release, String archive) =>
      _within(_downloadTimeout, (cancel) async {
        final file = File(archive).openWrite();
        try {
          var received = 0;
          await for (final chunk in await _get(release.url, cancel)) {
            received += chunk.length;
            _require(received <= release.size);
            file.add(chunk);
          }
        } finally {
          await file.close();
        }
      });

  /// GET [url]'s body, status 200 only. Neither request follows a redirect,
  /// so nothing a server sends but the manifest's checked URL decides where a
  /// request goes.
  Future<Stream<Uint8List>> _get(String url, CancelToken cancel) async {
    final response = await _dio.get<ResponseBody>(
      url,
      cancelToken: cancel,
      options: Options(
        responseType: ResponseType.stream,
        followRedirects: false,
        validateStatus: (status) => status == 200,
        receiveDataWhenStatusError: false,
      ),
    );
    return response.data!.stream;
  }

  /// The single `Harness Device.app` directory the archive unpacks to.
  Future<String> _unpack(String archive, String folder) async {
    await Directory(folder).create();
    final untar = await _run('/usr/bin/tar', ['-xzf', archive, '-C', folder]);
    _require(untar.exitCode == 0);
    final entries = Directory(folder).listSync(followLinks: false);
    _require(
      entries.length == 1 &&
          entries.single is Directory &&
          p.basename(entries.single.path) == deviceAppBundleName,
    );
    return entries.single.path;
  }

  /// The installed bundle: the first target folder that already holds one, or
  /// takes the copy.
  Future<String> _install(String bundle) async {
    for (final (index, folder) in _targetFolders.indexed) {
      final target = p.join(folder, deviceAppBundleName);
      // Never overwritten: a copy already there, whoever put it, is the app.
      if (_exists(target)) return target;
      // Beside the target, so the rename is atomic and a half-made copy never
      // sits under the app's name.
      final partial = p.join(
        folder,
        '.$deviceAppBundleName.${_hex16()}.partial',
      );
      try {
        final ProcessResult copy;
        try {
          if (index > 0) await Directory(folder).create();
          copy = await _run('/usr/bin/ditto', [bundle, partial]);
        } on FileSystemException {
          continue;
        }
        if (copy.exitCode != 0) {
          // Nothing written: a folder this person cannot write. Something
          // written: a copy that stopped part way.
          _require(!_exists(partial));
          continue;
        }
        try {
          await Directory(partial).rename(target);
        } on FileSystemException {
          // Another window renamed its copy there first.
          _require(_exists(target));
        }
        return target;
      } finally {
        try {
          if (_exists(partial)) {
            await Directory(partial).delete(recursive: true);
          }
        } on FileSystemException {
          // The outcome stands: what is left is hidden, never under the
          // app's name.
        }
      }
    }
    throw const _Refused();
  }

  /// Windows: the app at the place, put there by the installer run silently
  /// (`/S`, per user, no admin) unless a copy is already there.
  Future<String> _runSetup(String setup) async {
    final place = _place ?? (throw const _Refused());
    // Never installed over: a copy already there, whoever put it, is the app.
    if (File(place).existsSync()) return place;
    final ran = await _run(setup, const ['/S'], timeout: deviceAppSetupTimeout);
    _require(ran.exitCode == 0 && File(place).existsSync());
    return place;
  }

  /// Linux: the AppImage at the place, executable, unless a copy is already
  /// there (the app updates itself in place).
  Future<String> _placeAppImage(String appImage) async {
    final place = _place ?? (throw const _Refused());
    if (_exists(place)) return place;
    final folder = p.dirname(place);
    await Directory(folder).create(recursive: true);
    // Beside the place, so the rename is atomic and a half-made copy never
    // sits under the app's name.
    final partial = p.join(folder, '.$deviceAppImageName.${_hex16()}.partial');
    try {
      await File(appImage).copy(partial);
      final chmod = await _run('/bin/chmod', ['0755', partial]);
      _require(chmod.exitCode == 0);
      await File(partial).rename(place);
      return place;
    } finally {
      try {
        if (_exists(partial)) await File(partial).delete();
      } on FileSystemException {
        // The outcome stands: what is left is hidden, never under the
        // app's name.
      }
    }
  }
}

/// A step's check that did not hold; [DeviceAppInstaller.install] names the step.
class _Refused implements Exception {
  const _Refused();
}

void _require(bool holds) {
  if (!holds) throw const _Refused();
}

/// Runs [request] within [timeout], then cancels it however it ended: leaving
/// Dio's stream early does not close the connection under it, cancelling does.
Future<T> _within<T>(
  Duration timeout,
  Future<T> Function(CancelToken cancel) request,
) async {
  final cancel = CancelToken();
  final timer = Timer(timeout, cancel.cancel);
  try {
    return await request(cancel);
  } finally {
    timer.cancel();
    cancel.cancel();
  }
}

/// Read in chunks on another isolate: the archive is never held in memory,
/// and the window does not stall while it is hashed.
Future<String> _sha256OfFile(String path) => Isolate.run(() async {
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
});

bool _exists(String path) =>
    FileSystemEntity.typeSync(path, followLinks: false) !=
    FileSystemEntityType.notFound;

String _hex16() {
  final random = Random.secure();
  return [
    for (var i = 0; i < 8; i++)
      random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ].join();
}
