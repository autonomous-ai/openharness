import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:path/path.dart' as p;

import 'pet_source.dart';

/// Rows of a petdex sheet, top to bottom. A loose sheet's row i lands on
/// `petRows[i]`.
const petRows = [
  'idle',
  'runningRight',
  'runningLeft',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
];

/// The dial states a sheet row can be chosen for, in the order the app lists
/// them.
const petStates = ['rest', 'working', 'listening', 'sending', 'asking'];

const cellWidth = 192, cellHeight = 208, sheetCols = 8, sheetRows = 9;
const sheetWidth = cellWidth * sheetCols, sheetHeight = cellHeight * sheetRows;

const _maxBytes = 8 * 1024 * 1024;
const _maxSide = 4096;
const _margin = 4;

const noFramesMessage =
    'Couldn’t find frames on this sheet — it needs a plain or checkered '
    'background with gaps between frames';

/// One frame of a loose sheet: its opaque box in the source image, right and
/// bottom exclusive.
class LooseFrame {
  const LooseFrame(this.left, this.top, this.right, this.bottom);
  final int left, top, right, bottom;
  int get width => right - left;
  int get height => bottom - top;
  @override
  String toString() => 'LooseFrame($left, $top, $right, $bottom)';
}

/// (width, height) from a PNG's IHDR or a JPEG's SOF marker, without
/// decoding; null when [b] is neither, or is cut short.
(int, int)? imageSize(Uint8List b) {
  int be(int at) => (b[at] << 8) | b[at + 1];
  const png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  var isPng = b.length >= 24;
  for (var i = 0; isPng && i < png.length; i++) {
    isPng = b[i] == png[i];
  }
  if (isPng) {
    if (String.fromCharCodes(b.sublist(12, 16)) != 'IHDR') return null;
    return ((be(16) << 16) | be(18), (be(20) << 16) | be(22));
  }
  if (b.length < 4 || b[0] != 0xFF || b[1] != 0xD8) return null;
  var i = 2;
  while (i + 3 < b.length) {
    if (b[i] != 0xFF) return null;
    final marker = b[i + 1];
    if (marker == 0xFF) {
      i++;
      continue;
    }
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
      i += 2;
      continue;
    }
    final length = be(i + 2);
    final sof =
        marker >= 0xC0 &&
        marker <= 0xCF &&
        marker != 0xC4 &&
        marker != 0xC8 &&
        marker != 0xCC;
    if (sof) {
      if (i + 9 > b.length) return null;
      return (be(i + 7), be(i + 5));
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/// Whether the image already carries a cut-out: a meaningful share of its
/// pixels (1 %) are mostly transparent.
bool hasRealAlpha(Uint8List rgba) {
  final pixels = rgba.length ~/ 4;
  var clear = 0;
  for (var i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 128) clear++;
  }
  return clear * 100 >= pixels;
}

/// Makes the background transparent in place: a flood fill from every border
/// pixel through background-ish pixels, so the character's outline stops it
/// and highlights inside survive. Background-ish is a light grey/white
/// (a checkerboard baked into the pixels) when most of the border is that,
/// otherwise close to the border's dominant colour. False when the border has
/// no clear background, so nothing was changed.
bool clearBackground(Uint8List rgba, int width, int height) {
  final border = <int>[
    for (var x = 0; x < width; x++) ...[x, (height - 1) * width + x],
    for (var y = 1; y < height - 1; y++) ...[y * width, y * width + width - 1],
  ];
  bool checker(int i) {
    final r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    final hi = math.max(r, math.max(g, b)), lo = math.min(r, math.min(g, b));
    return hi - lo <= 28 && lo >= 140;
  }

  bool Function(int) background;
  if (border.where(checker).length * 10 >= border.length * 6) {
    background = checker;
  } else {
    final buckets = <int, int>{};
    int bucket(int i) =>
        (rgba[i * 4] >> 3) << 10 |
        (rgba[i * 4 + 1] >> 3) << 5 |
        rgba[i * 4 + 2] >> 3;
    for (final i in border) {
      buckets.update(bucket(i), (n) => n + 1, ifAbsent: () => 1);
    }
    final top = buckets.entries.reduce((a, b) => a.value >= b.value ? a : b);
    if (top.value * 2 < border.length) return false;
    var r = 0, g = 0, b = 0;
    for (final i in border) {
      if (bucket(i) != top.key) continue;
      r += rgba[i * 4];
      g += rgba[i * 4 + 1];
      b += rgba[i * 4 + 2];
    }
    r ~/= top.value;
    g ~/= top.value;
    b ~/= top.value;
    background = (i) =>
        (rgba[i * 4] - r).abs() <= 24 &&
        (rgba[i * 4 + 1] - g).abs() <= 24 &&
        (rgba[i * 4 + 2] - b).abs() <= 24;
  }
  final seen = Uint8List(width * height);
  final queue = Int32List(width * height);
  var head = 0, tail = 0;
  void visit(int i) {
    if (seen[i] != 0) return;
    seen[i] = 1;
    if (!background(i)) return;
    queue[tail++] = i;
  }

  border.forEach(visit);
  while (head < tail) {
    final i = queue[head++];
    rgba[i * 4 + 3] = 0;
    final x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < (height - 1) * width) visit(i + width);
  }
  return true;
}

