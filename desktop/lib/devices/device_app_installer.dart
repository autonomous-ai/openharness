import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/dart.dart' show DartSha256;
import 'package:dio/dio.dart';
import 'package:path/path.dart' as p;

import '../core/hidden_process.dart';
import '../core/home_dir.dart';
import '../core/runtime_architecture.dart';
import 'device_app.dart';
import 'device_app_manifest.dart';

typedef DeviceAppRun = Future<ProcessResult> Function(
  String executable,
  List<String> arguments,
);
typedef DeviceAppSignatureCheck = Future<bool> Function(String bundle);

/// tar, ditto and open through [startHidden]; a tool still running after [timeout] is killed and throws.
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
    process.kill();
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

/// Downloads, verifies, installs and opens the Harness menu-bar app
/// (`Harness Device.app`) in seven named steps, the first that fails named in
/// the result.
class DeviceAppInstaller {
  DeviceAppInstaller({
    required this._manifestUrl,
    required this._targetFolders,
    required this._verifySignature,
    required this._open,
    Dio? dio,
    this._run = runDeviceAppTool,
    this._architecture,
    this._tempRoot,
    this._manifestTimeout = const Duration(seconds: 15),
    this._downloadTimeout = const Duration(minutes: 5),
  }) : _dio =
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
      final archive = p.join(temp.path, 'Harness-Device.app.tar.gz');
      await _download(release, archive);
      step = DeviceAppInstallStep.checksum;
      _require(
        await File(archive).length() == release.size &&
            await _sha256OfFile(archive) == release.sha256,
      );
      step = DeviceAppInstallStep.unpack;
      final bundle = await _unpack(archive, p.join(temp.path, 'app'));
      step = DeviceAppInstallStep.signature;
      _require(await _verifySignature(bundle));
      step = DeviceAppInstallStep.install;
      installed = await _install(bundle);
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
        // folder, which macOS clears.
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
        if (_exists(partial)) await Directory(partial).delete(recursive: true);
      }
    }
    throw const _Refused();
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
