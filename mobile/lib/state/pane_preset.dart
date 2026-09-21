import 'dart:ui' show Rect;

/// The named shapes a grid of tiles can take.
///
/// The picker offers concrete, distinct arrangements. Automatic and older
/// lattice presets still restore saved work, but are not duplicate cards in
/// the picker. New balanced grids fill every row and use all the canvas.
enum PanePreset {
  /// Two tiles: split whichever side is longer. A terminal's usable size is its
  /// column count first, so halving the short axis is what protects it.
  splitLong,

  /// Two tiles, side by side whatever the window's shape.
  columns,

  /// Two tiles, one above the other.
  rows,

  /// Three tiles: two over one, the bottom one spanning. The shipped shape.
  twoOverOne,

  /// Three tiles: one over two, the top one spanning.
  oneOverTwo,

  /// Three tiles: one tall on the left, two stacked on the right.
  mainLeft,

  /// As many columns as the window can carry at the 40-column floor. The
  /// measured answer, and the one a grid gets when nobody has chosen.
  auto,

  /// A stated column count, for any number of tiles. The rows fall out of it:
  /// seven tiles in three columns is three rows, the last one short.
  ///
  /// Narrow counts are allowed to be narrow — three terminals across a 1600px
  /// window with the rail open is close to the floor — because the floor itself
  /// already refuses anything narrower than a terminal can use, and clamps.
  cols2,
  cols3,
  cols4,
  cols5,

  /// Five tiles: one tall down the MIDDLE, two stacked either side of it.
  ///
  /// The only five-tile shape that is not a lattice, and the reason to have it:
  /// a lattice of five leaves the odd tile alone on a short row, while this
  /// gives the work in hand a full-height column and keeps four others in
  /// sight beside it.
  middleMain,

  /// Four tiles in a square.
  quad,

  /// Four tiles: one tall on the left, three stacked on the right.
  mainAndStack,

  /// Three tiles: two on the left and one full-height on the right.
  mainRight,

  /// Five tiles: two above three, with both rows filling the width.
  twoOverThree,

  /// Row counts follow the requested maximum columns; panes are distributed
  /// evenly between rows so there are no unused cells or sparse trailing rows.
  balanced2,
  balanced3,
  balanced4,
  balanced5,

  /// A full-height main pane beside a balanced grid of supporting panes.
  mainAndGrid,

  /// A full-width main pane above a balanced grid of supporting panes.
  mainOverGrid;

  /// What the picker prints.
  String get label => switch (this) {
    PanePreset.splitLong => 'Split',
    PanePreset.columns => 'Columns',
    PanePreset.rows => 'Rows',
    PanePreset.twoOverOne => 'Main bottom',
    PanePreset.oneOverTwo => 'Main top',
    PanePreset.mainLeft => 'Main left',
    PanePreset.quad => 'Grid',
    PanePreset.mainAndStack => 'Main left',
    PanePreset.auto => 'Auto',
    PanePreset.cols2 => '2 columns',
    PanePreset.cols3 => '3 columns',
    PanePreset.cols4 => '4 columns',
    PanePreset.cols5 => '5 columns',
    PanePreset.middleMain => 'Middle + sides',
    PanePreset.mainRight => 'Main right',
    PanePreset.twoOverThree => 'Two over three',
    PanePreset.balanced2 => '2 columns',
    PanePreset.balanced3 => '3 columns',
    PanePreset.balanced4 => '4 columns',
    PanePreset.balanced5 => '5 columns',
    PanePreset.mainAndGrid => 'Main left',
    PanePreset.mainOverGrid => 'Main top',
  };

  /// The column count this shape states, or null for [auto] and for the shapes
  /// that are not a lattice at all.
  int? get statedColumns => switch (this) {
    PanePreset.cols2 => 2,
    PanePreset.cols3 => 3,
    PanePreset.cols4 => 4,
    PanePreset.cols5 => 5,
    _ => null,
  };

  /// These shapes use their unit rectangles directly in both renderers.
  bool get usesTileGeometry => switch (this) {
    PanePreset.mainRight ||
    PanePreset.twoOverThree ||
    PanePreset.balanced2 ||
    PanePreset.balanced3 ||
    PanePreset.balanced4 ||
    PanePreset.balanced5 ||
    PanePreset.mainAndGrid ||
    PanePreset.mainOverGrid => true,
    _ => false,
  };