/// Runs of at least [minRun] indices whose count is over [over].
List<(int, int)> _runs(List<int> counts, int over, int minRun) {
  final runs = <(int, int)>[];
  int? start;
  for (var i = 0; i <= counts.length; i++) {
    final on = i < counts.length && counts[i] > over;
    if (on) {
      start ??= i;
    } else if (start != null) {
      if (i - start >= minRun) runs.add((start, i));
      start = null;
    }
  }
  return runs;
}

/// The frames of a sheet whose background is already transparent, row by row:
/// row bands are runs of y with more than two opaque pixels (at least 20 px),
/// frames are runs of x with more than one opaque pixel inside a band (at
/// least 15 px), each trimmed to its opaque box. At most 9 rows of 8 frames.
List<List<LooseFrame>> findFrames(Uint8List rgba, int width, int height) {
  bool opaque(int x, int y) => rgba[(y * width + x) * 4 + 3] >= 128;
  final perRow = List<int>.filled(height, 0);
  for (var y = 0; y < height; y++) {
    var n = 0;
    for (var x = 0; x < width; x++) {
      if (opaque(x, y)) n++;
    }
    perRow[y] = n;
  }
  final rows = <List<LooseFrame>>[];
  for (final (y0, y1) in _runs(perRow, 2, 20)) {
    final perCol = List<int>.filled(width, 0);
    for (var y = y0; y < y1; y++) {
      for (var x = 0; x < width; x++) {
        if (opaque(x, y)) perCol[x]++;
      }
    }
    final frames = <LooseFrame>[];
    for (final (x0, x1) in _runs(perCol, 1, 15)) {
      var top = y1, bottom = y0, left = x1, right = x0;
      for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
          if (!opaque(x, y)) continue;
          top = math.min(top, y);
          bottom = math.max(bottom, y + 1);
          left = math.min(left, x);
          right = math.max(right, x + 1);
        }
      }
      if (bottom > top) frames.add(LooseFrame(left, top, right, bottom));
      if (frames.length == sheetCols) break;
    }
    if (frames.isNotEmpty) rows.add(frames);
    if (rows.length == sheetRows) break;
  }
  return rows;
}

/// The one scale for the whole sheet: fits its widest and its tallest frame
/// into a cell less a margin, so the character fills the cell and keeps one
/// size from row to row. An upscale of 2x or more is a whole number (pixel
/// art keeps hard pixels).
///
/// Each frame is measured on its own, not its row's band: a jump's height
/// above the ground is room the row needs, which [composeSheet] fits by
/// lowering the jump, not by shrinking the character.
double sheetScale(List<List<LooseFrame>> rows) {
  var maxW = 1, maxH = 1;
  for (final row in rows) {
    for (final f in row) {
      maxW = math.max(maxW, f.width);
      maxH = math.max(maxH, f.height);
    }
  }
  final fit = math.min(
    (cellWidth - 2 * _margin) / maxW,
    (cellHeight - 2 * _margin) / maxH,
  );
  return fit >= 2 ? fit.floorToDouble() : fit;
}

/// How much of each frame's lift above its row's baseline survives at scale
/// [s]: all of it when the row fits a cell less its margins, else the share
/// that keeps every lifted frame inside, so a jump still leaves the ground.
double liftShare(List<LooseFrame> row, double s) {
  const room = cellHeight - 2 * _margin;
  final rowBottom = row.map((f) => f.bottom).reduce(math.max);
  var share = 1.0;
  for (final f in row) {
    final lift = (rowBottom - f.bottom) * s;
    final height = f.height * s;
    if (lift > 0 && lift + height > room) {
      share = math.min(share, math.max(0, room - height) / lift);
    }
  }
  return share;
}

