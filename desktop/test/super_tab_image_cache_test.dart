// The chat's picture cache: kept by file id, under its cap with the least
// recently shown out first, its shapes remembered across launches, and
// emptied whole on sign-out.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/posix_file_mode.dart';
import 'package:harness/super_tabs/image_cache.dart';
import 'package:harness/super_tabs/image_shelf_native.dart';

/// A shelf whose writes wait until [release] completes.
class _SlowShelf extends MemoryImageShelf {
  final release = Completer<void>();
  final started = Completer<void>();
  @override
  Future<void> write(String name, Uint8List bytes) async {
    if (!started.isCompleted) started.complete();
    await release.future;
    await super.write(name, bytes);
  }
}

Uint8List _bytes(int length, [int fill = 1]) =>
    Uint8List(length)..fillRange(0, length, fill);

void main() {
  late MemoryImageShelf shelf;
  late SuperTabImageCache cache;

  setUp(() {
    shelf = MemoryImageShelf();
    cache = SuperTabImageCache(shelf, capBytes: 100);
  });

  Future<int> held() async =>
      (await shelf.list()).fold<int>(0, (sum, entry) => sum + entry.bytes);

  test('keeps a picture by its file id', () async {
    await cache.keep('a1', _bytes(10), const Size(800, 600));

    expect(await cache.read('a1'), _bytes(10));
    expect(cache.shapeOf('a1'), const Size(800, 600));
    expect(await cache.read('a2'), isNull);
    expect(cache.shapeOf('a2'), isNull);
  });

  test('keeps a thumbnail apart from its original', () async {
    await cache.keep('a1', _bytes(10, 1), const Size(4000, 3000));
    await cache.keep('a1.thumb', _bytes(5, 2), const Size(720, 540));

    expect(await cache.read('a1'), _bytes(10, 1));
    expect(await cache.read('a1.thumb'), _bytes(5, 2));
  });

  test('stays under its cap, least recently shown out first', () async {
    await cache.keep('a1', _bytes(40), const Size(1, 1));
    await cache.keep('a2', _bytes(40), const Size(1, 1));
    // Shown again: a2 is now the one least recently shown.
    expect(await cache.read('a1'), isNotNull);
    await cache.keep('a3', _bytes(40), const Size(1, 1));

    expect(await cache.read('a2'), isNull);
    expect(cache.shapeOf('a2'), isNull);
    expect(await cache.read('a1'), isNotNull);
    expect(await cache.read('a3'), isNotNull);
    expect(await held(), lessThanOrEqualTo(100));
  });

  test('a picture larger than the cap is not kept', () async {
    await cache.keep('a1', _bytes(40), const Size(1, 1));
    await cache.keep('big', _bytes(101), const Size(1, 1));

    expect(await cache.read('big'), isNull);
    expect(await cache.read('a1'), isNotNull);
  });

  test('clear empties it and forgets its shapes', () async {
    await cache.keep('a1', _bytes(10), const Size(800, 600));
    final before = cache.generation;

    await cache.clear();

    expect(await cache.read('a1'), isNull);
    expect(cache.shapeOf('a1'), isNull);
    expect(await shelf.list(), isEmpty);
    expect(cache.generation, isNot(before));
  });

  test('a picture whose load began before a clear is not kept', () async {
    final began = cache.generation;
    await cache.clear();

    await cache.keep('a1', _bytes(10), const Size(1, 1), generation: began);

    expect(await cache.read('a1'), isNull);
    expect(await shelf.list(), isEmpty);
  });

  test('a write under way at sign-out is not kept', () async {
    final slow = _SlowShelf();
    final cache = SuperTabImageCache(slow);
    final writing = cache.keep(
      'a1',
      _bytes(10),
      const Size(1, 1),
      generation: cache.generation,
    );
    await slow.started.future;

    final clearing = cache.clear();
    slow.release.complete();
    await Future.wait([writing, clearing]);

    expect(await slow.list(), isEmpty);
    expect(await cache.read('a1'), isNull);
    expect(cache.shapeOf('a1'), isNull);
  });

  group('whose pictures they are', () {
    Future<SuperTabImageCache> launched(String? owner) async {
      final next = SuperTabImageCache(shelf, capBytes: 100);
      await next.claim(owner);
      return next;
    }

    test('kept for the same computer sign-in', () async {
      await cache.claim('machine-a');
      await cache.keep('a1', _bytes(10), const Size(1, 1));

      final next = await launched('machine-a');
      expect(await next.read('a1'), isNotNull);
    });

    test('cleared at launch when the CLI is signed out', () async {
      await cache.claim('machine-a');
      await cache.keep('a1', _bytes(10), const Size(1, 1));

      final next = await launched(null);
      expect(await next.read('a1'), isNull);
      expect(await shelf.list(), isEmpty);
    });

    test('cleared at launch when the CLI names another machine', () async {
      await cache.claim('machine-a');
      await cache.keep('a1', _bytes(10), const Size(1, 1));

      final next = await launched('machine-b');
      expect(await next.read('a1'), isNull);
      // Now machine-b's: its pictures stay at its next launch.
      await next.keep('b1', _bytes(10), const Size(1, 1));
      expect(await (await launched('machine-b')).read('b1'), isNotNull);
    });

    test('pictures nobody claimed are cleared at launch', () async {
      await cache.keep('a1', _bytes(10), const Size(1, 1));

      final next = await launched('machine-a');
      expect(await next.read('a1'), isNull);
    });

    test(
      'a sign-in this session keeps its pictures for the next launch',
      () async {
        await cache.claim(null);
        await cache.keep('a1', _bytes(10), const Size(1, 1));
        await cache.owned('machine-a');

        final next = await launched('machine-a');
        expect(await next.read('a1'), isNotNull);
      },
    );

    test('a launch waits for its claim before reading', () async {
      await cache.claim('machine-a');
      await cache.keep('a1', _bytes(10), const Size(1, 1));

      final next = SuperTabImageCache(shelf, capBytes: 100);
      final claiming = next.claim(null);
      expect(await next.read('a1'), isNull);
      await claiming;
    });
  });

  test('reads the shapes kept by an earlier launch', () async {
    await cache.keep('a1', _bytes(10), const Size(1600, 900));

    final next = SuperTabImageCache(shelf, capBytes: 100);
    expect(next.shapeOf('a1'), isNull, reason: 'not listed yet');
    await next.ready;

    expect(next.shapeOf('a1'), const Size(1600, 900));
    expect(await next.read('a1'), _bytes(10));
  });

  test('a file id that is not a plain id is never kept', () async {
    for (final id in ['../x', 'a/b', '', 'a~1x1', 'a:thumb', 'a.b']) {
      await cache.keep(id, _bytes(1), const Size(1, 1));
    }

    expect(await shelf.list(), isEmpty);
  });

  group('on disk', () {
    late Directory home;

    setUp(() async {
      home = await Directory.systemTemp.createTemp('image-cache-test.');
    });
    tearDown(() => home.delete(recursive: true));

    test('keeps pictures between launches', () async {
      final folder = Directory('${home.path}/image-cache');
      final first = SuperTabImageCache(DirectoryImageShelf(folder));
      await first.keep('a1', _bytes(10), const Size(800, 600));

      final next = SuperTabImageCache(DirectoryImageShelf(folder));
      await next.ready;

      expect(next.shapeOf('a1'), const Size(800, 600));
      expect(await next.read('a1'), _bytes(10));
    });

    test('a write left half done is never read', () async {
      final folder = Directory('${home.path}/image-cache')..createSync();
      final part = File('${folder.path}/a1~2x2.4242.1.part')
        ..writeAsBytesSync([1, 2])
        ..setLastModifiedSync(
          DateTime.now().subtract(const Duration(hours: 1)),
        );

      final cache = SuperTabImageCache(DirectoryImageShelf(folder));
      await cache.ready;

      expect(cache.shapeOf('a1'), isNull);
      expect(await cache.read('a1'), isNull);
      expect(part.existsSync(), isFalse);
    });

    test('a write another window has under way is left alone', () async {
      final folder = Directory('${home.path}/image-cache')..createSync();
      final fresh = File('${folder.path}/a1~2x2.4242.1.part')
        ..writeAsBytesSync([1, 2]);

      await SuperTabImageCache(DirectoryImageShelf(folder)).ready;

      expect(fresh.existsSync(), isTrue);
    });

    test('with no home folder it keeps pictures in memory', () async {
      final shelf = defaultImageShelf(environment: const {});
      expect(shelf, isA<MemoryImageShelf>());
    });

    test('is kept to this user', () async {
      final folder = Directory('${home.path}/image-cache');
      await SuperTabImageCache(DirectoryImageShelf(folder))
          .keep('a1', _bytes(10), const Size(1, 1));
      if (!PosixFileMode.supported) return;

      expect(folder.statSync().mode & 0x1ff, 0x1c0);
      final file = folder.listSync().single;
      expect(file.statSync().mode & 0x1ff, 0x180);
    });

    test('clear empties the folder', () async {
      final folder = Directory('${home.path}/image-cache');
      final cache = SuperTabImageCache(DirectoryImageShelf(folder));
      await cache.keep('a1', _bytes(10), const Size(1, 1));

      await cache.clear();

      expect(
        folder.existsSync() ? folder.listSync() : const <FileSystemEntity>[],
        isEmpty,
      );
    });
  });
}
