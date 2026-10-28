import 'dart:io';

import 'package:image_picker/image_picker.dart' show XFile;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';

/// What the phone Swarm chat's attach sheet picks: the photo library (several at once), the camera
/// and the system's file picker, read into the chat's [SwarmOutgoingFiles] by Desktop's limits,
/// with each picker's own copy of the file deleted once read.
void main() {
  late Directory folder;
  late SwarmOutgoingFiles files;
  final original = (
    photos: pickSwarmPhotos,
    camera: takeSwarmPhoto,
    documents: pickSwarmFiles,
  );

  setUp(() {
    folder = Directory.systemTemp.createTempSync('swarm-picker-test');
    files = SwarmOutgoingFiles();
  });
  tearDown(() {
    files.dispose();
    if (folder.existsSync()) folder.deleteSync(recursive: true);
    pickSwarmPhotos = original.photos;
    takeSwarmPhoto = original.camera;
    pickSwarmFiles = original.documents;
  });

  /// A picker's copy of a file, on disk as the pickers leave it.
  XFile copy(String name, int size) {
    final file = File('${folder.path}/$name')
      ..writeAsBytesSync(Uint8List(size)..fillRange(0, size, 7));
    return XFile(file.path, name: name);
  }

  /// A copy past the limit, made without writing ten megabytes.
  XFile bigCopy(String name) {
    final file = File('${folder.path}/$name')..createSync();
    file.openSync(mode: FileMode.write)
      ..setPositionSync(0)
      ..truncateSync(swarmAttachmentMaxBytes + 1)
      ..closeSync();
    return XFile(file.path, name: name);
  }

  List<String> names() => [for (final f in files.files) f.name];

  group('photo library', () {
    test('adds every photo picked, named photo.jpg, photo-2.jpg…', () async {
      pickSwarmPhotos = (limit) async => [
        copy('image_picker_A1B2.jpg', 3),
        copy('image_picker_C3D4.jpg', 4),
      ];

      final outcome = await addSwarmPicked(files, SwarmPickSource.library);

      expect(outcome, isA<SwarmPicked>());
      expect((outcome as SwarmPicked).note, isNull);
      expect(names(), ['photo.jpg', 'photo-2.jpg']);
      expect([for (final f in files.files) f.bytes.length], [3, 4]);
    });

    test('keeps a photo’s own kind in its name', () async {
      pickSwarmPhotos = (limit) async => [copy('scaled_1.png', 2)];

      await addSwarmPicked(files, SwarmPickSource.library);

      expect(names(), ['photo.png']);
    });

    test('numbers a photo beside one already attached', () async {
      files.add([SwarmOutgoingFile('photo.jpg', Uint8List(1))]);
      pickSwarmPhotos = (limit) async => [copy('x.jpg', 2)];

      await addSwarmPicked(files, SwarmPickSource.library);

      expect(names(), ['photo.jpg', 'photo-2.jpg']);
    });

    test('asks for no more photos than there is room for', () async {
      files.add([
        for (var i = 0; i < 7; i++) SwarmOutgoingFile('f$i.txt', Uint8List(1)),
      ]);
      int? asked;
      pickSwarmPhotos = (limit) async {
        asked = limit;
        return [];
      };

      await addSwarmPicked(files, SwarmPickSource.library);

      expect(asked, 3);
    });

    test('deletes the picker’s copies once they are read', () async {
      final picked = [copy('a.jpg', 3), copy('b.jpg', 3)];
      pickSwarmPhotos = (limit) async => picked;

      await addSwarmPicked(files, SwarmPickSource.library);

      expect(
        [for (final x in picked) File(x.path).existsSync()],
        [false, false],
      );
    });

    test('backing out of the picker adds nothing and says nothing', () async {
      pickSwarmPhotos = (limit) async => [];

      final outcome = await addSwarmPicked(files, SwarmPickSource.library);

      expect((outcome as SwarmPicked).note, isNull);
      expect(files.files, isEmpty);
    });

    test('refused access to photos asks for Settings', () async {
      pickSwarmPhotos = (limit) async =>
          throw PlatformException(code: 'photo_access_denied');

      final outcome = await addSwarmPicked(files, SwarmPickSource.library);

      expect(outcome, isA<SwarmPickDenied>());
      expect((outcome as SwarmPickDenied).source, SwarmPickSource.library);
    });

    test('a photo over 10 MB is named and left out', () async {
      final big = bigCopy('big.jpg');
      pickSwarmPhotos = (limit) async => [big, copy('ok.jpg', 2)];

      final outcome = await addSwarmPicked(files, SwarmPickSource.library);

      expect((outcome as SwarmPicked).note, 'photo.jpg is over 10 MB.');
      expect(names(), ['photo-2.jpg']);
      expect(File(big.path).existsSync(), isFalse);
    });
  });

  group('camera', () {
    test('adds the photo taken', () async {
      takeSwarmPhoto = () async => copy('image_picker_E5.jpg', 5);

      final outcome = await addSwarmPicked(files, SwarmPickSource.camera);

      expect((outcome as SwarmPicked).note, isNull);
      expect(names(), ['photo.jpg']);
    });

    test('refused camera access asks for Settings and adds nothing', () async {
      takeSwarmPhoto = () async =>
          throw PlatformException(code: 'camera_access_denied');

      final outcome = await addSwarmPicked(files, SwarmPickSource.camera);

      expect((outcome as SwarmPickDenied).source, SwarmPickSource.camera);
      expect(files.files, isEmpty);
    });

    test('a camera that cannot open says so', () async {
      takeSwarmPhoto = () async => throw PlatformException(code: 'no_camera');

      final outcome = await addSwarmPicked(files, SwarmPickSource.camera);

      expect(
        (outcome as SwarmPickFailed).message,
        'Could not open the camera.',
      );
    });

    test('cancelling the camera says nothing', () async {
      takeSwarmPhoto = () async => null;

      final outcome = await addSwarmPicked(files, SwarmPickSource.camera);

      expect((outcome as SwarmPicked).note, isNull);
      expect(files.files, isEmpty);
    });
  });

  group('files', () {
    test('adds the files picked under their own names', () async {
      final picked = [copy('crash.log', 12), copy('report.pdf', 20)];
      pickSwarmFiles = () async => picked;

      final outcome = await addSwarmPicked(files, SwarmPickSource.files);

      expect((outcome as SwarmPicked).note, isNull);
      expect(names(), ['crash.log', 'report.pdf']);
      expect(
        [for (final x in picked) File(x.path).existsSync()],
        [false, false],
      );
    });

    test('a file over 10 MB is refused before it is read', () async {
      final big = bigCopy('big.zip');
      pickSwarmFiles = () async => [big, copy('ok.txt', 2)];

      final outcome = await addSwarmPicked(files, SwarmPickSource.files);

      expect((outcome as SwarmPicked).note, 'big.zip is over 10 MB.');
      expect(names(), ['ok.txt']);
      expect(File(big.path).existsSync(), isFalse);
    });

    test('files past the tenth are left out and counted', () async {
      files.add([
        for (var i = 0; i < 9; i++) SwarmOutgoingFile('f$i.txt', Uint8List(1)),
      ]);
      pickSwarmFiles = () async => [copy('a.txt', 1), copy('b.txt', 1)];

      final outcome = await addSwarmPicked(files, SwarmPickSource.files);

      expect((outcome as SwarmPicked).note, 'Attach at most 10 files.');
      expect(files.files, hasLength(10));
    });

    test('a file that cannot be read is named', () async {
      pickSwarmFiles = () async => [
        XFile('${folder.path}/gone.txt', name: 'gone.txt'),
      ];

      final outcome = await addSwarmPicked(files, SwarmPickSource.files);

      expect((outcome as SwarmPicked).note, 'Could not read gone.txt.');
      expect(files.files, isEmpty);
    });

    test('a picker that cannot open says so', () async {
      pickSwarmFiles = () async => throw PlatformException(code: 'error');

      final outcome = await addSwarmPicked(files, SwarmPickSource.files);

      expect(
        (outcome as SwarmPickFailed).message,
        'Could not open the picker.',
      );
    });
  });

  test('with ten files attached no picker opens', () async {
    files.add([
      for (var i = 0; i < 10; i++) SwarmOutgoingFile('f$i.txt', Uint8List(1)),
    ]);
    var opened = false;
    pickSwarmFiles = () async {
      opened = true;
      return [];
    };

    final outcome = await addSwarmPicked(files, SwarmPickSource.files);

    expect((outcome as SwarmPickFailed).message, 'Attach at most 10 files.');
    expect(opened, isFalse);
  });
}
