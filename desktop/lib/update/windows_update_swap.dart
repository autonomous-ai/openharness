import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;

import 'windows_machine_architecture_native.dart'
    if (dart.library.js_interop) 'windows_machine_architecture_web.dart'
    as machine;

/// A downloaded Windows zip is unpacked into an owned directory on the install
/// volume. The installed version, launcher and pointers change only in [commit].
class WindowsUpdateSwap {
  WindowsUpdateSwap({
    required this.installRoot,
    ExtractStep? extract,
    Future<void> Function(String executable, List<String> arguments)? start,
    void Function(String from, String to)? renameFile,
    Future<void> Function(String path)? deleteClaimed,
  }) : _extract = extract ?? _extractOffUiIsolate,
       _start = start ?? _startDetached,
       _renameFile = renameFile ?? _nativeRenameFile,
       // ignore: prefer_initializing_formals
       _deleteClaimed = deleteClaimed,
       _cleanupCandidates = _snapshotCleanup(installRoot);

  final String installRoot;
  final ExtractStep _extract;
  final Future<void> Function(String executable, List<String> arguments) _start;
  final void Function(String from, String to) _renameFile;
  final Future<void> Function(String path)? _deleteClaimed;
  final List<_CleanupCandidate> _cleanupCandidates;

  static const appExe = 'harness-desktop.exe';
  static const launcherExe = 'Harness.exe';
  static const icon = 'Harness.ico';

  String? _expectedCurrent;
  DateTime? _sourceChanged;
  int? _sourceLength;
  String? _stagedVersion;
  String? _attemptRoot;

  /// True once the first installed path has been changed. A caller must not
  /// describe a later failure as an untouched, retryable update.
  bool get publicationStarted => _publicationStarted;
  bool _publicationStarted = false;
  bool get launcherNeedsRepair =>
      !_ordinaryFile(p.join(installRoot, launcherExe));

  String get _app => p.join(installRoot, 'app');
  String _staging(String attempt, String version) =>
      p.join(attempt, 'app', '$version.staging');

  /// Null means an owned attempt is ready. No installed path changes here.
  Future<String?> stage({
    required String zipPath,
    required String version,
  }) async {
    if (!windowsPackageVersion(version)) {
      return '"$version" is not a Windows package version';
    }
    if (_attemptRoot != null) return 'an update is already staged';
    final current = readPointer(p.join(installRoot, 'current'));
    if (current == null ||
        !_ordinaryDirectory(p.join(_app, current)) ||
        !_ordinaryFile(p.join(_app, current, appExe)) ||
        !_ordinaryFile(p.join(installRoot, launcherExe))) {
      return 'the current Harness install is not usable';
    }
    if (current == version) return 'Harness $version is already the one in use';
    if (!_windowsVersionGt(version, current)) {
      return 'Harness $version is not newer than $current';
    }
    if (_existsNoFollow(p.join(_app, version))) {
      return 'app/$version already exists';
    }
    if (!_ordinaryDirectory(installRoot) || !_ordinaryDirectory(_app)) {
      return 'the install app folder is not an ordinary directory';
    }
    FileStat sourceStat;
    try {
      sourceStat = FileStat.statSync(p.join(_app, current, appExe));
    } on FileSystemException {
      return 'the current version changed before staging';
    }

    String attempt;
    try {
      attempt = Directory(_app).createTempSync('.update-').path;
    } on FileSystemException catch (error) {
      return 'could not create update staging: ${error.message}';
    }
    String? error;
    try {
      error = await _extract(zipPath, attempt, version);
      if (error == null &&
          !_ordinaryFile(p.join(_staging(attempt, version), appExe))) {
        error = 'the update has no $appExe';
      }
      if (error == null &&
          !_ordinaryFile(p.join(attempt, '$launcherExe.new'))) {
        error = 'the update has no $launcherExe';
      }
      if (error == null && !_ordinaryFile(p.join(attempt, '$icon.new'))) {
        error = 'the update has no $icon';
      }
      if (error == null) {
        final source = p.join(_app, current, appExe);
        if (readPointer(p.join(installRoot, 'current')) != current ||
            !_ordinaryDirectory(p.join(_app, current)) ||
            !_ordinaryFile(source)) {
          error = 'the current version changed while staging';
        } else {
          final now = FileStat.statSync(source);
          if (now.changed != sourceStat.changed ||
              now.size != sourceStat.size) {
            error = 'the current version changed while staging';
          }
        }
      }
    } catch (caught) {
      error = 'could not unpack the update: $caught';
    }
    if (error != null) {
      await Isolate.run(() => _deleteOwnedAttempt(attempt));
      return error;
    }
    _attemptRoot = attempt;
    _expectedCurrent = current;
    _sourceChanged = sourceStat.changed;
    _sourceLength = sourceStat.size;
    _stagedVersion = version;
    return null;
  }

