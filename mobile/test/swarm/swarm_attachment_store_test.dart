import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';

import 'swarm_attachment_fakes.dart';

/// The phone's copies of Swarm's files: fetched as the chip opens them, kept
/// for one account only, and gone with it.
void main() {
  late Directory root;
  late FakeFileStorage storage;
  late SwarmAttachmentStore store;

  final picture = Uri.parse('https://cdn.example/swarm/a.png');
  final other = Uri.parse('https://cdn.example/swarm/b.png');

  setUp(() {
    root = Directory.systemTemp.createTempSync('swarm-attachments-');
    storage = FakeFileStorage();
    store = storeIn(root, storage);
  });
  tearDown(() {
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  test('fetches a file once, with no credential of the app', () async {
    await store.keepOnly('person-a');

    final first = await store.file(picture);
    final again = await store.file(picture);

    expect(await first.readAsBytes(), pixelPng);
    expect(again.path, first.path);
    expect(storage.asked, hasLength(1));
    expect(storage.asked.single.url, picture.toString());
    expect(storage.asked.single.headers ?? const {}, isEmpty);
  });

  test('two asking for one file at once make one fetch', () async {
    await store.keepOnly('person-a');
    storage.hold = Completer();

    final both = Future.wait([store.file(picture), store.file(picture)]);
    await Future<void>.delayed(Duration.zero);
    storage.hold!.complete();
    await both;

    expect(storage.asked, hasLength(1));
  });

  test('with nobody to keep files for, fetches nothing', () async {
    await store.keepOnly(null);

    await expectLater(store.file(picture), throwsStateError);
    expect(storage.asked, isEmpty);
  });

  test('keeps one account only: another account empties the first', () async {
    await store.keepOnly('person-a');
    await store.file(picture);
    expect(keptUnder(root), isNotEmpty);

    await store.keepOnly('person-b');
    await store.file(other);

    final kept = keptUnder(root);
    expect(kept, isNotEmpty);
    expect(
      kept.map((path) => path.split(Platform.pathSeparator).first).toSet(),
      hasLength(1),
      reason: "only person-b's folder",
    );
    expect(await store.file(other), isA<File>());
    expect(storage.asked, hasLength(2), reason: "b's file is still kept");
  });

  test('nobody signed in (sign-out, Swarm off) empties everything', () async {
    await store.keepOnly('person-a');
    await store.file(picture);

    await store.keepOnly(null);

    expect(keptUnder(root), isEmpty);
  });

  test('at start, what another account left behind is emptied', () async {
    final left = Directory('${root.path}/someone-else')..createSync();
    File('${left.path}/old.png').writeAsBytesSync(pixelPng);

    await store.keepOnly('person-a');

    expect(left.existsSync(), isFalse);
  });

  test('at start with nobody signed in, everything is emptied', () async {
    File('${root.path}/stray.png').writeAsBytesSync(pixelPng);

    await store.keepOnly(null);

    expect(keptUnder(root), isEmpty);
  });

  test(
    "clear empties the account's files, and fetches them again after",
    () async {
      await store.keepOnly('person-a');
      await store.file(picture);

      await store.clear();
      expect(keptUnder(root), isEmpty);

      await store.file(picture);
      expect(storage.asked, hasLength(2));
    },
  );

  test('signed out during a fetch: the fetch ends first, then nothing is '
      'left', () async {
    await store.keepOnly('person-a');
    storage.hold = Completer();
    final fetch = store.file(picture);
    await Future<void>.delayed(Duration.zero);

    final signedOut = store.keepOnly(null);
    storage.hold!.complete();
    await fetch;
    await signedOut;

    expect(keptUnder(root), isEmpty);
    await expectLater(store.file(picture), throwsStateError);
  });

  test(
    'cleared during a fetch: the fetch ends first, then nothing is left',
    () async {
      await store.keepOnly('person-a');
      storage.hold = Completer();
      final fetch = store.file(picture);
      await Future<void>.delayed(Duration.zero);

      final cleared = store.clear();
      storage.hold!.complete();
      await fetch;
      await cleared;

      expect(keptUnder(root), isEmpty);
    },
  );

  test('asked while being emptied, a file waits and lands after', () async {
    await store.keepOnly('person-a');
    await store.file(picture);

    final cleared = store.clear();
    final again = store.file(picture);
    await cleared;
    await again;

    expect(storage.asked, hasLength(2), reason: 'fetched again, after');
    expect(keptUnder(root), isNotEmpty);
  });

  group('a delete the phone refuses', () {
    void Function() deny() {
      final allow = denyDeletes(root);
      addTearDown(allow);
      return allow;
    }

    test('on sign-out says so, and empties on the next try', () async {
      await store.keepOnly('person-a');
      await store.file(picture);
      final allow = deny();

      await expectLater(
        store.keepOnly(null),
        throwsA(isA<FileSystemException>()),
      );
      expect(keptUnder(root), isNotEmpty);

      allow();
      await store.keepOnly(null);

      expect(keptUnder(root), isEmpty);
    });

    test('on another account says so, and empties the first on the next '
        'try', () async {
      await store.keepOnly('person-a');
      await store.file(picture);
      final allow = deny();

      await expectLater(
        store.keepOnly('person-b'),
        throwsA(isA<FileSystemException>()),
      );

      allow();
      await store.keepOnly('person-b');

      expect(keptUnder(root), isEmpty);
    });

    test('on clear says so, and the next keeping of the same account '
        'empties it', () async {
      await store.keepOnly('person-a');
      await store.file(picture);
      final allow = deny();

      await expectLater(store.clear(), throwsA(isA<FileSystemException>()));

      allow();
      await store.keepOnly('person-a');

      expect(keptUnder(root), isEmpty);
    });
  });

  test('a refused fetch keeps nothing and says so', () async {
    await store.keepOnly('person-a');
    storage.status = 404;

    await expectLater(store.file(picture), throwsA(anything));
  });

  group('a copy named for the share sheet', () {
    test('is the kept file under its own name, in the account folder, and '
        'goes once used', () async {
      await store.keepOnly('person-a');
      final kept = await store.file(picture);
      late String path;
      late List<int> bytes;

      await store.named(kept, 'plan.md', (copy) async {
        path = copy.path;
        bytes = await copy.readAsBytes();
      });

      expect(path.split(Platform.pathSeparator).last, 'plan.md');
      expect(path, startsWith(root.path));
      expect(bytes, pixelPng);
      expect(File(path).existsSync(), isFalse);
      expect(File(path).parent.existsSync(), isFalse);
      expect(kept.existsSync(), isTrue, reason: 'the kept file stays');
    });

    test('goes when the share fails too, and the failure stands', () async {
      await store.keepOnly('person-a');
      final kept = await store.file(picture);
      String? path;

      await expectLater(
        store.named(kept, 'plan.md', (copy) async {
          path = copy.path;
          throw StateError('No sheet');
        }),
        throwsStateError,
      );

      expect(path, isNotNull);
      expect(File(path!).existsSync(), isFalse);
    });

    test('two at once do not share a folder', () async {
      await store.keepOnly('person-a');
      final kept = await store.file(picture);
      final paths = <String>[];
      final first = Completer<void>();

      final one = store.named(kept, 'a.txt', (copy) async {
        paths.add(copy.path);
        await first.future;
      });
      await store.named(kept, 'a.txt', (copy) async {
        paths.add(copy.path);
        expect(File(paths.first).existsSync(), isTrue);
      });
      first.complete();
      await one;

      expect(paths.toSet(), hasLength(2));
    });

    test('is refused for a file another account kept, or nobody', () async {
      await store.keepOnly('person-a');
      final kept = await store.file(picture);
      await store.keepOnly('person-b');
      var used = false;

      await expectLater(
        store.named(kept, 'a.png', (_) async => used = true),
        throwsStateError,
      );
      await store.keepOnly(null);
      await expectLater(
        store.named(kept, 'a.png', (_) async => used = true),
        throwsStateError,
      );
      expect(used, isFalse);
    });

    test('started just before another account, is made before the emptying '
        'runs', () async {
      // The app's folder comes from the platform, a wait of its own: the
      // copy is held there, and the emptying must wait for it.
      final reached = Completer<void>(), release = Completer<void>();
      var holding = false;
      final store = storeIn(
        root,
        storage,
        reaching: () async {
          if (!holding) return;
          holding = false;
          reached.complete();
          await release.future;
        },
      );
      await store.keepOnly('person-a');
      final kept = await store.file(picture);
      holding = true;
      List<int>? bytes;
      late final Future<void> changing;

      final sharing = store.named(kept, 'a.png', (copy) async {
        bytes = copy.readAsBytesSync();
        await changing;
      });
      changing = store.keepOnly('person-b');
      await reached.future;
      final emptied = await Future.any([
        changing.then((_) => true),
        Future<bool>.delayed(const Duration(milliseconds: 300), () => false),
      ]);
      release.complete();
      await sharing;
      await changing;

      expect(emptied, isFalse, reason: 'the emptying waited for the copy');
      expect(bytes, pixelPng);
      expect(keptUnder(root), isEmpty);
    });

    test('goes with the account on sign-out', () async {
      await store.keepOnly('person-a');
      final kept = await store.file(picture);
      final shown = Completer<String>(), held = Completer<void>();
      final sharing = store.named(kept, 'a.png', (copy) async {
        shown.complete(copy.path);
        await held.future;
      });
      final path = await shown.future;

      await store.keepOnly(null);

      expect(File(path).existsSync(), isFalse);
      held.complete();
      await sharing;
      expect(keptUnder(root), isEmpty);
    });
  });

  group('a file name the phone writes', () {
    test('keeps an ordinary name as it is', () {
      expect(swarmFileName('Plan v2 (final).md'), 'Plan v2 (final).md');
      expect(swarmFileName('.env'), '.env');
      expect(swarmFileName('Tiếng Việt.txt'), 'Tiếng Việt.txt');
    });

    test('never holds a folder or a control character', () {
      expect(swarmFileName('../../etc/passwd'), '.._.._etc_passwd');
      expect(swarmFileName(r'a\b.txt'), 'a_b.txt');
      expect(swarmFileName('a\nb\u0000.txt'), 'a_b_.txt');
    });

    test('is never empty, nor a folder of its own', () {
      for (final name in ['', '   ', '.', '..']) {
        expect(swarmFileName(name), 'file', reason: '"$name"');
      }
    });

    test('is at most 255 bytes, its extension kept', () {
      final long = swarmFileName('${'é' * 300}.md');
      expect(utf8.encode(long).length, lessThanOrEqualTo(255));
      expect(long, endsWith('.md'));
      expect(long, startsWith('éé'));
    });
  });
}