  /// The tiles this shape makes, as fractions of the grid.
  ///
  /// This is the shape's DESCRIPTION, and it lives here rather than in the
  /// picker that draws it so there is only one of it: the palette paints these
  /// rectangles and a test measures the real layout against them, so a diagram
  /// cannot drift into advertising a shape the grid does not build.
  ///
  /// Legacy automatic layouts accept their measured column count. They are
  /// not offered in the picker because they resolve to another shape there.
  List<Rect> tilesFor(int count, {int? columns}) => switch (this) {
    PanePreset.columns || PanePreset.splitLong => const [
      Rect.fromLTRB(0, 0, .5, 1),
      Rect.fromLTRB(.5, 0, 1, 1),
    ],
    PanePreset.rows => _lattice(count, 1),
    PanePreset.twoOverOne => const [
      Rect.fromLTRB(0, 0, .5, .5),
      Rect.fromLTRB(.5, 0, 1, .5),
      Rect.fromLTRB(0, .5, 1, 1),
    ],
    PanePreset.oneOverTwo => const [
      Rect.fromLTRB(0, 0, 1, .5),
      Rect.fromLTRB(0, .5, .5, 1),
      Rect.fromLTRB(.5, .5, 1, 1),
    ],
    PanePreset.mainLeft => const [
      Rect.fromLTRB(0, 0, .5, 1),
      Rect.fromLTRB(.5, 0, 1, .5),
      Rect.fromLTRB(.5, .5, 1, 1),
    ],
    PanePreset.mainRight => const [
      Rect.fromLTRB(0, 0, .5, .5),
      Rect.fromLTRB(.5, 0, 1, 1),
      Rect.fromLTRB(0, .5, .5, 1),
    ],
    PanePreset.quad => const [
      Rect.fromLTRB(0, 0, .5, .5),
      Rect.fromLTRB(.5, 0, 1, .5),
      Rect.fromLTRB(0, .5, .5, 1),
      Rect.fromLTRB(.5, .5, 1, 1),
    ],
    PanePreset.mainAndStack => const [
      Rect.fromLTRB(0, 0, .5, 1),
      Rect.fromLTRB(.5, 0, 1, 1 / 3),
      Rect.fromLTRB(.5, 1 / 3, 1, 2 / 3),
      Rect.fromLTRB(.5, 2 / 3, 1, 1),
    ],
    // Tile order reads across the top and then across the bottom: 1 and 4 on the
    // left, 2 down the middle, 3 and 5 on the right — which is the order a
    // person numbers them, not the order a column would fill.
    PanePreset.middleMain => const [
      Rect.fromLTRB(0, 0, 1 / 3, 1 / 2),
      Rect.fromLTRB(1 / 3, 0, 2 / 3, 1),
      Rect.fromLTRB(2 / 3, 0, 1, 1 / 2),
      Rect.fromLTRB(0, 1 / 2, 1 / 3, 1),
      Rect.fromLTRB(2 / 3, 1 / 2, 1, 1),
    ],
    PanePreset.twoOverThree => _balanced(count, 3, largerRowsLast: true),
    PanePreset.balanced2 => _balanced(count, 2),
    PanePreset.balanced3 => _balanced(count, 3),
    PanePreset.balanced4 => _balanced(count, 4),
    PanePreset.balanced5 => _balanced(count, 5),
    PanePreset.mainAndGrid => [
      const Rect.fromLTRB(0, 0, .5, 1),
      for (final tile in _balanced(count - 1, 2))
        Rect.fromLTRB(
          .5 + tile.left / 2,
          tile.top,
          .5 + tile.right / 2,
          tile.bottom,
        ),
    ],
    PanePreset.mainOverGrid => [
      const Rect.fromLTRB(0, 0, 1, .5),
      for (final tile in _balanced(
        count - 1,
        count == 4 ? 3 : ((count - 1) / 2).ceil().clamp(2, 5),
      ))
        Rect.fromLTRB(
          tile.left,
          .5 + tile.top / 2,
          tile.right,
          .5 + tile.bottom / 2,
        ),
    ],
    PanePreset.auto => _lattice(
      count,
      columns ?? _autoColumnsForDrawing(count),
    ),
    _ => _lattice(count, statedColumns!.clamp(1, count)),
  };

  static List<Rect> _balanced(
    int count,
    int columns, {
    bool largerRowsLast = false,
  }) {
    final rows = (count / columns.clamp(1, count)).ceil();
    final perRow = count ~/ rows;
    final extra = count % rows;
    int columnsIn(int row) =>
        perRow + ((largerRowsLast ? row >= rows - extra : row < extra) ? 1 : 0);
    return [
      for (var row = 0; row < rows; row++)
        for (var col = 0; col < columnsIn(row); col++)
          Rect.fromLTRB(
            col / columnsIn(row),
            row / rows,
            (col + 1) / columnsIn(row),
            (row + 1) / rows,
          ),
    ];
  }

  /// The lattice, laid out the way `_Lattice` lays it: row-major, the last row
  /// short when the count does not divide.
  ///
  /// Written twice would be the bug this whole file exists to prevent, so the
  /// widget's own arithmetic is mirrored here and a test measures one against
  /// the other.
  static List<Rect> _lattice(int count, int columns) {
    final cols = columns.clamp(1, count);
    final rows = (count / cols).ceil();
    return [
      for (var i = 0; i < count; i++)
        Rect.fromLTRB(
          (i % cols) / cols,
          (i ~/ cols) / rows,
          (i % cols + 1) / cols,
          (i ~/ cols + 1) / rows,
        ),
    ];
  }