  /// Null means the new version is published. The short lock is tried once;
  /// a busy native install/launch leaves this update untouched for a retry.
  String? commit({required String version}) {
    final attempt = _attemptRoot;
    final expected = _expectedCurrent;
    if (attempt == null || expected == null || _stagedVersion != version) {
      return 'nothing is staged for $version';
    }
    if (!_ordinaryDirectory(installRoot) || !_ordinaryDirectory(_app)) {
      return 'the install root or app folder is not an ordinary directory';
    }
    RandomAccessFile? lock;
    var held = false;
    try {
      // FileMode.append creates without truncation; the coordination file is
      // never written or unlinked. FileLock.exclusive is nonblocking.
      lock = File(p.join(installRoot, 'launch-state.lock'))
          .openSync(mode: FileMode.append);
      lock.lockSync(FileLock.exclusive);
      held = true;

      if (!_ordinaryDirectory(installRoot) || !_ordinaryDirectory(_app)) {
        return 'the install root or app folder is not an ordinary directory';
      }

      final current = readPointer(p.join(installRoot, 'current'));
      if (current != expected) return 'current changed since staging';
      if (!_ordinaryFile(p.join(_app, expected, appExe))) {
        return 'the running version is no longer usable';
      }
      if (!_ordinaryDirectory(p.join(_app, expected))) {
        return 'the running version is not an ordinary directory';
      }
      final sourceStat = FileStat.statSync(p.join(_app, expected, appExe));
      if (sourceStat.changed != _sourceChanged ||
          sourceStat.size != _sourceLength) {
        return 'the running version changed since staging';
      }
      final target = p.join(_app, version);
      if (_existsNoFollow(target)) return 'app/$version already exists';
      if (!_ordinaryDirectory(attempt) ||
          !_ordinaryDirectory(p.join(attempt, 'app')) ||
          !_ordinaryDirectory(_staging(attempt, version)) ||
          !_ordinaryFile(p.join(_staging(attempt, version), appExe)) ||
          !_ordinaryFile(p.join(attempt, '$launcherExe.new')) ||
          !_ordinaryFile(p.join(attempt, '$icon.new')) ||
          !_ordinaryFile(p.join(installRoot, launcherExe)) ||
          !_ordinaryFile(p.join(installRoot, 'current'))) {
        return 'the staged or installed update files changed';
      }
      for (final name in [launcherExe, icon]) {
        if (_existsNoFollow(p.join(installRoot, '$name.old'))) {
          return '$name.old still exists; reopen Harness to clean up first';
        }
        final live = p.join(installRoot, name);
        if (_existsNoFollow(live) && !_ordinaryFile(live)) {
          return '$name is not an ordinary file';
        }
      }
      final previous = p.join(installRoot, 'previous');
      if (_existsNoFollow(previous) && !_ordinaryFile(previous)) {
        return 'previous is not an ordinary file';
      }
      final oldPrevious = _ordinaryFile(previous)
          ? File(previous).readAsBytesSync()
          : null;

      try {
        Directory(_staging(attempt, version)).renameSync(target);
        _publicationStarted = true;
      } on FileSystemException catch (error) {
        return 'could not move $version into place: ${error.message}';
      }

      for (final name in [launcherExe, icon]) {
        final swapError = _replaceByRename(attempt, name);
        if (swapError != null) return swapError;
      }
      try {
        _writePointer(previous, expected, _renameFile);
      } on FileSystemException catch (error) {
        return 'could not write previous: ${error.message}';
      }
      try {
        _writePointer(p.join(installRoot, 'current'), version, _renameFile);
      } on FileSystemException catch (error) {
        final restoreError = _restorePrevious(previous, oldPrevious);
        return 'could not write current: ${error.message}'
            '${restoreError == null ? '' : '; previous restore failed: $restoreError'}';
      }
      return null;
    } on FileSystemException catch (error) {
      return 'could not lock or inspect the install: ${error.message}';
    } finally {
      if (held) {
        try {
          lock?.unlockSync();
        } on FileSystemException {
          // Closing the owning handle also releases the Windows lock.
        }
      }
      lock?.closeSync();
    }
  }