/// A 1536 x 1872 straight RGBA petdex sheet: loose row i in grid row i, frame
/// j in cell j, all scaled by [sheetScale], centred across the cell and
/// bottom-aligned on one baseline (a frame keeps its lift within its row,
/// lowered by [liftShare] when the row is taller than a cell).
Uint8List composeSheet(Uint8List rgba, int width, List<List<LooseFrame>> rows) {
  final out = Uint8List(sheetWidth * sheetHeight * 4);
  final s = sheetScale(rows);
  for (final (r, row) in rows.indexed) {
    final rowBottom = row.map((f) => f.bottom).reduce(math.max);
    final share = liftShare(row, s);
    for (final (c, f) in row.indexed) {
      final dw = math.min(cellWidth, math.max(1, (f.width * s).round()));
      final dh = math.min(cellHeight, math.max(1, (f.height * s).round()));
      final lift = ((rowBottom - f.bottom) * s * share).round();
      final ox = c * cellWidth + (cellWidth - dw) ~/ 2;
      final oy = math.max(
        r * cellHeight,
        (r + 1) * cellHeight - _margin - lift - dh,
      );
      for (var dy = 0; dy < dh && oy + dy < (r + 1) * cellHeight; dy++) {
        final sy0 = f.top + (dy * f.height) ~/ dh;
        final sy1 = math.max(sy0 + 1, f.top + ((dy + 1) * f.height) ~/ dh);
        for (var dx = 0; dx < dw; dx++) {
          final sx0 = f.left + (dx * f.width) ~/ dw;
          final sx1 = math.max(sx0 + 1, f.left + ((dx + 1) * f.width) ~/ dw);
          // A box filter over premultiplied colour (one pixel when upscaling).
          var a = 0, rr = 0, gg = 0, bb = 0, n = 0;
          for (var sy = sy0; sy < sy1; sy++) {
            for (var sx = sx0; sx < sx1; sx++) {
              final i = (sy * width + sx) * 4;
              final al = rgba[i + 3];
              a += al;
              rr += rgba[i] * al;
              gg += rgba[i + 1] * al;
              bb += rgba[i + 2] * al;
              n++;
            }
          }
          if (a == 0) continue;
          final o = ((oy + dy) * sheetWidth + ox + dx) * 4;
          out[o] = rr ~/ a;
          out[o + 1] = gg ~/ a;
          out[o + 2] = bb ~/ a;
          out[o + 3] = math.max(1, a ~/ n);
        }
      }
    }
  }
  return out;
}

/// How much a row's silhouette changes from frame to frame: each frame's
/// occupancy on a 16 x 16 grid over the row's box (centred, bottom-aligned),
/// the mean share of cells that differ between neighbours.
double motionScore(Uint8List rgba, int width, List<LooseFrame> row) {
  if (row.length < 2) return 0;
  const n = 16;
  final top = row.map((f) => f.top).reduce(math.min);
  final bottom = row.map((f) => f.bottom).reduce(math.max);
  final boxW = row.map((f) => f.width).reduce(math.max);
  final boxH = bottom - top;
  List<bool> grid(LooseFrame f) {
    final cells = List<bool>.filled(n * n, false);
    final left = f.left - (boxW - f.width) ~/ 2;
    for (var gy = 0; gy < n; gy++) {
      for (var gx = 0; gx < n; gx++) {
        final x = left + ((gx + 0.5) * boxW / n).floor();
        final y = top + ((gy + 0.5) * boxH / n).floor();
        if (x < f.left || x >= f.right || y < f.top || y >= f.bottom) continue;
        cells[gy * n + gx] = rgba[(y * width + x) * 4 + 3] >= 128;
      }
    }
    return cells;
  }

  final grids = row.map(grid).toList();
  var diff = 0.0;
  for (var i = 1; i < grids.length; i++) {
    var d = 0;
    for (var k = 0; k < n * n; k++) {
      if (grids[i][k] != grids[i - 1][k]) d++;
    }
    diff += d / (n * n);
  }
  return diff / (grids.length - 1);
}

