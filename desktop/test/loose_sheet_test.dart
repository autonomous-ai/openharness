import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/loose_sheet.dart';
import 'package:harness/devices/pet_source.dart';

/// A synthetic RGBA image to draw sprite sheets on.
class _Canvas {
  _Canvas(this.width, this.height) : rgba = Uint8List(width * height * 4);
  final int width, height;
  final Uint8List rgba;

  void set(int x, int y, List<int> c) {
    final i = (y * width + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = c.length > 3 ? c[3] : 255;
  }

  List<int> at(int x, int y) {
    final i = (y * width + x) * 4;
    return rgba.sublist(i, i + 4);
  }

  void fill(int x0, int y0, int x1, int y1, List<int> c) {
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        set(x, y, c);
      }
    }
  }

  /// The "transparent" checkerboard an editor bakes into an export.
  void checker() {
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final v = ((x ~/ 10) + (y ~/ 10)).isEven ? 180 : 252;
        set(x, y, [v, v, v]);
      }
    }
  }

  /// A character: a dark outline around a red body with a white highlight.
  void blob(int x, int y, int w, int h) {
    fill(x, y, x + w, y + h, [10, 10, 20]);
    fill(x + 2, y + 2, x + w - 2, y + h - 2, [200, 60, 60]);
    fill(x + 5, y + 5, x + 9, y + 9, [252, 252, 252]);
  }
}

int _alpha(Uint8List rgba, int width, int x, int y) =>
    rgba[(y * width + x) * 4 + 3];

/// The opaque box (alpha 128 or more) of cell [col] of row [row] of a
/// composed sheet, in cell coordinates, right and bottom exclusive.
({int left, int top, int right, int bottom, int width, int height}) _box(
  Uint8List sheet,
  int row,
  int col,
) {
  var left = cellWidth, top = cellHeight, right = 0, bottom = 0;
  for (var y = 0; y < cellHeight; y++) {
    for (var x = 0; x < cellWidth; x++) {
      final a = _alpha(
        sheet,
        sheetWidth,
        col * cellWidth + x,
        row * cellHeight + y,
      );
      if (a < 128) continue;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x + 1 > right) right = x + 1;
      if (y + 1 > bottom) bottom = y + 1;
    }
  }
  return (
    left: left,
    top: top,
    right: right,
    bottom: bottom,
    width: right - left,
    height: bottom - top,
  );
}

/// Two rows on a checkerboard: three frames, then two.
_Canvas _twoRows() {
  final c = _Canvas(200, 140)..checker();
  for (final x in [10, 60, 110]) {
    c.blob(x, 10, 30, 30);
  }
  c
    ..blob(10, 80, 30, 40)
    ..blob(70, 90, 30, 30);
  return c;
}

