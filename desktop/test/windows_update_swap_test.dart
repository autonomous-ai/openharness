import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ffi/ffi.dart';
import 'package:harness/update/windows_update_swap.dart';
import 'package:path/path.dart' as p;

/// Hold a real Windows destination without FILE_SHARE_DELETE; an ordinary Dart
/// stream may permit rename and would not prove the locked-file failure path.
class _ExclusiveWindowsFile {
  _ExclusiveWindowsFile(String path) {
    final kernel32 = DynamicLibrary.open('kernel32.dll');
    final create = kernel32
        .lookupFunction<
          IntPtr Function(
            Pointer<Utf16>,
            Uint32,
            Uint32,
            Pointer<Void>,
            Uint32,
            Uint32,
            IntPtr,
          ),
          int Function(Pointer<Utf16>, int, int, Pointer<Void>, int, int, int)
        >('CreateFileW');
    _close = kernel32.lookupFunction<Int32 Function(IntPtr), int Function(int)>(
      'CloseHandle',
    );
    final wide = path.toNativeUtf16();
    try {
      _handle = create(wide, 0x80000000, 0, nullptr, 3, 0x80, 0);
    } finally {
      calloc.free(wide);
    }
    if (_handle == -1) throw StateError('CreateFileW could not lock $path');
  }

  late final int _handle;
  late final int Function(int) _close;
  void close() => _close(_handle);
}

Uint8List updateZip(
  String version, {
  Map<String, List<int>>? files,
  Set<String> leave = const {},
}) {
  final entries = <String, List<int>>{
    'Harness.exe': utf8.encode('launcher $version'),
    'Harness.ico': utf8.encode('icon $version'),
    'current': utf8.encode('$version\r\n'),
    'app/$version/harness-desktop.exe': utf8.encode('app $version'),
    'app/$version/data/app.so': utf8.encode('so $version'),
    ...?files,
  };
  final archive = Archive();
  for (final entry in entries.entries) {
    if (!leave.contains(entry.key)) {
      archive.addFile(ArchiveFile.bytes(entry.key, entry.value));
    }
  }
  return ZipEncoder().encodeBytes(archive);
}