/// A first guess at which row plays which state: the first row rests, listens
/// and sends, the last asks, and working is the row that moves the most
/// (other than the first when there are two rows or more, and the last when
/// there are three or more).
Map<String, String> guessRows(
  Uint8List rgba,
  int width,
  List<List<LooseFrame>> rows,
) {
  final n = rows.length;
  var working = 0;
  if (n >= 2) {
    final candidates = [for (var i = 1; i < (n >= 3 ? n - 1 : n); i++) i];
    var best = -1.0;
    for (final i in candidates) {
      final score = motionScore(rgba, width, rows[i]);
      if (score > best) {
        best = score;
        working = i;
      }
    }
  }
  return {
    'rest': petRows[0],
    'working': petRows[working],
    'listening': petRows[0],
    'sending': petRows[0],
    'asking': petRows[n - 1],
  };
}

/// What the background isolate hands back: the composed sheet and the guess.
typedef _Composed = ({
  Uint8List? sheet,
  Map<String, String> rows,
  String? error,
});

_Composed _process(Uint8List rgba, int width, int height) {
  if (!hasRealAlpha(rgba) && !clearBackground(rgba, width, height)) {
    return (sheet: null, rows: const {}, error: noFramesMessage);
  }
  final frames = findFrames(rgba, width, height);
  if (frames.isEmpty) {
    return (sheet: null, rows: const {}, error: noFramesMessage);
  }
  return (
    sheet: composeSheet(rgba, width, frames),
    rows: guessRows(rgba, width, frames),
    error: null,
  );
}

/// Turns any PNG or JPEG sprite sheet into a petdex sheet: decodes it (size
/// read from the header first), removes a plain or checkered background,
/// finds the frames and lays them on the 8 x 9 grid. The PNG goes to a temp
/// folder that cleanup removes.
Future<PetSource> looseSheetSource(String path, {required String name}) async {
  final file = File(path);
  if (!file.existsSync()) throw PetSourceError('That file can’t be read');
  if (file.lengthSync() > _maxBytes) {
    throw PetSourceError('The image is larger than 8 MB');
  }
  final bytes = await file.readAsBytes();
  final size = imageSize(bytes);
  if (size == null) throw PetSourceError('That isn’t a PNG or JPEG image');
  if (size.$1 > _maxSide || size.$2 > _maxSide || size.$1 < 1 || size.$2 < 1) {
    throw PetSourceError('The image is larger than 4096 × 4096');
  }
  final Uint8List rgba;
  final int width, height;
  try {
    final codec = await ui.instantiateImageCodec(bytes);
    try {
      final image = (await codec.getNextFrame()).image;
      try {
        width = image.width;
        height = image.height;
        if (width > _maxSide || height > _maxSide) {
          throw StateError('too large');
        }
        final data = await image.toByteData(
          format: ui.ImageByteFormat.rawStraightRgba,
        );
        if (data == null) throw StateError('no pixels');
        rgba = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      } finally {
        image.dispose();
      }
    } finally {
      codec.dispose();
    }
  } catch (_) {
    throw PetSourceError('The image can’t be decoded');
  }
  final composed = await Isolate.run(() => _process(rgba, width, height));
  if (composed.error case final error?) throw PetSourceError(error);
  final png = await encodePng(composed.sheet!, sheetWidth, sheetHeight);
  final temp = await Directory.systemTemp.createTemp('harness-pet-');
  final out = File(p.join(temp.path, 'sheet.png'));
  await out.writeAsBytes(png);
  return PetSource(
    pngPath: out.path,
    name: name,
    loose: true,
    defaultRows: composed.rows,
    cleanup: () async {
      if (temp.existsSync()) await temp.delete(recursive: true);
    },
  );
}

/// [rgba] (straight alpha) as a PNG.
Future<Uint8List> encodePng(Uint8List rgba, int width, int height) async {
  // A raw image descriptor takes premultiplied pixels.
  final premultiplied = Uint8List.fromList(rgba);
  for (var i = 0; i < premultiplied.length; i += 4) {
    final a = premultiplied[i + 3];
    if (a == 255) continue;
    for (var k = 0; k < 3; k++) {
      premultiplied[i + k] = (premultiplied[i + k] * a + 127) ~/ 255;
    }
  }
  final buffer = await ui.ImmutableBuffer.fromUint8List(premultiplied);
  final descriptor = ui.ImageDescriptor.raw(
    buffer,
    width: width,
    height: height,
    pixelFormat: ui.PixelFormat.rgba8888,
  );
  final codec = await descriptor.instantiateCodec();
  try {
    final image = (await codec.getNextFrame()).image;
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) throw PetSourceError('The sheet can’t be encoded');
      return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    } finally {
      image.dispose();
    }
  } finally {
    codec.dispose();
    descriptor.dispose();
    buffer.dispose();
  }
}