  String? _replaceByRename(String attempt, String name) {
    final fresh = p.join(attempt, '$name.new');
    final live = p.join(installRoot, name);
    final old = p.join(installRoot, '$name.old');
    var movedOld = false;
    try {
      if (_ordinaryFile(live)) {
        _renameFile(live, old);
        movedOld = true;
      }
      _renameFile(fresh, live);
      return null;
    } on FileSystemException catch (error) {
      if (movedOld && !_existsNoFollow(live)) {
        try {
          _renameFile(old, live);
        } on FileSystemException catch (restore) {
          return 'could not replace $name: ${error.message}; '
              'old launcher/icon kept at $old because restore failed: ${restore.message}';
        }
      }
      return 'could not replace $name: ${error.message}';
    }
  }

  String? _restorePrevious(String path, List<int>? original) {
    try {
      if (original == null) {
        if (_existsNoFollow(path)) File(path).deleteSync();
      } else {
        _writeBytesAtomically(path, original, _renameFile);
      }
      return null;
    } on FileSystemException catch (error) {
      return error.message;
    }
  }

  /// Removes this attempt's remaining scratch output off the UI isolate.
  Future<void> discardStaged() async {
    final attempt = _attemptRoot;
    if (attempt == null) return;
    _attemptRoot = null;
    await Isolate.run(() => _deleteOwnedAttempt(attempt));
  }

  Future<void> relaunch(int selfPid) =>
      _start(p.join(installRoot, launcherExe), ['--wait-pid', '$selfPid']);

  /// Startup's shallow snapshot is captured by the constructor, before update
  /// polling can create a new attempt; recursive work stays off the UI isolate.
  Future<void> cleanUp() async {
    final root = installRoot;
    final candidates = _cleanupCandidates;
    for (final candidate in candidates) {
      final claimed = await Isolate.run(
        () => _claimCleanupCandidate(root, candidate),
      );
      if (claimed == null) continue;
      try {
        if (_deleteClaimed case final delete?) {
          await delete(claimed);
        } else {
          await Isolate.run(() => _deleteClaimedTree(root, claimed));
        }
      } on FileSystemException {
        // A scanner may retain the detached bytes until the next start.
      }
    }
  }
}

typedef ExtractStep = Future<String?> Function(
  String zipPath,
  String installRoot,
  String version,
);
typedef FileWriter = void Function(String path, Uint8List bytes);

Future<String?> _extractOffUiIsolate(
  String zipPath,
  String root,
  String version,
) => Isolate.run(() => extractUpdate(zipPath, root, version));

Future<void> _startDetached(String executable, List<String> arguments) =>
    Process.start(
      executable,
      arguments,
      mode: ProcessStartMode.detached,
    ).then((_) {});

void _nativeRenameFile(String from, String to) => File(from).renameSync(to);