  /// Only for the DIAGRAM: what a wide window typically carries. The grid's own
  /// answer is measured at build time and can differ — the point of the picture
  /// is to say "the app decides", and it says that best by showing a plausible
  /// grid rather than a special icon nobody can read.
  static int _autoColumnsForDrawing(int count) => count <= 6 ? 3 : 4;

  /// Stable across releases: this is what lands in the state file, so it must
  /// not be the enum's index — reordering the enum would silently repoint
  /// everyone's saved layout at a different shape.
  String get id => name;

  static PanePreset? byId(String? id) {
    for (final preset in PanePreset.values) {
      if (preset.id == id) return preset;
    }
    return _legacyIds[id];
  }

  /// At most six useful shapes. Balanced grids that resolve to the same
  /// rectangles at a particular count are offered only once.
  static List<PanePreset> forCount(int count) {
    if (count < 2) return const [];
    return _choices.putIfAbsent(count, () {
      final seen = <String>{};
      return List.unmodifiable([
        for (final preset in _candidates(count))
          if (seen.add(_shapeKey(preset.tilesFor(count)))) preset,
      ]);
    });
  }

  static final _choices = <int, List<PanePreset>>{};

  static List<PanePreset> _candidates(int count) => switch (count) {
    < 2 => const [],
    2 => const [PanePreset.columns, PanePreset.rows],
    3 => const [
      PanePreset.twoOverOne,
      PanePreset.oneOverTwo,
      PanePreset.mainLeft,
      PanePreset.mainRight,
      PanePreset.cols3,
      PanePreset.rows,
    ],
    4 => const [
      PanePreset.quad,
      PanePreset.mainAndStack,
      PanePreset.mainOverGrid,
      PanePreset.cols4,
      PanePreset.rows,
    ],
    5 => const [
      PanePreset.balanced3,
      PanePreset.twoOverThree,
      PanePreset.middleMain,
      PanePreset.mainAndGrid,
      PanePreset.mainOverGrid,
      PanePreset.cols5,
    ],
    _ => [
      PanePreset.balanced2,
      PanePreset.balanced3,
      PanePreset.balanced4,
      PanePreset.balanced5,
      if (count <= 9) ...[PanePreset.mainAndGrid, PanePreset.mainOverGrid],
    ],
  };

  /// Saved automatic/regular grids remain valid even though the picker now
  /// offers explicit, filled arrangements. Do not silently discard their IDs.
  bool supportsCount(int count) => switch (this) {
    PanePreset.splitLong || PanePreset.columns => count == 2,
    PanePreset.rows => count >= 2 && count <= 4,
    PanePreset.twoOverOne ||
    PanePreset.oneOverTwo ||
    PanePreset.mainLeft ||
    PanePreset.mainRight => count == 3,
    PanePreset.quad || PanePreset.mainAndStack => count == 4,
    PanePreset.middleMain || PanePreset.twoOverThree => count == 5,
    PanePreset.cols2 || PanePreset.auto => count >= 5,
    PanePreset.cols3 => count >= 3,
    PanePreset.cols4 => count >= 4,
    PanePreset.cols5 ||
    PanePreset.balanced2 ||
    PanePreset.balanced3 ||
    PanePreset.balanced4 ||
    PanePreset.balanced5 ||
    PanePreset.mainAndGrid => count >= 5,
    PanePreset.mainOverGrid => count >= 4,
  };

  /// Match the visible geometry rather than the old preset's name or tile
  /// order. This highlights Columns/Rows for saved automatic two-pane splits.
  static PanePreset? matchingChoice(int count, List<Rect> tiles) {
    final key = _shapeKey(tiles);
    for (final choice in forCount(count)) {
      if (_shapeKey(choice.tilesFor(count)) == key) return choice;
    }
    return null;
  }

  static String _shapeKey(List<Rect> tiles) {
    final parts = [
      for (final tile in tiles)
        [
          tile.left,
          tile.top,
          tile.right,
          tile.bottom,
        ].map((edge) => (edge * 1e8).round()).join(','),
    ]..sort();
    return parts.join(';');
  }

  /// What a grid of this size looks like when nobody has chosen.
  static PanePreset? defaultFor(int count) {
    return switch (count) {
      < 2 => null,
      2 => PanePreset.splitLong,
      3 => PanePreset.twoOverOne,
      4 => PanePreset.quad,
      _ => PanePreset.auto,
    };
  }

  /// Ids written by the build that named these two by hand, before the column
  /// count became a thing any grid size could state. Read only — nothing writes
  /// them any more — so a layout saved yesterday still opens the shape it was
  /// left in rather than silently falling back to the default.
  static const _legacyIds = {'threeColumns': cols3, 'fourColumns': cols4};
}
