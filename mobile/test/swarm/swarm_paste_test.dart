import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
import 'package:harness_mobile/swarm/swarm_paste.dart';

/// A picture pasted into a message box goes into its files by the photos'
/// own limits, and only into the box it was pasted in.
void main() {
  Uint8List bytes(int size) => Uint8List(size);

  Future<String?> paste(
    SwarmOutgoingFiles files,
    SwarmPastedImage image, {
    bool Function()? stillWanted,
  }) async {
    String? said = 'never said';
    await pasteSwarmImage(
      files,
      image,
      stillWanted: stillWanted ?? () => true,
      note: (note) => said = note,
    );
    return said;
  }

  test('a box closed while the clipboard was read takes nothing and says '
      'nothing', () async {
    final files = SwarmOutgoingFiles();
    final answer = Completer<Uint8List?>();
    var wanted = true;
    final done = paste(
      files,
      SwarmPastedImage('pasted-image.png', () => answer.future),
      stillWanted: () => wanted,
    );
    wanted = false;
    answer.complete(bytes(10));

    expect(await done, 'never said');
    expect(files.files, isEmpty);
  });

  test('a box with ten files says so and never reads the clipboard', () async {
    final files = SwarmOutgoingFiles()
      ..add([for (var i = 0; i < 10; i++) SwarmOutgoingFile('f$i', bytes(1))]);
    var reads = 0;

    final said = await paste(
      files,
      SwarmPastedImage('pasted-image.png', () async {
        reads++;
        return bytes(10);
      }),
    );

    expect(said, 'Attach at most 10 files.');
    expect(reads, 0);
    expect(files.files, hasLength(10));
  });

  test('a box filled while the clipboard was read keeps its ten', () async {
    final files = SwarmOutgoingFiles();
    final answer = Completer<Uint8List?>();
    final done = paste(
      files,
      SwarmPastedImage('pasted-image.png', () => answer.future),
    );
    files.add([
      for (var i = 0; i < 10; i++) SwarmOutgoingFile('f$i', bytes(1)),
    ]);
    answer.complete(bytes(10));

    expect(await done, 'Attach at most 10 files.');
    expect(files.files.map((f) => f.name), isNot(contains('pasted-image.png')));
  });

  test(
    'a picture at exactly 256 MB is attached; one byte more is not',
    () async {
      final files = SwarmOutgoingFiles();
      expect(
        await paste(
          files,
          SwarmPastedImage(
            'pasted-image.png',
            () async => bytes(swarmAttachmentMaxBytes),
          ),
        ),
        isNull,
      );
      expect(
        await paste(
          files,
          SwarmPastedImage(
            'pasted-image.png',
            () async => bytes(swarmAttachmentMaxBytes + 1),
          ),
        ),
        'pasted-image-2.png is over 256 MB.',
      );
      expect(files.files.map((f) => f.name), ['pasted-image.png']);
    },
  );

  test('a read that fails says the picture cannot be read', () async {
    final files = SwarmOutgoingFiles();
    final said = await paste(
      files,
      SwarmPastedImage(
        'pasted-image.png',
        () async => throw PlatformException(code: 'gone'),
      ),
    );
    expect(said, "That picture isn't one this phone can read.");
    expect(files.files, isEmpty);
  });

  test('nothing on the clipboard by the time it is read says so', () async {
    final files = SwarmOutgoingFiles();
    final said = await paste(
      files,
      SwarmPastedImage('pasted-image.png', () async => null),
    );
    expect(said, 'There is no picture on the clipboard.');
  });

  test('a keyboard\'s picture keeps its kind in its name; one without bytes '
      'cannot be read', () async {
    KeyboardInsertedContent inserted(String mime, [Uint8List? data]) =>
        KeyboardInsertedContent(
          mimeType: mime,
          uri: 'content://k/1',
          data: data,
        );
    expect(
      SwarmPastedImage.inserted(inserted('image/gif')).name,
      'pasted-image.gif',
    );
    expect(
      SwarmPastedImage.inserted(inserted('image/jpeg')).name,
      'pasted-image.jpg',
    );
    expect(
      SwarmPastedImage.inserted(inserted('image/webp')).name,
      'pasted-image.webp',
    );
    expect(
      SwarmPastedImage.inserted(inserted('image/png')).name,
      'pasted-image.png',
    );

    final files = SwarmOutgoingFiles();
    expect(
      await paste(files, SwarmPastedImage.inserted(inserted('image/png'))),
      "That picture isn't one this phone can read.",
    );
    expect(files.files, isEmpty);
  });
}
