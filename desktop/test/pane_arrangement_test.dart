import 'dart:ui';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_preset.dart';

void main() {
  for (final axis in PaneResizeAxis.values) {
    test(
      'small ${axis.name} splits grow linearly through the pane capacity',
      () {
        const viewport = Size(1280, 768);
        const floor = Size(400, 240);
        var extent = viewport;
        var layout = PaneArrangement(PanePreset.middleMain.tilesFor(5));
        for (var count = 5; count < 64; count++) {
          final next = layout.split(
            count - 1,
            axis,
            minimum: Size(
              floor.width / extent.width,
              floor.height / extent.height,
            ),
          );
          expect(next, isNotNull);
          layout = next!;
          extent = Size(
            max(
              viewport.width,
              floor.width / layout.tiles.map((tile) => tile.width).reduce(min),
            ),
            max(
              viewport.height,
              floor.height /
                  layout.tiles.map((tile) => tile.height).reduce(min),
            ),
          );
          expect(PaneArrangement.fromJson(layout.toJson()), isNotNull);
          expect(
            layout.tiles.fold<double>(
              0,
              (area, tile) => area + tile.width * tile.height,
            ),
            closeTo(1, .000001),
          );
          // Repeatedly splitting the newest small tile must add usable space,
          // without magnifying the entire workspace on every split.
          expect(
            extent.width,
            lessThanOrEqualTo(viewport.width + floor.width * count),
          );
          expect(
            extent.height,
            lessThanOrEqualTo(viewport.height + floor.height * count),
          );
          expect(
            layout.tiles.last.width * extent.width,
            greaterThanOrEqualTo(floor.width - .001),
          );
          expect(
            layout.tiles.last.height * extent.height,
            greaterThanOrEqualTo(floor.height - .001),
          );
        }
        expect(layout.split(63, axis, minimum: Size.zero), isNull);
      },
    );
  }

  test('nested splits and local close repairs retain complete nonoverlapping coverage', () {
    final random = Random(17);
    for (var trial = 0; trial < 30; trial++) {
      var arrangement = PaneArrangement(const [Rect.fromLTRB(0, 0, 1, 1)]);
      for (var count = 1; count < 16; count++) {
        arrangement = arrangement.split(
          random.nextInt(count),
          PaneResizeAxis.values[random.nextInt(2)],
          minimum: Size.zero,
        )!;
      }
      while (arrangement.tiles.length > 1) {
        expect(PaneArrangement.fromJson(arrangement.toJson()), isNotNull);
        expect(
          arrangement.tiles.fold<double>(
            0,
            (sum, tile) => sum + tile.width * tile.height,
          ),
          closeTo(1, .000001),
        );
        final next = arrangement.remove(
          random.nextInt(arrangement.tiles.length),
        );
        // Interlocking cuts may have no complete edge that can fill the hole.
        // A null repair explicitly asks the caller to return to its preset.
        if (next == null) break;
        arrangement = next;
      }
      if (arrangement.tiles.length == 1) {
        expect(arrangement.tiles.single, const Rect.fromLTRB(0, 0, 1, 1));
      }
    }
  });

  test(
    'all preset dividers preserve coverage and avoid overlaps at either limit',
    () {
      for (var count = 2; count <= 16; count++) {
        for (final preset in PanePreset.forCount(count)) {
          final layout = PaneArrangement(preset.tilesFor(count));
          final area = layout.tiles.fold<double>(
            0,
            (sum, tile) => sum + tile.width * tile.height,
          );
          for (final divider in layout.dividers) {
            for (final position in [-2.0, 2.0]) {
              final moved = layout.resize(
                divider,
                position,
                minimum: const Size(.08, .08),
              );
              expect(
                PaneArrangement.fromJson(moved.toJson()),
                isNotNull,
                reason: '$count ${preset.name} ${divider.id}',
              );
              expect(
                moved.tiles.fold<double>(
                  0,
                  (sum, tile) => sum + tile.width * tile.height,
                ),
                closeTo(area, .000001),
              );
              for (var i = 0; i < count; i++) {
                expect(
                  moved.tiles[i].width,
                  greaterThanOrEqualTo(
                    layout.tiles[i].width.clamp(0, .08) - .000001,
                  ),
                );
                expect(
                  moved.tiles[i].height,
                  greaterThanOrEqualTo(
                    layout.tiles[i].height.clamp(0, .08) - .000001,
                  ),
                );
              }
            }
          }
        }
      }
    },
  );

  test('connected grid dividers stay aligned while separate side stacks resize independently', () {
    final quad = PaneArrangement(PanePreset.quad.tilesFor(4));
    expect(quad.dividers.length, 2);
    final vertical = quad.dividers.singleWhere(
      (d) => d.axis == PaneResizeAxis.x,
    );
    final resized = quad.resize(vertical, .6, minimum: const Size(.1, .1));
    expect(resized.tiles[0].right, .6);
    expect(resized.tiles[2].right, .6);
    final sides = PaneArrangement(PanePreset.middleMain.tilesFor(5));
    expect(sides.dividers.length, 4);
    final left = sides.dividers.singleWhere(
      (d) => d.axis == PaneResizeAxis.y && d.before.contains(0),
    );
    final changed = sides.resize(left, .65, minimum: const Size(.1, .1));
    expect(changed.tiles[0].bottom, .65);
    expect(changed.tiles[3].top, .65);
    for (final untouched in [1, 2, 4]) {
      expect(changed.tiles[untouched], sides.tiles[untouched]);
    }
  });

  test('saved sizes reject malformed, overlapping and non-finite geometry', () {
    for (final raw in [
      null,
      {},
      [],
      [
        [0, 0, 1, 1],
      ],
      [
        [0, 0, .8, 1],
        [.7, 0, 1, 1],
      ],
      [
        [0, 0, double.nan, 1],
        [.5, 0, 1, 1],
      ],
      [
        [0, 0, .5, 1],
        [.5, 0, double.infinity, 1],
      ],
      [
        [0, 0, 0, 1],
        [.5, 0, 1, 1],
      ],
    ]) {
      expect(PaneArrangement.fromJson(raw), isNull);
    }
    final valid = PaneArrangement(PanePreset.columns.tilesFor(2)).toJson();
    expect(
      PaneArrangement.readSaved({'2:columns:0:columns': valid, '3:bad': valid})
          .keys,
      ['2:columns:0:columns'],
    );
  });
}