void main() {
  late Directory dir;
  late String root;
  late String zip;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('windows-swap-');
    root = p.join(dir.path, "Nguyễn Văn A' & 100% !x", 'Harness');
    Directory(p.join(root, 'app', '1.2.0')).createSync(recursive: true);
    File(p.join(root, 'app', '1.2.0', 'harness-desktop.exe'))
        .writeAsStringSync('app 1.2.0');
    File(p.join(root, 'Harness.exe')).writeAsStringSync('launcher 1.2.0');
    File(p.join(root, 'Harness.ico')).writeAsStringSync('icon 1.2.0');
    File(p.join(root, 'current')).writeAsStringSync('1.2.0\r\n');
    zip = p.join(dir.path, 'update.zip');
  });

  tearDown(() => dir.deleteSync(recursive: true));

  Future<String?> stage(
    WindowsUpdateSwap swap,
    Uint8List bytes, {
    String version = '1.3.0',
  }) async {
    File(zip).writeAsBytesSync(bytes);
    return swap.stage(zipPath: zip, version: version);
  }

  String read(String relative) =>
      File(p.join(root, relative)).readAsStringSync();
  bool exists(String relative) =>
      FileSystemEntity.typeSync(p.join(root, relative), followLinks: false) !=
      FileSystemEntityType.notFound;

  void createJunction(String link, String target) {
    final parent = p.dirname(link);
    expect(
      FileSystemEntity.typeSync(parent, followLinks: false),
      FileSystemEntityType.directory,
    );
    expect(
      FileSystemEntity.typeSync(target, followLinks: false),
      FileSystemEntityType.directory,
    );
    expect(
      FileSystemEntity.typeSync(link, followLinks: false),
      FileSystemEntityType.notFound,
    );
    final result = Process.runSync('cmd.exe', [
      '/d',
      '/c',
      'mklink',
      '/J',
      p.basename(link),
      p.relative(target, from: parent),
    ], workingDirectory: parent);
    expect(result.exitCode, 0, reason: '${result.stdout}\n${result.stderr}');
  }

  List<FileSystemEntity> attempts() =>
      Directory(p.join(root, 'app'))
          .listSync(followLinks: false)
          .where((entry) => p.basename(entry.path).startsWith('.update-'))
          .toList();

  void oldInstallIntact() {
    expect(read('current'), '1.2.0\r\n');
    expect(read('Harness.exe'), 'launcher 1.2.0');
    expect(read('Harness.ico'), 'icon 1.2.0');
    expect(read('app/1.2.0/harness-desktop.exe'), 'app 1.2.0');
  }

  test('stage owns a unique on-volume attempt and leaves the installed files alone', () async {
    final swap = WindowsUpdateSwap(installRoot: root);
    expect(await stage(swap, updateZip('1.3.0')), isNull);
    expect(attempts(), hasLength(1));
    expect(
      File(
        p.join(
          attempts().single.path,
          'app',
          '1.3.0.staging',
          'harness-desktop.exe',
        ),
      ).readAsStringSync(),
      'app 1.3.0',
    );
    expect(exists('app/1.3.0'), isFalse);
    oldInstallIntact();
  });

  test(
    'commit uses the staged attempt and relaunches through Harness.exe',
    () async {
      final started = <(String, List<String>)>[];
      final swap = WindowsUpdateSwap(
        installRoot: root,
        start: (exe, args) async => started.add((exe, args)),
      );
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      expect(swap.commit(version: '1.3.0'), isNull);
      await swap.relaunch(4242);
      expect(read('current'), '1.3.0\r\n');
      expect(read('previous'), '1.2.0\r\n');
      expect(read('app/1.3.0/harness-desktop.exe'), 'app 1.3.0');
      expect(read('Harness.exe'), 'launcher 1.3.0');
      expect(read('Harness.exe.old'), 'launcher 1.2.0');
      expect(read('Harness.ico'), 'icon 1.3.0');
      expect(started.single.$1, p.join(root, 'Harness.exe'));
      expect(started.single.$2, ['--wait-pid', '4242']);
    },
  );

  test('a fresh swap cannot publish another attempt', () async {
    final staged = WindowsUpdateSwap(installRoot: root);
    expect(await stage(staged, updateZip('1.3.0')), isNull);
    expect(
      WindowsUpdateSwap(installRoot: root).commit(version: '1.3.0'),
      contains('nothing is staged'),
    );
    oldInstallIntact();
  });

  test(
    'commit refuses an app ancestor replaced by a link after staging',
    () async {
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      final outside = Directory(p.join(dir.path, 'external-app'));
      Directory(p.join(root, 'app')).renameSync(outside.path);
      File(p.join(outside.path, 'sentinel')).writeAsStringSync('keep');
      Link(p.join(root, 'app')).createSync(outside.path);
      expect(swap.commit(version: '1.3.0'), contains('ordinary'));
      expect(swap.publicationStarted, isFalse);
      expect(File(p.join(outside.path, 'sentinel')).readAsStringSync(), 'keep');
      expect(
        File(p.join(outside.path, '1.2.0', 'harness-desktop.exe'))
            .readAsStringSync(),
        'app 1.2.0',
      );
      expect(Directory(p.join(outside.path, '1.3.0')).existsSync(), isFalse);
      expect(read('current'), '1.2.0\r\n');
    },
    skip: Platform.isWindows
        ? 'Windows junction gate covers reparse points'
        : null,
  );

  test(
    'commit refuses an install root replaced by a link after staging',
    () async {
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      final outside = p.join(dir.path, 'external-root');
      Directory(root).renameSync(outside);
      File(p.join(outside, 'sentinel')).writeAsStringSync('keep');
      Link(root).createSync(outside);
      expect(swap.commit(version: '1.3.0'), contains('ordinary'));
      expect(swap.publicationStarted, isFalse);
      expect(File(p.join(outside, 'sentinel')).readAsStringSync(), 'keep');
      expect(
        File(p.join(outside, 'app', '1.2.0', 'harness-desktop.exe'))
            .readAsStringSync(),
        'app 1.2.0',
      );
      expect(Directory(p.join(outside, 'app', '1.3.0')).existsSync(), isFalse);
      expect(read('current'), '1.2.0\r\n');
    },
    skip: Platform.isWindows
        ? 'Windows junction gate covers reparse points'
        : null,
  );

  test('stage rejects an existing target and preserves its bytes', () async {
    Directory(p.join(root, 'app', '1.3.0')).createSync();
    File(p.join(root, 'app', '1.3.0', 'external')).writeAsStringSync('keep');
    final swap = WindowsUpdateSwap(installRoot: root);
    expect(await stage(swap, updateZip('1.3.0')), contains('already exists'));
    expect(read('app/1.3.0/external'), 'keep');
    expect(attempts(), isEmpty);
    oldInstallIntact();
  });

  test(
    'commit refuses a changed current without touching either version',
    () async {
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      File(p.join(root, 'current')).writeAsStringSync('1.1.0\r\n');
      expect(swap.commit(version: '1.3.0'), contains('current changed'));
      expect(read('current'), '1.1.0\r\n');
      expect(exists('app/1.3.0'), isFalse);
      expect(read('Harness.exe'), 'launcher 1.2.0');
    },
  );

  test(
    'commit refuses an installer replacement of the same current version',
    () async {
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      File(p.join(root, 'app', '1.2.0', 'harness-desktop.exe'))
          .writeAsStringSync('replaced current executable');
      expect(
        swap.commit(version: '1.3.0'),
        contains('running version changed'),
      );
      expect(swap.publicationStarted, isFalse);
      expect(exists('app/1.3.0'), isFalse);
      expect(read('current'), '1.2.0\r\n');
      expect(read('Harness.exe'), 'launcher 1.2.0');
    },
  );

  test('a corrupt or incomplete zip leaves no attempt', () async {
    final swap = WindowsUpdateSwap(installRoot: root);
    final bytes = updateZip('1.3.0');
    expect(
      await stage(swap, Uint8List.sublistView(bytes, 0, bytes.length ~/ 2)),
      isNotNull,
    );
    expect(
      await stage(
        swap,
        updateZip('1.3.0', leave: {'app/1.3.0/harness-desktop.exe'}),
      ),
      contains('no harness-desktop.exe'),
    );
    expect(
      await stage(swap, updateZip('1.3.0', leave: {'Harness.ico'})),
      contains('no Harness.ico'),
    );
    expect(attempts(), isEmpty);
    oldInstallIntact();
  });

  test('mid-extract disk failure clears only this attempt', () async {
    var writes = 0;
    final swap = WindowsUpdateSwap(
      installRoot: root,
      extract: (z, r, v) async => extractUpdate(
        z,
        r,
        v,
        write: (path, bytes) {
          if (++writes > 1) {
            throw const FileSystemException('No space left on device');
          }
          final file = File(path);
          file.parent.createSync(recursive: true);
          file.writeAsBytesSync(bytes);
        },
      ),
    );
    expect(
      await stage(swap, updateZip('1.3.0')),
      contains('No space left on device'),
    );
    expect(attempts(), isEmpty);
    oldInstallIntact();
  });

  test(
    'archive traversal, aliases, marker and invalid UTF-8 refuse output',
    () async {
      final samples = <Uint8List>[
        updateZip(
          '1.3.0',
          files: {'app/1.3.0/../../outside': utf8.encode('x')},
        ),
        updateZip('1.3.0', files: {'app/1.3.0/DATA/app.so': utf8.encode('x')}),
        updateZip('1.3.0', files: {'app/1.3.0/.started': utf8.encode('x')}),
        updateZip('1.3.0', files: {'app/1.3.0/COM¹.txt': utf8.encode('x')}),
        updateZip('1.3.0', files: {'app/1.3.0/name:stream': utf8.encode('x')}),
        updateZip(
          '1.3.0',
          files: {
            'current': [0xff, 0xfe],
          },
        ),
      ];
      for (final bytes in samples) {
        final swap = WindowsUpdateSwap(installRoot: root);
        expect(await stage(swap, bytes), isNotNull);
        expect(attempts(), isEmpty);
        oldInstallIntact();
      }
      expect(File(p.join(dir.path, 'outside')).existsSync(), isFalse);
    },
  );

  test('archive link is rejected before any output', () async {
    final archive = Archive();
    for (final entry in <String, String>{
      'Harness.exe': 'launcher',
      'Harness.ico': 'icon',
      'current': '1.3.0\r\n',
      'app/1.3.0/harness-desktop.exe': 'app',
    }.entries) {
      archive.addFile(ArchiveFile.bytes(entry.key, utf8.encode(entry.value)));
    }
    const linkName = 'app/1.3.0/data';
    archive.addFile(
      ArchiveFile.bytes(linkName, utf8.encode('../outside'))..mode = 0xA1FF,
    );
    // ZipEncoder writes DOS host metadata; mark this entry as a Unix symlink
    // in the central directory, as an incoming release zip could do.
    final encoded = ZipEncoder().encodeBytes(archive);
    var foundLink = false;
    for (var at = 0; at + 46 < encoded.length; at++) {
      if (encoded[at] != 0x50 ||
          encoded[at + 1] != 0x4b ||
          encoded[at + 2] != 0x01 ||
          encoded[at + 3] != 0x02) {
        continue;
      }
      final nameLength = encoded[at + 28] | (encoded[at + 29] << 8);
      if (utf8.decode(encoded.sublist(at + 46, at + 46 + nameLength)) ==
          linkName) {
        encoded[at + 5] = 3;
        foundLink = true;
        break;
      }
    }
    expect(foundLink, isTrue);
    final swap = WindowsUpdateSwap(installRoot: root);
    expect(await stage(swap, encoded), contains('link'));
    expect(attempts(), isEmpty);
    oldInstallIntact();
  });

  test(
    'missing staged launcher refuses publication and preserves installed bytes',
    () async {
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      File(p.join(attempts().single.path, 'Harness.exe.new')).deleteSync();
      expect(swap.commit(version: '1.3.0'), contains('staged or installed'));
      expect(swap.publicationStarted, isFalse);
      expect(exists('app/1.3.0'), isFalse);
      oldInstallIntact();
    },
  );

  test('launcher rename failure restores live launcher and reports partial publication', () async {
    final swap = WindowsUpdateSwap(
      installRoot: root,
      renameFile: (from, to) {
        if (to == p.join(root, 'Harness.exe') && from.contains('.new')) {
          throw const FileSystemException('locked launcher');
        }
        File(from).renameSync(to);
      },
    );
    expect(await stage(swap, updateZip('1.3.0')), isNull);
    expect(swap.commit(version: '1.3.0'), contains('locked launcher'));
    oldInstallIntact();
    expect(exists('app/1.3.0'), isTrue);
  });

  test('current pointer failure restores original previous bytes', () async {
    File(p.join(root, 'previous')).writeAsStringSync('1.0.0\r\n');
    final swap = WindowsUpdateSwap(
      installRoot: root,
      renameFile: (from, to) {
        if (to == p.join(root, 'current')) {
          throw const FileSystemException('locked current');
        }
        File(from).renameSync(to);
      },
    );
    expect(await stage(swap, updateZip('1.3.0')), isNull);
    expect(swap.commit(version: '1.3.0'), contains('locked current'));
    expect(read('current'), '1.2.0\r\n');
    expect(read('previous'), '1.0.0\r\n');
    expect(exists('app/1.3.0'), isTrue);
  });

  test(
    'cleanup uses its startup snapshot and preserves a newer staged attempt',
    () async {
      Directory(p.join(root, 'app', '1.0.0')).createSync();
      final cleanup = WindowsUpdateSwap(installRoot: root);
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      await cleanup.cleanUp();
      expect(exists('app/1.0.0'), isFalse);
      expect(attempts(), hasLength(1));
      oldInstallIntact();
    },
  );

  test('slow detached cleanup leaves the publication lock available', () async {
    Directory(p.join(root, 'app', '1.0.0')).createSync();
    File(p.join(root, 'app', '1.0.0', 'old')).writeAsStringSync('stale');
    Directory(p.join(root, 'app', '0.9.0')).createSync();
    File(p.join(root, 'previous')).writeAsStringSync('0.9.0\r\n');
    File(p.join(root, 'app', '0.9.0', '.started')).writeAsStringSync('history');
    final outside = Directory(p.join(dir.path, 'external'))..createSync();
    File(p.join(outside.path, 'sentinel')).writeAsStringSync('keep');
    final deleting = Completer<String>();
    final release = Completer<void>();
    final cleanup = WindowsUpdateSwap(
      installRoot: root,
      deleteClaimed: (path) async {
        if (!deleting.isCompleted) {
          deleting.complete(path);
          await release.future;
        }
        Directory(path).deleteSync(recursive: true);
      },
    );
    final pending = cleanup.cleanUp();
    final quarantine = await deleting.future.timeout(
      const Duration(seconds: 10),
    );
    expect(exists('app/1.0.0'), isFalse);
    expect(Directory(quarantine).existsSync(), isTrue);
    final swap = WindowsUpdateSwap(installRoot: root);
    expect(await stage(swap, updateZip('1.3.0')), isNull);
    expect(swap.commit(version: '1.3.0'), isNull);
    expect(read('current'), '1.3.0\r\n');
    expect(read('previous'), '1.2.0\r\n');
    expect(read('app/0.9.0/.started'), 'history');
    expect(attempts(), hasLength(1));
    release.complete();
    await pending.timeout(const Duration(seconds: 10));
    expect(File(p.join(outside.path, 'sentinel')).readAsStringSync(), 'keep');
    expect(read('app/1.3.0/harness-desktop.exe'), 'app 1.3.0');
  });

  test('cleanup retains the only launcher backup', () async {
    File(p.join(root, 'Harness.exe.old')).writeAsStringSync('recovery');
    final cleanup = WindowsUpdateSwap(installRoot: root);
    File(p.join(root, 'Harness.exe')).deleteSync();
    await cleanup.cleanUp();
    expect(read('Harness.exe.old'), 'recovery');
    expect(read('current'), '1.2.0\r\n');
  });

  test(
    'cleanup with unreadable current leaves current and previous bytes alone',
    () {
      Directory(p.join(root, 'app', '1.0.0')).createSync();
      File(p.join(root, 'previous')).writeAsStringSync('1.0.0\r\n');
      final cleanup = WindowsUpdateSwap(installRoot: root);
      File(p.join(root, 'current')).deleteSync();
      cleanUpInstall(root);
      expect(exists('app/1.2.0'), isTrue);
      expect(exists('app/1.0.0'), isTrue);
      expect(read('previous'), '1.0.0\r\n');
      expect(cleanup, isNotNull);
    },
  );

  test(
    'cleanup preserves current and previous history and deletes links as links',
    () async {
      Directory(p.join(root, 'app', '1.0.0')).createSync();
      File(p.join(root, 'app', '1.0.0', 'harness-desktop.exe'))
          .writeAsStringSync('previous');
      File(p.join(root, 'app', '1.0.0', '.started'))
          .writeAsStringSync('history');
      File(p.join(root, 'app', '1.2.0', '.started'))
          .writeAsStringSync('current history');
      File(p.join(root, 'previous')).writeAsStringSync('1.0.0\r\n');
      final outside = Directory(p.join(dir.path, 'external'))..createSync();
      File(p.join(outside.path, 'sentinel')).writeAsStringSync('outside');
      Link(p.join(root, 'app', '0.9.0')).createSync(outside.path);
      final cleanup = WindowsUpdateSwap(installRoot: root);
      await cleanup.cleanUp();
      expect(read('app/1.0.0/.started'), 'history');
      expect(read('app/1.2.0/.started'), 'current history');
      expect(read('previous'), '1.0.0\r\n');
      expect(
        File(p.join(outside.path, 'sentinel')).readAsStringSync(),
        'outside',
      );
      expect(exists('app/0.9.0'), isFalse);
    },
    skip: Platform.isWindows
        ? 'Windows junction gate covers reparse points'
        : null,
  );

  test(
    'stage refuses a current version directory link',
    () async {
      final outside = Directory(p.join(dir.path, 'external'))..createSync();
      File(p.join(outside.path, 'harness-desktop.exe'))
          .writeAsStringSync('external app');
      Directory(p.join(root, 'app', '1.2.0'))
          .renameSync(p.join(root, 'app', 'saved'));
      Link(p.join(root, 'app', '1.2.0')).createSync(outside.path);
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), contains('not usable'));
      expect(attempts(), isEmpty);
      expect(
        File(p.join(outside.path, 'harness-desktop.exe')).readAsStringSync(),
        'external app',
      );
    },
    skip: Platform.isWindows
        ? 'Windows junction gate covers reparse points'
        : null,
  );

  test('version folder checks include Windows device suffixes', () {
    for (final name in [
      '',
      '.',
      '..',
      'a/b',
      r'a\b',
      'C:x',
      '1.2.3.',
      'CON',
      'nul.txt',
      'COM¹.txt',
      'LPT²',
      'a*b',
    ]) {
      expect(validVersionFolder(name), isFalse, reason: name);
    }
    for (final name in ['1.2.3', '0.3.120-dev.abc123', 'COM10']) {
      expect(validVersionFolder(name), isTrue, reason: name);
    }
    expect(windowsPackageVersion('0.3.120-dev.abc123'), isTrue);
    expect(windowsPackageVersion('1.2.3+build'), isFalse);
    expect(windowsPackageVersion('1.2.3/other'), isFalse);
  });

  test('install root recognition excludes a development executable', () {
    expect(
      windowsInstallRootOf(p.join(root, 'app', '1.2.0', 'harness-desktop.exe')),
      root,
    );
    expect(
      windowsInstallRootOf(
        p.join(dir.path, 'build', 'Release', 'harness-desktop.exe'),
      ),
      isNull,
    );
  });

  test(
    'Windows native NTFS overwrite and locked launcher preserve pointer bytes',
    () async {
      writePointer(p.join(root, 'current'), '1.2.1');
      expect(read('current'), '1.2.1\r\n');
      writePointer(p.join(root, 'current'), '1.2.0');
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);
      final held = _ExclusiveWindowsFile(p.join(root, 'Harness.exe'));
      try {
        expect(swap.commit(version: '1.3.0'), isNotNull);
        expect(swap.publicationStarted, isTrue);
        expect(read('current'), '1.2.0\r\n');
        expect(exists('previous'), isFalse);
        expect(read('Harness.ico'), 'icon 1.2.0');
        expect(read('app/1.2.0/harness-desktop.exe'), 'app 1.2.0');
        expect(exists('app/1.3.0'), isTrue);
        expect(read('app/1.3.0/harness-desktop.exe'), 'app 1.3.0');
      } finally {
        held.close();
      }
      oldInstallIntact();
    },
    skip: !Platform.isWindows ? 'Windows NTFS only' : null,
  );

  test(
    'Windows native junction cleanup does not follow external bytes',
    () async {
      root = p.join(dir.path, 'junction-install');
      Directory(p.join(root, 'app', '1.2.0')).createSync(recursive: true);
      File(p.join(root, 'app', '1.2.0', 'harness-desktop.exe'))
          .writeAsStringSync('app 1.2.0');
      File(p.join(root, 'Harness.exe')).writeAsStringSync('launcher 1.2.0');
      File(p.join(root, 'Harness.ico')).writeAsStringSync('icon 1.2.0');
      File(p.join(root, 'current')).writeAsStringSync('1.2.0\r\n');
      final outside = Directory(p.join(dir.path, 'external'))..createSync();
      File(p.join(outside.path, 'sentinel')).writeAsStringSync('keep');
      final junction = p.join(root, 'app', '1.0.0');
      createJunction(junction, outside.path);
      final cleanup = WindowsUpdateSwap(installRoot: root);
      await cleanup.cleanUp();
      expect(File(p.join(outside.path, 'sentinel')).readAsStringSync(), 'keep');
      expect(exists('app/1.0.0'), isFalse);
      oldInstallIntact();
      File(p.join(outside.path, 'harness-desktop.exe'))
          .writeAsStringSync('external app');
      Directory(p.join(root, 'app', '1.2.0'))
          .renameSync(p.join(root, 'app', 'saved'));
      final currentJunction = p.join(root, 'app', '1.2.0');
      createJunction(currentJunction, outside.path);
      expect(
        await stage(WindowsUpdateSwap(installRoot: root), updateZip('1.3.0')),
        contains('not usable'),
      );
      expect(File(p.join(outside.path, 'sentinel')).readAsStringSync(), 'keep');
    },
    skip: !Platform.isWindows ? 'Windows junction only' : null,
  );

  test('Windows native post-stage app junction refuses publication', () async {
    final swap = WindowsUpdateSwap(installRoot: root);
    expect(await stage(swap, updateZip('1.3.0')), isNull);
    final outside = p.join(dir.path, 'external-app');
    Directory(p.join(root, 'app')).renameSync(outside);
    File(p.join(outside, 'sentinel')).writeAsStringSync('keep');
    createJunction(p.join(root, 'app'), outside);
    expect(swap.commit(version: '1.3.0'), contains('ordinary'));
    expect(swap.publicationStarted, isFalse);
    expect(File(p.join(outside, 'sentinel')).readAsStringSync(), 'keep');
    expect(
      File(p.join(outside, '1.2.0', 'harness-desktop.exe')).readAsStringSync(),
      'app 1.2.0',
    );
    expect(Directory(p.join(outside, '1.3.0')).existsSync(), isFalse);
    expect(read('current'), '1.2.0\r\n');
  }, skip: !Platform.isWindows ? 'Windows junction only' : null);

  test('Windows native post-stage root junction refuses publication', () async {
    final swap = WindowsUpdateSwap(installRoot: root);
    expect(await stage(swap, updateZip('1.3.0')), isNull);
    final outside = p.join(dir.path, 'external-root');
    Directory(root).renameSync(outside);
    File(p.join(outside, 'sentinel')).writeAsStringSync('keep');
    createJunction(root, outside);
    expect(swap.commit(version: '1.3.0'), contains('ordinary'));
    expect(swap.publicationStarted, isFalse);
    expect(File(p.join(outside, 'sentinel')).readAsStringSync(), 'keep');
    expect(
      File(p.join(outside, 'app', '1.2.0', 'harness-desktop.exe'))
          .readAsStringSync(),
      'app 1.2.0',
    );
    expect(Directory(p.join(outside, 'app', '1.3.0')).existsSync(), isFalse);
    expect(File(p.join(outside, 'current')).readAsStringSync(), '1.2.0\r\n');
  }, skip: !Platform.isWindows ? 'Windows junction only' : null);

  test('Windows native archive case alias is refused before writing', () async {
    final swap = WindowsUpdateSwap(installRoot: root);
    expect(
      await stage(
        swap,
        updateZip(
          '1.3.0',
          files: {'app/1.3.0/DATA/app.so': utf8.encode('alias')},
        ),
      ),
      contains('case-aliased'),
    );
    expect(attempts(), isEmpty);
    oldInstallIntact();
  }, skip: !Platform.isWindows ? 'Windows case handling only' : null);

  test(
    'Windows native cleanup keeps a current folder with pointer case drift',
    () async {
      Directory(p.join(root, 'app', '1.2.0'))
          .renameSync(p.join(root, 'app', '1.2.0-DEV'));
      File(p.join(root, 'current')).writeAsStringSync('1.2.0-dev\r\n');
      final cleanup = WindowsUpdateSwap(installRoot: root);
      await cleanup.cleanUp();
      expect(exists('app/1.2.0-DEV'), isTrue);
      expect(read('app/1.2.0-DEV/harness-desktop.exe'), 'app 1.2.0');
      expect(read('current'), '1.2.0-dev\r\n');
    },
    skip: !Platform.isWindows ? 'Windows case handling only' : null,
  );

  test('Windows native hardware architecture chooses the runner CPU', () {
    final expected = Platform.environment['HARNESS_EXPECTED_WINDOWS_ARCH'];
    expect(
      expected,
      anyOf('x64', 'arm64'),
      reason: 'Windows test runner must provide HARNESS_EXPECTED_WINDOWS_ARCH',
    );
    expect(windowsMachineArchitecture(), expected);
  }, skip: !Platform.isWindows ? 'Windows architecture only' : null);

  test(
    'Windows native Rust and Dart share the launch-state lock both ways',
    () async {
      final exe = Platform.environment['HARNESS_RUST_LOCK_TEST_EXE'];
      expect(
        exe,
        isNotNull,
        reason: 'Windows runner must export the exact Rust lib-test executable',
      );
      expect(
        File(exe!).existsSync(),
        isTrue,
        reason: 'Rust lib-test executable is missing: $exe',
      );
      const testName = 'desktop::launch::rollback_tests::lock_child';
      final args = ['--exact', testName, '--nocapture'];
      Map<String, String> env(String mode) => {
        ...Platform.environment,
        'HARNESS_LOCK_TEST_ROOT': root,
        'HARNESS_LOCK_TEST_MODE': mode,
      };
      final swap = WindowsUpdateSwap(installRoot: root);
      expect(await stage(swap, updateZip('1.3.0')), isNull);

      final child = await Process.start(exe, args, environment: env('hold'));
      try {
        final ready = File(p.join(root, 'ready'));
        for (var attempt = 0; attempt < 80 && !ready.existsSync(); attempt++) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        expect(
          ready.existsSync(),
          isTrue,
          reason: 'Rust lock holder did not become ready',
        );
        expect(swap.commit(version: '1.3.0'), contains('lock'));
        expect(swap.publicationStarted, isFalse);
        oldInstallIntact();
      } finally {
        try {
          child.stdin.add([1]);
          await child.stdin.close();
        } catch (_) {
          // A failed child may already have closed stdin; the exit still fails.
        }
        try {
          expect(await child.exitCode.timeout(const Duration(seconds: 10)), 0);
        } on TimeoutException {
          child.kill();
          rethrow;
        }
      }

      final dart = File(p.join(root, 'launch-state.lock'))
          .openSync(mode: FileMode.append);
      try {
        dart.lockSync(FileLock.exclusive);
        final probe = await Process.run(
          exe,
          args,
          environment: env('probe'),
        ).timeout(const Duration(seconds: 10));
        expect(probe.exitCode, 0, reason: '${probe.stdout}\n${probe.stderr}');
        expect(
          probe.stdout,
          contains('1 passed'),
          reason: 'Rust exact-filter probe must execute its one test',
        );
      } finally {
        dart.unlockSync();
        dart.closeSync();
      }
      expect(
        swap.commit(version: '1.3.0'),
        isNull,
        reason: 'publication succeeds after both lock holders release',
      );
      expect(read('current'), '1.3.0\r\n');
    },
    skip: !Platform.isWindows ? 'Windows Rust/Dart interop only' : null,
  );
}
