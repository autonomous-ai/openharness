// A pane's drop edges, the balanced layout, and the saved pane modes.
import 'dart:convert';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/state/pane_arrangement.dart';

void main() {
  group('paneSideAt', () {
    const size = Size(400, 200);

    test('the middle trades places', () {
      expect(paneSideAt(const Offset(200, 100), size), isNull);
    });

    test('each quarter nearest an edge means that edge', () {
      expect(paneSideAt(const Offset(10, 100), size), PaneSide.left);
      expect(paneSideAt(const Offset(390, 100), size), PaneSide.right);
      expect(paneSideAt(const Offset(200, 10), size), PaneSide.top);
      expect(paneSideAt(const Offset(200, 190), size), PaneSide.bottom);
    });

    test('in a corner, the nearer edge as a share of its band', () {
      expect(paneSideAt(const Offset(4, 40), size), PaneSide.left);
      expect(paneSideAt(const Offset(80, 4), size), PaneSide.top);
    });
  });

  group('moveBeside', () {
    const none = Size.zero;
    final columns = PaneArrangement(const [
      Rect.fromLTRB(0, 0, 1 / 3, 1),
      Rect.fromLTRB(1 / 3, 0, 2 / 3, 1),
      Rect.fromLTRB(2 / 3, 0, 1, 1),
    ]);

    test('the target gives up half, and the hole is filled', () {
      final after = columns.moveBeside(0, 2, PaneSide.top, minimum: none)!;
      expect(after.tiles, hasLength(3));
      // The first column's room went to its neighbour, and the third column
      // now holds two tiles, the moved one above.
      expect(after.tiles[0], const Rect.fromLTRB(0, 0, 2 / 3, 1));
      expect(after.tiles[1].top, 0);
      expect(after.tiles[1].bottom, .5);
      expect(after.tiles[2].top, .5);
      expect(after.tiles[1].left, after.tiles[2].left);
    });

    test('the tiles still cover the whole canvas', () {
      for (final side in PaneSide.values) {
        final after = columns.moveBeside(0, 1, side, minimum: none)!;
        final area = after.tiles.fold<double>(
          0,
          (sum, tile) => sum + tile.width * tile.height,
        );
        expect(area, closeTo(1, 1e-9), reason: side.name);
      }
    });

    test('a pane already on that side is recognised', () {
      expect(columns.isBeside(0, 1, PaneSide.left), isTrue);
      expect(columns.isBeside(1, 0, PaneSide.right), isTrue);
      expect(columns.isBeside(0, 2, PaneSide.left), isFalse);
      expect(columns.isBeside(0, 1, PaneSide.top), isFalse);
    });
  });

  test('balanced evens a run of columns, not just its first divider', () {
    final uneven = PaneArrangement(const [
      Rect.fromLTRB(0, 0, .7, 1),
      Rect.fromLTRB(.7, 0, .8, 1),
      Rect.fromLTRB(.8, 0, 1, 1),
    ]);
    final even = uneven.balanced(minimum: Size.zero);
    for (final tile in even.tiles) {
      expect(tile.width, closeTo(1 / 3, 1e-3));
    }
  });

  group('PanePrefs.read', () {
    test('nothing saved keeps the old shade switch someone set', () {
      expect(PanePrefs.read(null, legacyShade: true).fade, PaneFade.surface);
      expect(PanePrefs.read(null, legacyShade: false).fade, PaneFade.off);
      expect(PanePrefs.read(null, legacyShade: null), const PanePrefs());
    });

    test('what was saved comes back', () {
      const saved = PanePrefs(
        style: PaneStyle.compact,
        fade: PaneFade.content,
        highlightActive: false,
        autobalanceSplits: false,
        focusFollowsMouse: true,
      );
      expect(
        PanePrefs.read(jsonEncode(saved.toJson()), legacyShade: false),
        saved,
      );
    });

    test('a broken or unknown value lands on the default', () {
      expect(PanePrefs.read('{not json', legacyShade: null), const PanePrefs());
      expect(
        PanePrefs.read('{"style":"tiny","fade":"?"}', legacyShade: null),
        const PanePrefs(),
      );
    });
  });

  test('Surface and Content fade what they say', () {
    expect(PaneFade.off.fadesSurface || PaneFade.off.fadesContent, isFalse);
    expect(PaneFade.surface.fadesSurface, isTrue);
    expect(PaneFade.surface.fadesContent, isFalse);
    expect(PaneFade.content.fadesSurface, isFalse);
    expect(PaneFade.content.fadesContent, isTrue);
    expect(PaneFade.surfaceAndContent.fadesSurface, isTrue);
    expect(PaneFade.surfaceAndContent.fadesContent, isTrue);
  });
}
