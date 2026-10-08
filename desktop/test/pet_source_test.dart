import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/pet_source.dart';

/// A 768 x 936 RGBA PNG, solid colour.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAwAAAAOoCAYAAABmzpMNAAAS3klEQVR4nO3XMQHAIADAMJgk/AvA'
  'FXMBRxMFfTv3WmcAAAAJ3+sAAADgHgMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABA'
  'iAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABC'
  'DAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBi'
  'AAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBAD'
  'AAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgA'
  'AAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAA'
  'AECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAA'
  'AEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAA'
  'EGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACA'
  'EAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACE'
  'GAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDE'
  'AAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEG'
  'AAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEA'
  'AAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEA'
  'AIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAA'
  'AIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAA'
  'IMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAA'
  'IQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAI'
  'MQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECI'
  'AQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIM'
  'AAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIA'
  'AAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMA'
  'AAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAA'
  'AAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAA'
  'QIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAA'
  'QgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQ'
  'YgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQ'
  'AwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQY'
  'AAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQA'
  'AABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYA'
  'AABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAA'
  'ABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAA'
  'gBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAA'
  'hBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAg'
  'xAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAh'
  'BgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgx'
  'AAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgB'
  'AACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwA'
  'AACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAA'
  'ACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAA'
  'ACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAA'
  'CDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABA'
  'iAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABC'
  'DAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBi'
  'AAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBAD'
  'AAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgA'
  'AAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAA'
  'AECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAA'
  'AEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAA'
  'EGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACA'
  'EAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACE'
  'GAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDE'
  'AAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEG'
  'AAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEA'
  'AAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEA'
  'AIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAA'
  'AIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAA'
  'IMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAA'
  'IQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAI'
  'MQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECI'
  'AQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIM'
  'AAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIA'
  'AAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMA'
  'AAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAA'
  'AAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAA'
  'QIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAA'
  'QgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQ'
  'YgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQ'
  'AwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQY'
  'AAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQA'
  'AABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYA'
  'AABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAA'
  'ABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAA'
  'gBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAA'
  'hBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAg'
  'xAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAh'
  'BgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgx'
  'AAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAAACDEAAAAQIgB'
  'AACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAAACEGAAAAQgwA'
  'AACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAACDEAAAAQYgAA'
  'ACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABAiAEAAIAQAwAA'
  'ACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABCDAAAAIQYAAAA'
  'CDEAAAAQYgAAACDEAAAAQIgBAACAEAMAAAAhBgAAAEIMAAAAhBgAAAAIMQAAABBiAAAAIMQAAABA'
  'iAEAAIAQAwAAACEGAAAAQgwAAACEGAAAAAgxAAAAEGIAAAAgxAAAAECIAQAAgBADAAAAIQYAAABC'
  'DAAAAIQYAAAACDEAAAAQYgAAAGB0/McZCXshDR9LAAAAAElFTkSuQmCC',
);

/// The same size as a lossless WebP (72 bytes).
final _webp = base64Decode(
  'UklGRkAAAABXRUJQVlA4TDQAAAAv/8LpAAdQmSJXpv8BAEX6/58i+p/63//+97///e9///vf//73v//973//+9///ve//ycG',
);

/// A RIFF/WEBP header declaring a VP8X canvas of [w] x [h]; no pixel data.
Uint8List _vp8x(int w, int h) {
  final b = BytesBuilder();
  void le(int v, int n) {
    for (var i = 0; i < n; i++) {
      b.addByte((v >> (8 * i)) & 0xff);
    }
  }

  b
    ..add(ascii.encode('RIFF'))
    ..add([0, 0, 0, 0])
    ..add(ascii.encode('WEBPVP8X'));
  le(10, 4);
  le(0, 4); // flags + reserved
  le(w - 1, 3);
  le(h - 1, 3);
  return b.toBytes();
}

Future<void> _expectError(Future<Object?> run, [Object? message]) async {
  await expectLater(
    run,
    throwsA(
      isA<PetSourceError>().having(
        (e) => e.message,
        'message',
        message ?? isNotEmpty,
      ),
    ),
  );
}

