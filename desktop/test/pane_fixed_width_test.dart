import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/pane_fixed_width.dart';

void main() {
  const canvas = Size(1000, 600);
  const gap = 8.0;
  // 70/30: [0, 696] and [704, 1000].
  final pair = [
    const Rect.fromLTRB(0, 0, 696, 600),
    const Rect.fromLTRB(704, 0, 1000, 600),
  ];

  List<Rect>? pin(List<Rect> tiles, List<double?> widths, {double min = 200}) =>
      pinFixedColumn(tiles, widths, canvas, gap: gap, minOther: min);

  test('a left tile takes its width and the rest takes the room', () {
    final tiles = pin(pair, [265, null])!;
    expect(tiles[0], const Rect.fromLTRB(0, 0, 265, 600));
    expect(tiles[1], const Rect.fromLTRB(273, 0, 1000, 600));
  });

  test('a right tile pins to the right edge', () {
    final tiles = pin(pair, [null, 120])!;
    expect(tiles[1], const Rect.fromLTRB(880, 0, 1000, 600));
    expect(tiles[0], const Rect.fromLTRB(0, 0, 872, 600));
  });

  test('the others keep their proportions and stacking', () {
    final three = [
      const Rect.fromLTRB(0, 0, 496, 600),
      const Rect.fromLTRB(504, 0, 1000, 296),
      const Rect.fromLTRB(504, 304, 1000, 600),
    ];
    final tiles = pin(three, [100, null, null])!;
    expect(tiles[1], const Rect.fromLTRB(108, 0, 1000, 296));
    expect(tiles[2], const Rect.fromLTRB(108, 304, 1000, 600));
  });

  test('never squeezes the others below their minimum', () {
    final tiles = pin(pair, [990, null], min: 300)!;
    expect(tiles[0].width, 1000 - gap - 300);
  });

  test('a tile not spanning an edge, or no width asked, pins nothing', () {
    expect(pin(pair, [null, null]), isNull);
    final stacked = [
      const Rect.fromLTRB(0, 0, 1000, 296),
      const Rect.fromLTRB(0, 304, 1000, 600),
    ];
    expect(pin(stacked, [265, null]), isNull);
  });
}