bool _ordinaryFile(String path) =>
    FileSystemEntity.typeSync(path, followLinks: false) ==
    FileSystemEntityType.file;
bool _ordinaryDirectory(String path) =>
    FileSystemEntity.typeSync(path, followLinks: false) ==
    FileSystemEntityType.directory;
bool _existsNoFollow(String path) =>
    FileSystemEntity.typeSync(path, followLinks: false) !=
    FileSystemEntityType.notFound;

void _writeFile(String path, Uint8List bytes) {
  final file = File(path);
  file.parent.createSync(recursive: true);
  file.writeAsBytesSync(bytes, flush: true);
}

/// Unpacks one exact Windows package layout into an owned on-volume attempt.
/// Every archive entry is validated before the first file is written.
String? extractUpdate(
  String zipPath,
  String installRoot,
  String version, {
  FileWriter write = _writeFile,
}) {
  InputFileStream? input;
  try {
    input = InputFileStream(zipPath);
    final archive = ZipDecoder().decodeStream(input);
    final prefix = 'app/$version/';
    final files = <String, ArchiveFile>{};
    final directories = <String>{};
    final spellings = <String, String>{};
    final writes = <(String, ArchiveFile)>[];
    String? named;

    for (final entry in archive.files) {
      if (entry.name.contains(r'\')) {
        return 'the update has a noncanonical Windows path: ${entry.name}';
      }
      final raw = entry.name.replaceAll(r'\', '/');
      final directory = !entry.isFile && raw.endsWith('/');
      final name = directory ? raw.substring(0, raw.length - 1) : raw;
      final parts = name.split('/');
      if (raw.startsWith('/') ||
          parts.any((part) => !validVersionFolder(part)) ||
          entry.isSymbolicLink) {
        return 'the update holds a file outside its folder or a link: ${entry.name}';
      }
      if (parts.any((part) => part.toLowerCase() == '.started')) {
        return 'the update contains an inherited .started marker';
      }
      final allowed =
          name == 'Harness.exe' ||
          name == 'Harness.ico' ||
          name == 'current' ||
          name == 'app' ||
          name == 'app/$version' ||
          name.startsWith(prefix);
      if (!allowed ||
          ((name == 'app' || name == 'app/$version') && !directory) ||
          ((name == 'Harness.exe' ||
                  name == 'Harness.ico' ||
                  name == 'current') &&
              directory)) {
        return 'the update holds a file outside its folder: ${entry.name}';
      }
      final key = name.toLowerCase();
      for (var i = 1; i <= parts.length; i++) {
        final spelling = parts.take(i).join('/');
        final folded = spelling.toLowerCase();
        if (spellings[folded] case final existing? when existing != spelling) {
          return 'the update has case-aliased paths: ${entry.name}';
        }
        spellings[folded] = spelling;
      }
      if (files.containsKey(key) || directories.contains(key)) {
        return 'the update repeats a path: ${entry.name}';
      }
      if (directory) {
        directories.add(key);
        continue;
      }
      if (!entry.isFile) return 'the update holds a non-file: ${entry.name}';
      files[key] = entry;
      if (name == 'current') {
        final text = utf8.decode(entry.readBytes() ?? Uint8List(0));
        final normalized = text.startsWith('\uFEFF') ? text.substring(1) : text;
        named = normalized.split(RegExp(r'\r?\n')).first.trim();
        if (normalized
            .substring(normalized.indexOf(named) + named.length)
            .trim()
            .isNotEmpty) {
          return 'the update has more than one current line';
        }
      } else if (name == 'Harness.exe' || name == 'Harness.ico') {
        writes.add((p.join(installRoot, '$name.new'), entry));
      } else if (name.startsWith(prefix)) {
        final rest = name.substring(prefix.length).split('/');
        writes.add((
          p.joinAll([installRoot, 'app', '$version.staging', ...rest]),
          entry,
        ));
      }
    }

    for (final file in files.keys) {
      final parts = file.split('/');
      for (var i = 1; i < parts.length; i++) {
        if (files.containsKey(parts.take(i).join('/'))) {
          return 'the update has a file/directory collision';
        }
      }
      if (directories.contains(file)) {
        return 'the update has a file/directory collision';
      }
    }
    if (named != version) return 'the update is for "$named", not $version';
    for (final required in [
      'Harness.exe',
      'Harness.ico',
      'current',
      'app/$version/harness-desktop.exe',
    ]) {
      if (!files.containsKey(required.toLowerCase())) {
        return 'the update has no ${p.basename(required)}';
      }
    }
    if (!_ordinaryDirectory(installRoot)) {
      return 'the staging root is not an ordinary directory';
    }
    for (final (path, entry) in writes) {
      final parent = p.dirname(path);
      _createOrdinaryParents(installRoot, parent);
      if (_existsNoFollow(path)) {
        return 'the update output already exists: $path';
      }
      write(path, entry.readBytes() ?? Uint8List(0));
    }
    return null;
  } on FileSystemException catch (error) {
    return 'could not unpack the update: ${error.message}';
  } on Object catch (error) {
    return 'the update is not a readable zip: $error';
  } finally {
    input?.closeSync();
  }
}

void _createOrdinaryParents(String root, String parent) {
  final relative = p.relative(parent, from: root);
  var at = root;
  for (final part in p.split(relative)) {
    at = p.join(at, part);
    if (!_existsNoFollow(at)) Directory(at).createSync();
    if (!_ordinaryDirectory(at)) {
      throw FileSystemException(
        'update output parent is not an ordinary directory',
        at,
      );
    }
  }
}

void _deleteTreeNoFollow(String path) {
  final type = FileSystemEntity.typeSync(path, followLinks: false);
  if (type == FileSystemEntityType.directory) {
    for (final entry in Directory(path).listSync(followLinks: false)) {
      _deleteTreeNoFollow(entry.path);
    }
    Directory(path).deleteSync();
  } else if (type == FileSystemEntityType.link) {
    Link(path).deleteSync();
  } else if (type == FileSystemEntityType.file) {
    File(path).deleteSync();
  }
}

void _deleteOwnedAttempt(String path) {
  if (p.basename(path).startsWith('.update-') &&
      _ordinaryDirectory(p.dirname(path)) &&
      _ordinaryDirectory(path)) {
    _deleteTreeNoFollow(path);
  }
}

final class _CleanupCandidate {
  const _CleanupCandidate(this.path, this.changed, this.type, this.linkTarget);
  final String path;
  final DateTime changed;
  final FileSystemEntityType type;
  final String? linkTarget;
}

_CleanupCandidate? _cleanupCandidate(String path) {
  final type = FileSystemEntity.typeSync(path, followLinks: false);
  if (type == FileSystemEntityType.notFound) return null;
  if (type == FileSystemEntityType.link) {
    return _CleanupCandidate(
      path,
      DateTime.fromMillisecondsSinceEpoch(0),
      type,
      Link(path).targetSync(),
    );
  }
  return _CleanupCandidate(path, FileStat.statSync(path).changed, type, null);
}

List<_CleanupCandidate> _snapshotCleanup(String root) {
  final candidates = <_CleanupCandidate>[];
  final app = p.join(root, 'app');
  if (!_ordinaryDirectory(app)) return candidates;
  try {
    for (final entry in Directory(app).listSync(followLinks: false)) {
      final candidate = _cleanupCandidate(entry.path);
      if (candidate != null) candidates.add(candidate);
    }
    for (final name in [
      WindowsUpdateSwap.launcherExe,
      WindowsUpdateSwap.icon,
    ]) {
      for (final suffix in ['.new', '.old']) {
        final path = p.join(root, '$name$suffix');
        final candidate = _cleanupCandidate(path);
        if (candidate != null) candidates.add(candidate);
      }
    }
  } on FileSystemException {
    return const [];
  }
  return candidates;
}

String? _claimCleanupCandidate(String root, _CleanupCandidate candidate) {
  final app = p.join(root, 'app');
  if (!_ordinaryDirectory(root) || !_ordinaryDirectory(app)) return null;
  final current = readPointer(p.join(root, 'current'));
  if (current == null ||
      !_ordinaryDirectory(p.join(app, current)) ||
      !_ordinaryFile(p.join(app, current, WindowsUpdateSwap.appExe))) {
    return null;
  }
  RandomAccessFile? lock;
  var held = false;
  try {
    lock = File(p.join(root, 'launch-state.lock'))
        .openSync(mode: FileMode.append);
    lock.lockSync(FileLock.exclusive);
    held = true;
  } on FileSystemException {
    lock?.closeSync();
    return null;
  }
  try {
    if (!_ordinaryDirectory(root) || !_ordinaryDirectory(app)) return null;
    final finalCurrent = readPointer(p.join(root, 'current'));
    if (finalCurrent == null ||
        !_ordinaryDirectory(p.join(app, finalCurrent)) ||
        !_ordinaryFile(p.join(app, finalCurrent, WindowsUpdateSwap.appExe))) {
      return null;
    }
    final previous = readPointer(p.join(root, 'previous'));
    final keep = {finalCurrent.toLowerCase(), ?previous?.toLowerCase()};
    final path = candidate.path;
    final parent = p.dirname(path);
    final appEntry = parent == app;
    final rootEntry = parent == root;
    if (!appEntry && !rootEntry) return null;
    if (appEntry && keep.contains(p.basename(path).toLowerCase())) return null;
    if (rootEntry &&
        ![
          'Harness.exe.new',
          'Harness.exe.old',
          'Harness.ico.new',
          'Harness.ico.old',
        ].contains(p.basename(path))) {
      return null;
    }
    if (rootEntry &&
        p.basename(path).endsWith('.old') &&
        !_ordinaryFile(p.join(root, p.basename(path).split('.old').first))) {
      return null;
    }
    _CleanupCandidate? observed;
    try {
      observed = _cleanupCandidate(path);
    } on FileSystemException {
      return null;
    }
    if (observed == null ||
        observed.type != candidate.type ||
        observed.changed != candidate.changed ||
        observed.linkTarget != candidate.linkTarget) {
      return null;
    }
    // The candidate stops being publishable while the guard is held. The
    // exclusive temporary directory is on the install volume, so rename is
    // atomic; recursive destruction happens only after the guard is released.
    final quarantine = Directory(root).createTempSync('.update-cleanup-').path;
    final detached = p.join(quarantine, 'entry');
    try {
      if (candidate.type == FileSystemEntityType.directory) {
        Directory(path).renameSync(detached);
      } else if (candidate.type == FileSystemEntityType.file) {
        File(path).renameSync(detached);
      } else if (candidate.type == FileSystemEntityType.link) {
        Link(path).renameSync(detached);
      }
    } on FileSystemException {
      // The empty owned location is removed after releasing the guard.
    }
    return quarantine;
  } on FileSystemException {
    return null;
  } finally {
    if (held) {
      try {
        lock.unlockSync();
      } on FileSystemException {
        // Closing also releases the lock.
      }
    }
    lock.closeSync();
  }
}

void _deleteClaimedTree(String root, String claimed) {
  if (p.dirname(claimed) != root ||
      !p.basename(claimed).startsWith('.update-cleanup-') ||
      !_ordinaryDirectory(root) ||
      !_ordinaryDirectory(claimed)) {
    return;
  }
  _deleteTreeNoFollow(claimed);
}

void cleanUpInstall(String installRoot) {
  for (final candidate in _snapshotCleanup(installRoot)) {
    final claimed = _claimCleanupCandidate(installRoot, candidate);
    if (claimed == null) continue;
    try {
      _deleteClaimedTree(installRoot, claimed);
    } on FileSystemException {
      // A scanner may retain the detached bytes until the next start.
    }
  }
}

bool validVersionFolder(String value) {
  if (value.isEmpty || value == '.' || value.contains('..')) return false;
  if (RegExp(r'[/\\:\x00-\x1f\x7f-\x9f<>"|?*]').hasMatch(value)) return false;
  if (value.endsWith('.') || value.endsWith(' ')) return false;
  final stem = value.split('.').first.trimRight().toUpperCase();
  const devices = {'CON', 'PRN', 'AUX', 'NUL', r'CONIN$', r'CONOUT$'};
  if (devices.contains(stem)) return false;
  return !RegExp(r'^(COM|LPT)([1-9]|[¹²³])$').hasMatch(stem);
}

bool windowsPackageVersion(String version) =>
    RegExp(r'^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$')
        .hasMatch(version) &&
    validVersionFolder(version);

bool _windowsVersionGt(String a, String b) {
  final matchA = RegExp(r'^(\d+)\.(\d+)\.(\d+)').firstMatch(a);
  final matchB = RegExp(r'^(\d+)\.(\d+)\.(\d+)').firstMatch(b);
  if (matchA == null || matchB == null) return false;
  for (var i = 1; i <= 3; i++) {
    final x = BigInt.parse(matchA.group(i)!);
    final y = BigInt.parse(matchB.group(i)!);
    if (x != y) return x > y;
  }
  return false;
}

String? readPointer(String path) {
  try {
    if (!_ordinaryFile(path)) return null;
    final text = File(path).readAsStringSync(encoding: utf8);
    final normalized = text.startsWith('\uFEFF') ? text.substring(1) : text;
    final line = normalized.split(RegExp(r'\r?\n')).first.trim();
    return validVersionFolder(line) ? line : null;
  } on Object {
    return null;
  }
}

void _writeBytesAtomically(
  String path,
  List<int> bytes,
  void Function(String, String) rename,
) {
  final random = Random.secure();
  File? tmp;
  var reserved = false;
  for (var attempt = 0; attempt < 8; attempt++) {
    tmp = File('$path.${random.nextInt(1 << 32).toRadixString(16)}.tmp');
    try {
      tmp.createSync(exclusive: true);
      reserved = true;
      break;
    } on FileSystemException {
      if (_existsNoFollow(tmp.path)) continue;
      rethrow;
    }
  }
  if (!reserved || tmp == null) {
    throw FileSystemException(
      'could not reserve a pointer temporary file',
      path,
    );
  }
  try {
    tmp.writeAsBytesSync(bytes, flush: true);
    rename(tmp.path, path);
  } finally {
    try {
      if (_existsNoFollow(tmp.path)) tmp.deleteSync();
    } on FileSystemException {
      // Preserve the original publication error.
    }
  }
}

void _writePointer(
  String path,
  String value,
  void Function(String, String) rename,
) {
  if (!validVersionFolder(value)) {
    throw FileSystemException('not one version folder: "$value"', path);
  }
  _writeBytesAtomically(path, utf8.encode('$value\r\n'), rename);
}

void writePointer(String path, String value) =>
    _writePointer(path, value, _nativeRenameFile);

String? windowsInstallRootOf(String executable) {
  if (p.basename(executable).toLowerCase() != WindowsUpdateSwap.appExe) {
    return null;
  }
  final versionFolder = p.dirname(executable);
  if (!validVersionFolder(p.basename(versionFolder))) return null;
  final app = p.dirname(versionFolder);
  if (p.basename(app).toLowerCase() != 'app') return null;
  final root = p.dirname(app);
  return _ordinaryDirectory(root) &&
          _ordinaryDirectory(app) &&
          _ordinaryDirectory(versionFolder) &&
          _ordinaryFile(p.join(root, WindowsUpdateSwap.launcherExe))
      ? root
      : null;
}

String windowsMachineArchitecture() => machine.windowsMachineArchitecture();