void main() {
  test('a baked checkerboard is cleared, the highlight inside survives', () {
    final c = _twoRows();
    expect(hasRealAlpha(c.rgba), isFalse);
    expect(clearBackground(c.rgba, c.width, c.height), isTrue);
    expect(_alpha(c.rgba, c.width, 0, 0), 0);
    expect(_alpha(c.rgba, c.width, 50, 60), 0);
    expect(_alpha(c.rgba, c.width, 12, 12), 255); // body
    expect(_alpha(c.rgba, c.width, 16, 16), 255); // white highlight
    final rows = findFrames(c.rgba, c.width, c.height);
    expect(rows.map((r) => r.length), [3, 2]);
    final f = rows[0][1];
    expect((f.left, f.top, f.right, f.bottom), (60, 10, 90, 40));
    expect((rows[1][0].top, rows[1][0].bottom), (80, 120));
  });

  test('a solid background is cleared by its border colour', () {
    final c = _Canvas(160, 80)..fill(0, 0, 160, 80, [40, 90, 200]);
    c
      ..blob(10, 20, 30, 40)
      ..blob(60, 20, 30, 40)
      ..blob(110, 25, 30, 35);
    expect(clearBackground(c.rgba, c.width, c.height), isTrue);
    expect(_alpha(c.rgba, c.width, 50, 5), 0);
    expect(_alpha(c.rgba, c.width, 15, 25), 255);
    expect(findFrames(c.rgba, c.width, c.height).single.length, 3);
  });

  test('a busy border with no background is refused', () {
    final c = _Canvas(100, 100);
    for (var y = 0; y < 100; y++) {
      for (var x = 0; x < 100; x++) {
        c.set(x, y, [(x * 37) % 256, (y * 91) % 256, (x * y) % 256]);
      }
    }
    expect(clearBackground(c.rgba, c.width, c.height), isFalse);
  });

  test('real transparency is kept as it is', () {
    final c = _Canvas(120, 60);
    c
      ..blob(10, 10, 30, 40)
      ..blob(70, 10, 30, 40);
    expect(hasRealAlpha(c.rgba), isTrue);
    expect(findFrames(c.rgba, c.width, c.height).single.length, 2);
  });

  test('a sheet with nothing on it has no frames', () {
    final c = _Canvas(100, 100)..checker();
    clearBackground(c.rgba, c.width, c.height);
    expect(findFrames(c.rgba, c.width, c.height), isEmpty);
  });

  test('at most 9 rows of 8 frames are kept', () {
    final c = _Canvas(10 * 40 + 10, 11 * 40 + 10);
    for (var r = 0; r < 11; r++) {
      for (var k = 0; k < 10; k++) {
        c.blob(10 + k * 40, 10 + r * 40, 25, 25);
      }
    }
    final rows = findFrames(c.rgba, c.width, c.height);
    expect(rows.length, 9);
    expect(rows.every((r) => r.length == 8), isTrue);
  });

  test('frames land in their cells, bottom-aligned, upscaled when tiny', () {
    final c = _twoRows();
    clearBackground(c.rgba, c.width, c.height);
    final rows = findFrames(c.rgba, c.width, c.height);
    // Widest 30, tallest row 40 (30 + a 10 px drop): 5x fits 192 x 208.
    expect(sheetScale(rows), 5);
    final sheet = composeSheet(c.rgba, c.width, rows);
    expect(sheet.length, sheetWidth * sheetHeight * 4);
    // Row 0, cell 0: 150 x 150 centred, on the baseline (4 px margin).
    expect(_alpha(sheet, sheetWidth, 96, 208 - 5), 255);
    expect(_alpha(sheet, sheetWidth, 96, 208 - 4), 0);
    expect(_alpha(sheet, sheetWidth, 96, 208 - 4 - 150), 255);
    expect(_alpha(sheet, sheetWidth, 96, 208 - 4 - 151), 0);
    expect(_alpha(sheet, sheetWidth, 21, 150), 255);
    expect(_alpha(sheet, sheetWidth, 20, 150), 0);
    // Cells 3+ of row 0 and 2+ of row 1 stay empty, as does row 2.
    expect(_alpha(sheet, sheetWidth, 3 * 192 + 96, 150), 0);
    expect(_alpha(sheet, sheetWidth, 2 * 192 + 96, 208 + 150), 0);
    expect(_alpha(sheet, sheetWidth, 96, 2 * 208 + 150), 0);
    // Row 1, cell 0 is the taller frame, its bottom on the baseline; cell 1
    // sits on that same baseline (its bottom is the row's bottom too).
    expect(_alpha(sheet, sheetWidth, 96, 2 * 208 - 5), 255);
    expect(_alpha(sheet, sheetWidth, 192 + 96, 2 * 208 - 5), 255);
  });

  test('a big sheet is scaled down to fit a cell', () {
    final rows = [
      [const LooseFrame(0, 0, 400, 300)],
    ];
    expect(sheetScale(rows), closeTo(184 / 400, 1e-9));
  });

  test('the tallest frame fills the cell less its margin, a jump too', () {
    // Row 0: three 60 x 150 frames on the ground. Row 1: two on the ground
    // and one 90 px up, so the row's band is 240 tall, more than a cell.
    final c = _Canvas(400, 500);
    for (final x in [10, 110, 210]) {
      c.blob(x, 10, 60, 150);
    }
    c
      ..blob(10, 340, 60, 150)
      ..blob(110, 250, 60, 150)
      ..blob(210, 340, 60, 150);
    final rows = findFrames(c.rgba, c.width, c.height);
    expect(rows.map((r) => r.length), [3, 3]);
    expect(sheetScale(rows), closeTo(200 / 150, 1e-9));
    final sheet = composeSheet(c.rgba, c.width, rows);
    for (var r = 0; r < 2; r++) {
      for (var col = 0; col < 3; col++) {
        final box = _box(sheet, r, col);
        expect(box.height, inInclusiveRange(199, 200), reason: 'r$r c$col');
        expect(box.top, greaterThanOrEqualTo(4));
        expect(box.bottom, lessThanOrEqualTo(208 - 4));
      }
    }
    // No room is left above a cell-tall frame: the jump lands on the ground.
    expect(_box(sheet, 1, 1).bottom, _box(sheet, 1, 0).bottom);
  });

  test('a jump keeps its lift while the row fits a cell', () {
    final c = _Canvas(300, 200);
    c
      ..blob(10, 60, 40, 100)
      ..blob(110, 20, 40, 100);
    final rows = findFrames(c.rgba, c.width, c.height);
    final s = sheetScale(rows);
    expect(s, 2, reason: 'a whole-number upscale: 200 / 100');
    // 2x makes the frames 200 tall: no room is left to lift one.
    expect(liftShare(rows.single, s), 0);
    final short = _Canvas(300, 200)
      ..blob(10, 60, 40, 60)
      ..blob(110, 55, 40, 60);
    final shortRows = findFrames(short.rgba, short.width, short.height);
    final k = sheetScale(shortRows);
    expect(k, 3);
    expect(liftShare(shortRows.single, k), 1, reason: '(60 + 5) x 3 fits');
    final sheet = composeSheet(short.rgba, short.width, shortRows);
    expect(
      _box(sheet, 0, 0).bottom - _box(sheet, 0, 1).bottom,
      15,
      reason: 'lifted 5 px x 3',
    );
  });

  test('the guess: first row rests, last asks, the busiest works', () {
    final c = _Canvas(300, 300);
    // Row 0 still, row 1 still, row 2 moving, row 3 last.
    for (var k = 0; k < 4; k++) {
      c.blob(10 + k * 70, 10, 40, 40);
      c.blob(10 + k * 70, 80, 40, 40);
      c.blob(
        10 + k * 70 + (k.isEven ? 0 : 10),
        150 + (k.isEven ? 0 : 15),
        k.isEven ? 40 : 25,
        40,
      );
      c.blob(10 + k * 70, 240, 40, 40);
    }
    final rows = findFrames(c.rgba, c.width, c.height);
    expect(rows.length, 4);
    expect(guessRows(c.rgba, c.width, rows), {
      'rest': 'idle',
      'working': 'runningLeft',
      'listening': 'idle',
      'sending': 'idle',
      'asking': 'waving',
      'relaxing': 'idle',
    });
  });

  test('reads PNG and JPEG sizes from the header', () {
    final png = Uint8List.fromList([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, //
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0x02, 0xE0, 0, 0, 0x04, 0x49,
    ]);
    expect(imageSize(png), (736, 1097));
    final jpeg = Uint8List.fromList([
      0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, //
      0xFF, 0xC0, 0, 17, 8, 0x04, 0x49, 0x02, 0xE0, 3,
    ]);
    expect(imageSize(jpeg), (736, 1097));
    expect(imageSize(Uint8List.fromList([1, 2, 3])), isNull);
  });

  late Directory work;
  setUp(() => work = Directory.systemTemp.createTempSync('loose-sheet-'));
  tearDown(() => work.deleteSync(recursive: true));

  Future<void> expectError(Future<Object?> future, Object matcher) =>
      expectLater(
        future,
        throwsA(
          isA<PetSourceError>().having((e) => e.message, 'message', matcher),
        ),
      );

  testWidgets('a checkered PNG becomes a petdex sheet with a guess', (
    tester,
  ) async {
    final c = _twoRows();
    final png = await tester.runAsync(
      () => encodePng(c.rgba, c.width, c.height),
    );
    final file = File('${work.path}/hero.png')..writeAsBytesSync(png!);
    final source = await tester.runAsync(() => resolvePetSource(file.path));
    expect(source!.loose, isTrue);
    expect(source.name, 'hero');
    expect(source.defaultRows!['rest'], 'idle');
    expect(source.defaultRows!['asking'], 'runningRight');
    final out = File(source.pngPath).readAsBytesSync();
    expect(imageSize(out), (1536, 1872));
    final pixels = await tester.runAsync(() async {
      final codec = await ui.instantiateImageCodec(out);
      final image = (await codec.getNextFrame()).image;
      final data = await image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      return data!.buffer.asUint8List();
    });
    expect(_alpha(pixels!, sheetWidth, 96, 208 - 5), 255);
    expect(_alpha(pixels, sheetWidth, 0, 0), 0);
    await tester.runAsync(source.cleanup);
    expect(File(source.pngPath).existsSync(), isFalse);
  });

  testWidgets('semi-transparent pixels survive the PNG round trip', (
    tester,
  ) async {
    final rgba = Uint8List.fromList([255, 0, 0, 128, 0, 0, 255, 255]);
    final png = await tester.runAsync(() => encodePng(rgba, 2, 1));
    final out = await tester.runAsync(() async {
      final codec = await ui.instantiateImageCodec(png!);
      final image = (await codec.getNextFrame()).image;
      final data = await image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      return data!.buffer.asUint8List();
    });
    expect(out![0], greaterThan(250));
    expect(out.sublist(1, 4), [0, 0, 128]);
    expect(out.sublist(4), [0, 0, 255, 255]);
  });

  testWidgets('a petdex-sized PNG is used as is', (tester) async {
    final rgba = Uint8List(768 * 936 * 4);
    final png = await tester.runAsync(() => encodePng(rgba, 768, 936));
    final file = File('${work.path}/pet.png')..writeAsBytesSync(png!);
    final source = await tester.runAsync(() => resolvePetSource(file.path));
    expect(source!.pngPath, file.path);
    expect(source.loose, isFalse);
  });

  testWidgets('a sheet with no frames says why', (tester) async {
    final c = _Canvas(100, 100)..checker();
    final png = await tester.runAsync(
      () => encodePng(c.rgba, c.width, c.height),
    );
    final file = File('${work.path}/empty.png')..writeAsBytesSync(png!);
    await tester.runAsync(
      () => expectError(resolvePetSource(file.path), noFramesMessage),
    );
  });

  testWidgets('an image over 4096 px is refused before decoding', (
    tester,
  ) async {
    final jpeg = Uint8List.fromList([
      0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, 0x13, 0x88, 0x13, 0x88, 3, //
    ]);
    final file = File('${work.path}/huge.jpg')..writeAsBytesSync(jpeg);
    await tester.runAsync(
      () => expectError(resolvePetSource(file.path), contains('4096')),
    );
  });

  testWidgets('a JPEG over 8 MB is refused', (tester) async {
    final file = File('${work.path}/fat.jpeg')
      ..writeAsBytesSync(Uint8List(8 * 1024 * 1024 + 1));
    await tester.runAsync(
      () => expectError(resolvePetSource(file.path), contains('8 MB')),
    );
  });

  const real = '/Users/duynguyen/Downloads/character sprite sheet.jpeg';
  testWidgets('the real JPEG sheet: 4 rows of 5 frames', (tester) async {
    final bytes = File(real).readAsBytesSync();
    final pixels = await tester.runAsync(() async {
      final codec = await ui.instantiateImageCodec(bytes);
      final image = (await codec.getNextFrame()).image;
      final data = await image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      return (data!.buffer.asUint8List(), image.width, image.height);
    });
    final (rgba, w, h) = pixels!;
    expect(clearBackground(rgba, w, h), isTrue);
    final rows = findFrames(rgba, w, h);
    expect(rows.map((r) => r.length), [5, 5, 5, 5]);
    final source = await tester.runAsync(() => resolvePetSource(real));
    expect(source!.loose, isTrue);
    expect(source.defaultRows, {
      'rest': 'idle',
      'working': isNot('idle'),
      'listening': 'idle',
      'sending': 'idle',
      'asking': 'waving',
      'relaxing': 'idle',
    });
    // The prototype's row bands.
    expect(
      [
        for (final r in rows)
          (
            r.map((f) => f.top).reduce((a, b) => a < b ? a : b),
            r.map((f) => f.bottom).reduce((a, b) => a > b ? a : b),
          ),
      ],
      [(40, 225), (291, 482), (553, 733), (774, 1066)],
    );
    expect(source.defaultRows!['working'], 'runningLeft');
    // Composed, the tallest frame fills its cell less the 4 px margins; the
    // shortest row is not much less.
    final sheet = composeSheet(rgba, w, rows);
    final heights = [
      for (var r = 0; r < 4; r++)
        for (var c = 0; c < 5; c++) _box(sheet, r, c).height,
    ];
    expect(heights.reduce((a, b) => a > b ? a : b), inInclusiveRange(198, 200));
    expect(heights.reduce((a, b) => a < b ? a : b), greaterThan(208 * .8));
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 5; c++) {
        final box = _box(sheet, r, c);
        expect(box.top, greaterThanOrEqualTo(4), reason: 'r$r c$c');
        expect(box.bottom, lessThanOrEqualTo(208 - 4), reason: 'r$r c$c');
      }
    }
    await tester.runAsync(source.cleanup);
  }, skip: !File(real).existsSync());
}
