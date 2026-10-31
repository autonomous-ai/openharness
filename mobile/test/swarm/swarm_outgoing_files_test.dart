import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_attach.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';

/// The files waiting to go with the next message in a phone Swarm chat: the
/// desktop's rules (`desktop/lib/state/harness_attachments.dart` with the
/// limits of `desktop/lib/super_tabs/attachment_upload.dart`).
void main() {
  SwarmOutgoingFile file(String name, int size) =>
      SwarmOutgoingFile(name, Uint8List(size));

  /// A file of [size] bytes on disk, never read here: no test holds hundreds
  /// of megabytes.
  SwarmOutgoingFile sized(String name, int size) =>
      SwarmOutgoingFile.onDisk(name, '/nowhere/$name', size);

  const mb = 1024 * 1024;

  test('takes files in the order picked', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);

    expect(files.add([file('a.jpg', 3), file('b.pdf', 5)]), isNull);

    expect([for (final f in files.files) f.name], ['a.jpg', 'b.pdf']);
  });

  test('a file just over 10 MB is taken', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);

    final said = files.add([file('big.jpg', 10 * mb + 1)]);

    expect(said, isNull);
    expect([for (final f in files.files) f.name], ['big.jpg']);
  });

  test('a file over 256 MB is left out and named', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);

    final said = files.add([
      sized('big.zip', 256 * mb + 1),
      sized('ok.zip', 256 * mb),
    ]);

    expect(said, 'big.zip is over 256 MB.');
    expect([for (final f in files.files) f.name], ['ok.zip']);
  });

  test('several files over 256 MB are counted', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);

    final said = files.add([
      sized('a.zip', 257 * mb),
      sized('b.zip', 300 * mb),
    ]);

    expect(said, '2 files are over 256 MB.');
    expect(files.files, isEmpty);
  });

  test('a photo numbered beside another still goes up from its file', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);
    files.add([file('photo.png', 1)]);

    files.addNumbered([sized('photo.png', 20 * mb)]);

    final numbered = files.files.last;
    expect(numbered.name, 'photo-2.png');
    expect(numbered.bytes, isNull);
    expect(numbered.path, '/nowhere/photo.png');
    expect(numbered.size, 20 * mb);
  });

  test('an eleventh file is refused', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);
    files.add([for (var i = 0; i < 10; i++) file('$i.jpg', 1)]);

    final said = files.add([file('extra.jpg', 1)]);

    expect(said, 'Attach at most 10 files.');
    expect(files.files, hasLength(10));
    expect(files.files.any((f) => f.name == 'extra.jpg'), isFalse);
  });

  test('a file of a name already there takes its place', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);
    files.add([file('a.jpg', 1), file('b.jpg', 1)]);

    files.add([file('a.jpg', 7)]);

    expect([for (final f in files.files) f.name], ['b.jpg', 'a.jpg']);
    expect(files.files.last.bytes, hasLength(7));
  });

  test('an empty file is skipped silently', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);

    expect(files.add([file('empty.txt', 0)]), isNull);

    expect(files.files, isEmpty);
  });

  test('room is what ten files leave', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);
    expect(files.room, 10);

    files.add([file('a.jpg', 1), file('b.jpg', 1), file('c.jpg', 1)]);

    expect(files.room, 7);
  });

  test('a camera photo never replaces another of the same name', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);
    files.add([file('photo.jpg', 1)]);

    files.addNumbered([file('photo.jpg', 2)]);
    files.addNumbered([file('photo.jpg', 3)]);

    expect([for (final f in files.files) f.name], [
      'photo.jpg',
      'photo-2.jpg',
      'photo-3.jpg',
    ]);
  });

  test('remove and clear tell their listeners', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);
    files.add([file('a.jpg', 1), file('b.jpg', 1)]);
    var told = 0;
    files.addListener(() => told++);

    files.remove(files.files.first);
    expect([for (final f in files.files) f.name], ['b.jpg']);
    files.clear();

    expect(files.files, isEmpty);
    expect(told, 2);
  });

  group('swarmMimeForName', () {
    test('names the kinds the desktop names', () {
      expect(swarmMimeForName('a.PNG'), 'image/png');
      expect(swarmMimeForName('a.jpg'), 'image/jpeg');
      expect(swarmMimeForName('a.jpeg'), 'image/jpeg');
      expect(swarmMimeForName('a.gif'), 'image/gif');
      expect(swarmMimeForName('a.webp'), 'image/webp');
      expect(swarmMimeForName('a.pdf'), 'application/pdf');
      expect(swarmMimeForName('a.json'), 'application/json');
      expect(swarmMimeForName('a.zip'), 'application/zip');
      expect(swarmMimeForName('a.txt'), 'text/plain');
      expect(swarmMimeForName('a.log'), 'text/plain');
      expect(swarmMimeForName('a.md'), 'text/markdown');
      expect(swarmMimeForName('a.csv'), 'text/csv');
    });

    test('anything else goes as bytes', () {
      expect(swarmMimeForName('a.heic'), 'application/octet-stream');
      expect(swarmMimeForName('Makefile'), 'application/octet-stream');
    });
  });

  test('files over both the count and the size say both', () {
    final files = SwarmOutgoingFiles();
    addTearDown(files.dispose);

    final said = files.add([
      for (var i = 0; i < 11; i++) file('f$i.txt', 1),
      sized('big.jpg', 256 * mb + 1),
    ]);

    expect(said, 'Attach at most 10 files. big.jpg is over 256 MB.');
    expect(files.files, hasLength(10));
  });

  group('the composer\'s chips', () {
    Future<void> pumpChips(WidgetTester tester, SwarmOutgoingFile file) async {
      final box = _Box()..files.add([file]);
      addTearDown(box.files.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: SwarmOutgoingChips(box: box)),
        ),
      );
    }

    testWidgets('a picture over 10 MB shows a file mark, never decoded', (
      tester,
    ) async {
      await pumpChips(
        tester,
        SwarmOutgoingFile.onDisk('photo.png', '/nowhere/photo.png', 11 * mb),
      );

      expect(find.byType(Image), findsNothing);
      expect(find.text('photo.png'), findsOneWidget);
    });

    testWidgets('a small picture shows its thumbnail', (tester) async {
      await pumpChips(tester, file('photo.png', 3));

      expect(find.byType(Image), findsOneWidget);
    });
  });
}

/// A composer that holds files and sends none.
class _Box implements SwarmFilesBox {
  @override
  final files = SwarmOutgoingFiles();

  @override
  bool isUploading(SwarmOutgoingFile file) => false;

  @override
  double? uploadProgress(SwarmOutgoingFile file) => null;
}