void main() {
  late Directory work;
  // Resolved, as the resolver reports real paths (macOS /var is a link).
  setUp(
    () => work = Directory(
      Directory.systemTemp
          .createTempSync('pet-source-test-')
          .resolveSymbolicLinksSync(),
    ),
  );
  tearDown(() => work.deleteSync(recursive: true));

  Directory petDir(String name, {String sheet = 'sheet.png', Object? json}) {
    final dir = Directory('${work.path}/$name')..createSync();
    File('${dir.path}/$sheet')
      ..createSync(recursive: true)
      ..writeAsBytesSync(_png);
    File('${dir.path}/pet.json').writeAsStringSync(
      jsonEncode(
        json ??
            {'id': 'boba-id', 'displayName': 'Boba', 'spritesheetPath': sheet},
      ),
    );
    return dir;
  }

  Uint8List zipOf(Map<String, List<int>> files) {
    final archive = Archive();
    files.forEach(
      (name, data) => archive.add(ArchiveFile(name, data.length, data)),
    );
    return Uint8List.fromList(ZipEncoder().encode(archive));
  }

  test(
    'a folder with pet.json: the sheet it names and the display name',
    () async {
      final dir = petDir('folder', sheet: 'art/sheet.png')..createSync();
      final source = await resolvePetSource(dir.path);
      expect(source.pngPath, '${dir.path}/art/sheet.png');
      expect(source.name, 'Boba');
      await source.cleanup();
      expect(
        File(source.pngPath).existsSync(),
        isTrue,
        reason: 'user files stay',
      );
    },
  );

  test('falls back to the id when there is no displayName', () async {
    final dir = petDir(
      'folder',
      json: {'id': 'just-id', 'spritesheetPath': 'sheet.png'},
    );
    expect((await resolvePetSource(dir.path)).name, 'just-id');
  });

  test('a pet.json file resolves like its folder', () async {
    final dir = petDir('folder');
    final source = await resolvePetSource('${dir.path}/pet.json');
    expect(source.pngPath, '${dir.path}/sheet.png');
    expect(source.name, 'Boba');
  });

  test('without pet.json, exactly one spritesheet.(webp|png)', () async {
    final dir = Directory('${work.path}/bare')..createSync();
    await _expectError(resolvePetSource(dir.path));
    File('${dir.path}/spritesheet.png').writeAsBytesSync(_png);
    final source = await resolvePetSource(dir.path);
    expect(source.pngPath, '${dir.path}/spritesheet.png');
    expect(source.name, isNull);
    File('${dir.path}/spritesheet.webp').writeAsBytesSync(_webp);
    await _expectError(resolvePetSource(dir.path));
  });

  test('a sheet path that leaves the folder is refused', () async {
    File('${work.path}/x.png').writeAsBytesSync(_png);
    for (final bad in [
      '../x.png',
      '/etc/hosts',
      'a/../../x.png',
      r'..\x.png',
    ]) {
      final dir = petDir('evil', json: {'spritesheetPath': bad});
      await _expectError(resolvePetSource(dir.path));
      dir.deleteSync(recursive: true);
    }
  });

  test('a symlink pointing out of the folder is refused', () async {
    File('${work.path}/outside.png').writeAsBytesSync(_png);
    final dir = Directory('${work.path}/linked')..createSync();
    Link('${dir.path}/sheet.png').createSync('${work.path}/outside.png');
    File('${dir.path}/pet.json')
        .writeAsStringSync(jsonEncode({'spritesheetPath': 'sheet.png'}));
    await _expectError(resolvePetSource(dir.path));
  });

  test('a zip with a top-level folder is extracted, then cleaned up', () async {
    final zip = File('${work.path}/pet.zip')
      ..writeAsBytesSync(
        zipOf({
          'boba/pet.json': utf8.encode(
            jsonEncode({
              'displayName': 'Zipped',
              'spritesheetPath': 'sheet.png',
            }),
          ),
          'boba/sheet.png': _png,
          '__MACOSX/boba/._sheet.png': [1, 2, 3],
        }),
      );
    final source = await resolvePetSource(zip.path);
    expect(source.name, 'Zipped');
    expect(File(source.pngPath).readAsBytesSync(), _png);
    expect(source.pngPath.startsWith(work.path), isFalse, reason: 'temp dir');
    await source.cleanup();
    expect(File(source.pngPath).existsSync(), isFalse);
  });

  test('a zip with ../ or absolute entries is refused', () async {
    for (final name in ['../evil.png', 'a/../../evil.png', '/abs/evil.png']) {
      final zip = File('${work.path}/bad.zip')
        ..writeAsBytesSync(zipOf({name: _png, 'pet.json': utf8.encode('{}')}));
      await _expectError(resolvePetSource(zip.path));
    }
    expect(File('${work.path}/evil.png').existsSync(), isFalse);
  });

  test('a zip over the entry or size caps is refused', () async {
    final many = File('${work.path}/many.zip')
      ..writeAsBytesSync(
        zipOf({
          for (var i = 0; i < 65; i++) 'f$i.txt': [i],
        }),
      );
    await _expectError(resolvePetSource(many.path), contains('too many'));
    final big = File('${work.path}/big.zip')
      ..writeAsBytesSync(
        zipOf({
          'a.bin': Uint8List(20 * 1024 * 1024),
          'b.bin': Uint8List(20 * 1024 * 1024),
        }),
      );
    await _expectError(resolvePetSource(big.path), contains('too large'));
  });

  test('a PNG is used as is, with no name', () async {
    final file = File('${work.path}/boba.png')..writeAsBytesSync(_png);
    final source = await resolvePetSource(file.path);
    expect(source.pngPath, file.path);
    expect(source.name, isNull);
  });

  test('an unsupported file type is refused', () async {
    final file = File('${work.path}/boba.gif')..writeAsBytesSync(_png);
    await _expectError(resolvePetSource(file.path));
  });

  group('WebP header', () {
    test('reads VP8X, VP8L and VP8 dimensions', () {
      expect(webpSize(_vp8x(1536, 1872)), (1536, 1872));
      expect(webpSize(_webp), (768, 936)); // VP8L, from a real file
      final vp8 = BytesBuilder()
        ..add(ascii.encode('RIFF'))
        ..add([0, 0, 0, 0])
        ..add(ascii.encode('WEBPVP8 '))
        ..add([0, 0, 0, 0])
        ..add([0, 0, 0]) // frame tag
        ..add([0x9d, 0x01, 0x2a])
        ..add([0x00, 0x06, 0x50, 0x07]); // 1536, 1872 (little endian)
      expect(webpSize(vp8.toBytes()), (1536, 1872));
    });

    test('rejects a non-WebP', () {
      expect(webpSize(Uint8List.fromList([1, 2, 3])), isNull);
    });
  });

  test('a WebP declaring 12000 x 12000 is refused before decoding', () async {
    final file = File('${work.path}/huge.webp')
      ..writeAsBytesSync(_vp8x(12000, 12000));
    await _expectError(
      resolvePetSource(file.path),
      'The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)',
    );
  });

  test('a WebP over 8 MB is refused', () async {
    final file = File('${work.path}/fat.webp')
      ..writeAsBytesSync(Uint8List(8 * 1024 * 1024 + 1));
    await _expectError(resolvePetSource(file.path), contains('8 MB'));
  });

  testWidgets('a real WebP is decoded to a PNG in a temp dir', (tester) async {
    final file = File('${work.path}/boba.webp')..writeAsBytesSync(_webp);
    final source = await tester.runAsync(() => resolvePetSource(file.path));
    expect(source!.name, 'boba');
    final out = File(source.pngPath).readAsBytesSync();
    expect(out.sublist(0, 8), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    final data = ByteData.sublistView(out);
    expect((data.getUint32(16), data.getUint32(20)), (768, 936));
    await tester.runAsync(source.cleanup);
    expect(File(source.pngPath).existsSync(), isFalse);
  });
}
