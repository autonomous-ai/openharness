import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/remote_media_download.dart';

void main() {
  late Directory cache;
  setUp(() => cache = Directory.systemTemp.createTempSync('phone-media-test-'));
  tearDown(() => cache.deleteSync(recursive: true));
  final revision = 'a' * 64;
  final bytes = Uint8List.fromList(
    List.generate(remoteMediaChunkBytes * 5 + 7, (i) => i % 251),
  );
  Map<String, dynamic> chunk(
    int offset, {
    String name = 'result.png',
    int? total,
  }) {
    final length = total ?? bytes.length;
    return {
      'media': true,
      'offset': offset,
      'filename': name,
      'totalBytes': length,
      'revision': revision,
      'contentBase64': base64Encode(
        bytes.sublist(offset, min(offset + remoteMediaChunkBytes, length)),
      ),
    };
  }

  Future<String> download(
    ReadRemoteMediaChunk read, {
    MediaDownloadCancellation? cancel,
    void Function(RemoteMediaProgress)? progress,
  }) => RemoteMediaDownloader(directory: cache).download(
    readChunk: read,
    cancellation: cancel ?? MediaDownloadCancellation(),
    onProgress: progress ?? (_) {},
  );

  test('parallel chunk replies are assembled in file order', () async {
    final progress = <RemoteMediaProgress>[];
    final revisions = <String?>[];
    final path = await download(({required offset, revision}) async {
      revisions.add(revision);
      await Future<void>.delayed(
        Duration(milliseconds: offset == remoteMediaChunkBytes ? 5 : 0),
      );
      return chunk(offset);
    }, progress: progress.add);
    expect(await File(path).readAsBytes(), bytes);
    expect(revisions.first, isNull);
    expect(revisions.skip(1), everyElement(revision));
    expect(progress.last.fraction, 1);
    expect(
      progress.map((p) => p.receivedBytes).toList(),
      orderedEquals([131072, 262144, 393216, 524288, 655360, 655367]),
    );
    expect(
      File('${File(path).parent.path}/download.part').existsSync(),
      isFalse,
    );
  });

  for (final broken in ['filename', 'offset', 'total', 'base64', 'short']) {
    test('refuses $broken metadata without leaving partial files', () async {
      final raw = chunk(0, total: 3);
      switch (broken) {
        case 'filename':
          raw['filename'] = '../private.png';
        case 'offset':
          raw['offset'] = 1;
        case 'total':
          raw['totalBytes'] = remoteMediaMaxBytes + 1;
        case 'base64':
          raw['contentBase64'] = '!!!!';
        case 'short':
          raw['contentBase64'] = '';
      }
      await expectLater(
        download(({required offset, revision}) async => raw),
        throwsA(isA<RemoteMediaException>()),
      );
      expect(cache.listSync(), isEmpty);
    });
  }

  test('changed revision removes the partial preview', () async {
    await expectLater(
      download(({required offset, revision}) async {
        final raw = chunk(offset);
        if (offset > 0) raw['revision'] = 'b' * 64;
        return raw;
      }),
      throwsA(isA<RemoteMediaException>()),
    );
    expect(cache.listSync(), isEmpty);
  });

  test(
    'cancelled pending read finishes promptly and consumes late errors',
    () async {
      final cancel = MediaDownloadCancellation();
      final pending = Completer<Map<String, dynamic>>();
      final done = download(
        ({required offset, revision}) => pending.future,
        cancel: cancel,
      );
      final check = expectLater(done, throwsA(isA<RemoteMediaCancelled>()));
      cancel.cancel();
      cancel.cancel();
      await check;
      pending.completeError(StateError('late read failure'));
      await Future<void>.delayed(Duration.zero);
      expect(cache.listSync(), isEmpty);
    },
  );

  test('cancellation during a write cleans staging data', () async {
    final cancel = MediaDownloadCancellation();
    await expectLater(
      download(
        ({required offset, revision}) async => chunk(offset),
        cancel: cancel,
        progress: (_) => cancel.cancel(),
      ),
      throwsA(isA<RemoteMediaCancelled>()),
    );
    expect(cache.listSync(), isEmpty);
  });

  test('identical names from concurrent previews never overwrite', () async {
    final paths = await Future.wait([
      for (var i = 0; i < 2; i++)
        download(
          ({required offset, revision}) async => chunk(offset, total: 3),
        ),
    ]);
    expect(paths[0], isNot(paths[1]));
    expect(await File(paths[0]).readAsBytes(), bytes.sublist(0, 3));
  });

  test('cache symlink is refused without touching its target', () async {
    final target = Directory('${cache.path}/target')..createSync();
    final link = Link('${cache.path}/link')..createSync(target.path);
    await expectLater(
      RemoteMediaDownloader(directory: Directory(link.path)).download(
        readChunk: ({required offset, revision}) async =>
            chunk(offset, total: 3),
        cancellation: MediaDownloadCancellation(),
        onProgress: (_) {},
      ),
      throwsA(isA<RemoteMediaException>()),
    );
    expect(target.listSync(), isEmpty);
  });

  test(
    'unsafe filename characters are sanitized in a completed preview',
    () async {
      final path = await download(
        ({required offset, revision}) async =>
            chunk(offset, name: 'a:b?.png', total: 3),
      );
      expect(path, endsWith('/a_b_.png'));
      expect(const RemoteMediaProgress('x', 0, null).fraction, isNull);
    },
  );
}
