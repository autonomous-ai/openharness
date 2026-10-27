import 'dart:async';
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

  test('a refused fetch keeps nothing and says so', () async {
    await store.keepOnly('person-a');
    storage.status = 404;

    await expectLater(store.file(picture), throwsA(anything));
  });
}
