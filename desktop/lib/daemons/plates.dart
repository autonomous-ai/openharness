/// Filled daemons (`daemons/README.md`, "Plates" and "Plate colour"): every
/// frame `daemons/tools/bake.mjs` baked, read from the generated copy of
/// `daemons/plates.json`, and the colour rule every client draws them with
/// (bake.mjs `plateColor`). Clients never run a model: they print the baked
/// text. `test/daemons/plates_test.dart` checks the colours against
/// `frames.json` `plateColors`, cell by cell.
library;

import 'dart:convert';
import 'dart:ui' show Color;

import 'plates.g.dart';
import 'roster.dart';

/// The two widths a plate is baked at (`rules.plate.cols`): `portrait`
/// wherever a portrait shows (28 columns, at most 12 rows), `reveal` for the
/// hatch reveal and anywhere with room (56 columns, at most 24 rows).
enum PlateSize { portrait, reveal }

/// One frame of a plate with its material rows (`plate.mjs`): each cell of
/// [mats] says what the cell of [rows] is. An egg's: `g` glow (the light
/// inside), `s` a star, `p` a peek (the eyes in the chip), `.` shell or
/// nothing. An individual's: `m` a marking, `a` its extra, `e` the odd eye,
/// `.` the body. Every row of both is as wide.
class PlateFrame {
  const PlateFrame(this.rows, this.mats);
  final List<String> rows, mats;

  /// `{ rows, mats }` as `plates.json` and `daemon_plate` carry a frame:
  /// each a string of rows joined by newlines. Null for anything else, or
  /// material rows that do not match their rows.
  static PlateFrame? fromJson(Object? raw) {
    if (raw is! Map || raw['rows'] is! String) return null;
    final rows = (raw['rows'] as String).split('\n');
    final mats = raw['mats'] is String
        ? (raw['mats'] as String).split('\n')
        : [for (final r in rows) '.' * r.length];
    if (mats.length != rows.length) return null;
    for (var i = 0; i < rows.length; i++) {
      if (mats[i].length != rows[i].length) return null;
    }
    return PlateFrame(rows, mats);
  }

  /// The material of the cell at row [r], column [c] (`.` outside).
  String mat(int r, int c) =>
      r < mats.length && c < mats[r].length ? mats[r][c] : '.';
}

/// `plates.json`: `{ source, frameMs, daemons: { id: { portrait|reveal: {
/// version: { mood: [frame, ...] } } } }, eggs: { kind: { portrait|reveal: {
/// stage: [{ rows, mats }, ...] } } } }`, a daemon's frame being rows joined
/// by a newline, every row and every frame of one daemon, size and version
/// the same size; every stage of one egg kind and size shares one crop.
class DaemonPlates {
  DaemonPlates._(Map raw)
    : frameMs = (raw['frameMs'] as num? ?? 170).toInt(),
      _daemons = raw['daemons'] as Map? ?? const {},
      _eggs = raw['eggs'] as Map? ?? const {};

  factory DaemonPlates.parse(String json) =>
      DaemonPlates._(jsonDecode(json) as Map);

  /// One frame of a loop shows this long (170 ms).
  final int frameMs;
  final Map _daemons;
  final Map _eggs;
  final _loops = <String, List<List<String>>>{};
  final _eggLoops = <String, List<PlateFrame>>{};

  /// Whether [kind] has baked egg plates.
  bool hasEgg(String kind) => _eggs[kind] is Map;

  /// An egg of [kind] at [size] and [stage] (`p0`..`p4`, `rock`, `burst`,
  /// `tumble`, `open`): its frames with their material rows. `p0` and `p4`
  /// loop 8 frames in the nest, `p1` to `p3` hold one, and the opening's
  /// stages play through. A kind not baked draws as the first egg; empty
  /// when there are none.
  List<PlateFrame> egg(String kind, PlateSize size, String stage) =>
      _eggLoops['$kind ${size.name} $stage'] ??= () {
        final sizes = (_eggs[kind] ?? _eggs['first']) as Map?;
        final stages = sizes?[size.name] as Map?;
        final frames = stages?[stage] as List? ?? const [];
        return [
          for (final f in frames) ?PlateFrame.fromJson(f),
        ];
      }();

  /// Whether [id] has baked plates.
  bool has(String id) => _daemons[id] is Map;

  /// [mood]'s loop for [id] at [size] and [version], each frame as rows (idle
  /// has 8 frames, every other mood 4). A version not baked draws as the
  /// first, like the roster's; a mood not baked loops idle. Empty for a
  /// daemon without plates. Rows are split once per loop and kept.
  List<List<String>> loop(
    String id,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) => _loops['$id ${size.name} $version ${mood.name}'] ??= () {
    final versions = (_daemons[id] as Map?)?[size.name] as Map?;
    if (versions == null || versions.isEmpty) return const <List<String>>[];
    final moods = (versions[version] ?? versions.values.first) as Map;
    final frames = (moods[mood.name] ?? moods['idle']) as List? ?? const [];
    return [for (final f in frames) (f as String).split('\n')];
  }();

  /// Frame [index] of [mood]'s loop (it wraps); frame 0 is the still one
  /// (Reduce Motion, a card). Empty for a daemon without plates.
  List<String> frame(
    String id,
    PlateSize size,
    String version,
    DaemonMood mood, [
    int index = 0,
  ]) {
    final frames = loop(id, size, version, mood);
    return frames.isEmpty ? const [] : frames[index % frames.length];
  }
}

/// Every plate, parsed once and only when a plate is first drawn: a
/// top-level final is initialised on first use.
final daemonPlates = DaemonPlates.parse(daemonPlatesJson);

/// The terminal background `frames.json` `plateColors` were computed on.
const plateReferenceBackground = Color(0xff0c0c0c);

const _white = Color(0xffffffff);

int _channel(Color c, int shift) => (c.toARGB32() >> shift) & 0xff;

/// `mix(a, b, t)` as bake.mjs mixes: per RGB channel, rounded.
Color plateMix(Color a, Color b, double t) {
  int mix(int shift) {
    final v = _channel(a, shift);
    return (v + (_channel(b, shift) - v) * t).round();
  }

  return Color.fromARGB(255, mix(16), mix(8), mix(0));
}

/// `#rrggbb`, as `frames.json` writes a colour.
String plateHex(Color c) =>
    '#${(c.toARGB32() & 0xffffff).toRadixString(16).padLeft(6, '0')}';

/// The gradient a plate is drawn in: its shiny one when [shiny] (every
/// shiny in drop init is gold). Null for a daemon drawn in line art.
DaemonGradient? plateGradient(DaemonDef d, {bool shiny = false}) =>
    shiny ? d.shinyGradient ?? d.gradient : d.gradient;

/// How a plate's cells are coloured: by the plate's height, the row, the
/// glyph and the cell's material (`.` where a plate has none). Null where
/// nothing is drawn.
abstract interface class PlateCellInk {
  Color? cell(int rows, int r, String ch, String mat);

  /// The soft glow a client may draw around the plate.
  Color get glow;
}

/// How one plate is coloured on one background (bake.mjs `plateColor`):
/// row r of R rows takes `mix(top, bottom, r / (R - 1))`; each glyph takes
/// its brightness from `rules.plate.ink`, and at most 1 mixes from
/// [background] toward the row's colour (`.` is faint, `#` is the colour
/// itself) while above 1 mixes on toward [burn] by the excess (`@` burns).
/// Spaces, and glyphs with no ink level, are not drawn.
class PlateInk implements PlateCellInk {
  PlateInk(
    this.roster,
    this.gradient, {
    this.background = plateReferenceBackground,
    this.burn = _white,
  });

  final DaemonRoster roster;
  final DaemonGradient gradient;

  /// What faint glyphs mix from: the colour the plate is drawn on.
  final Color background;

  /// What a glyph brighter than its row mixes toward: white on a dark
  /// background.
  final Color burn;
  final _cache = <(int, int, String), Color?>{};

  /// The colour of row [r] of a plate [rows] tall.
  Color row(int rows, int r) =>
      plateMix(gradient.top, gradient.bottom, rows > 1 ? r / (rows - 1) : 0);

  /// The colour of glyph [ch] on row [r] of a plate [rows] tall, or null
  /// where nothing is drawn.
  Color? glyph(int rows, int r, String ch) =>
      _cache.putIfAbsent((rows, r, ch), () {
        final level = roster.rules.plate?.ink[ch];
        if (level == null) return null;
        final colour = row(rows, r);
        return level > 1
            ? plateMix(colour, burn, level - 1)
            : plateMix(background, colour, level);
      });

  @override
  Color? cell(int rows, int r, String ch, String mat) => glyph(rows, r, ch);

  /// The soft glow a client may draw around a plate: its bottom colour.
  @override
  Color get glow => gradient.bottom;
}

/// The colour of one character of a plate, exactly as bake.mjs `plateColor`
/// computes it (on the reference background unless told otherwise). Null
/// for a space or a daemon drawn in line art.
Color? plateColor(
  DaemonRoster roster,
  DaemonDef d,
  int rows,
  int r,
  String ch, {
  Color background = plateReferenceBackground,
  bool shiny = false,
}) {
  final gradient = plateGradient(d, shiny: shiny);
  if (gradient == null) return null;
  return PlateInk(roster, gradient, background: background).glyph(rows, r, ch);
}

/// `bake.mjs` `mix` over `#rrggbb` strings.
Color _hexColor(String hex) =>
    Color(0xff000000 | int.parse(hex.substring(1), radix: 16));

/// A colour of `frames.json` as a [Color].
Color plateHexColor(String hex) => _hexColor(hex);

/// A glyph's brightness over [base] (bake.mjs `inked`): at most 1 mixes from
/// [background] toward the colour, above 1 on toward [burn] by the excess.
/// Null for a glyph with no ink (a space).
Color? _inked(
  DaemonRoster roster,
  Color base,
  String ch,
  Color background, {
  Color burn = _white,
}) {
  final level = roster.rules.plate?.ink[ch];
  if (level == null) return null;
  return level > 1
      ? plateMix(base, burn, level - 1)
      : plateMix(background, base, level);
}

/// How an egg plate is coloured (bake.mjs `eggColor`): the shell runs down
/// the kind's gradient a row at a time; a glow cell (`g`) is the light
/// inside, `rules.plate.light[light]` (`plain` while it is earned, the
/// rarity's once it opens); a peek cell (`p`) is `light.peek`; a star (`s`)
/// the kind's stars. [dim] (a secret's opening) takes the shell to 0.22 of
/// its colour and the stars to 0.3; the light stays.
class EggInk implements PlateCellInk {
  EggInk(
    this.roster,
    this.kind, {
    this.light = 'plain',
    this.dim = false,
    this.background = plateReferenceBackground,
    DaemonGradient? gradient,
    this.burn = _white,
  }) : gradient =
           gradient ??
           roster.rules.eggs[kind]?.gradient ??
           roster.rules.eggs['first']?.gradient ??
           const DaemonGradient(Color(0xffffffd7), Color(0xffd7d7af));

  final DaemonRoster roster;
  final String kind;

  /// `plain`, `common`, `rare`, `legendary` or `secret`.
  final String light;
  final bool dim;
  final Color background;
  final DaemonGradient gradient;
  final Color burn;
  final _cache = <(int, int, String, String), Color?>{};

  Color get lightColour =>
      roster.rules.plate?.light[light] ??
      roster.rules.plate?.light['plain'] ??
      const Color(0xffffffd7);

  /// The soft glow a client may draw: the bottom colour while it is earned,
  /// the light once it is opened.
  @override
  Color get glow => light == 'plain' ? gradient.bottom : lightColour;

  @override
  Color? cell(int rows, int r, String ch, String mat) => glyph(rows, r, ch, mat);

  Color? glyph(int rows, int r, String ch, String mat) =>
      _cache.putIfAbsent((rows, r, ch, mat), () {
        final plate = roster.rules.plate;
        final Color base;
        if (mat == 'g') {
          base = lightColour;
        } else if (mat == 'p') {
          base = plate?.light['peek'] ?? _white;
        } else if (mat == 's') {
          final stars = roster.rules.eggs[kind]?.stars ?? lightColour;
          base = dim ? plateMix(background, stars, .3) : stars;
        } else {
          final row = plateMix(
            gradient.top,
            gradient.bottom,
            rows > 1 ? r / (rows - 1) : 0,
          );
          base = dim ? plateMix(background, row, .22) : row;
        }
        return _inked(roster, base, ch, background, burn: burn);
      });
}

/// The colour of one character of an egg plate, exactly as bake.mjs
/// `eggColor` computes it (checked against `frames.json` `eggColors`).
Color? eggColor(
  DaemonRoster roster,
  String kind,
  int rows,
  int r,
  String ch,
  String mat, {
  Color background = plateReferenceBackground,
  String light = 'plain',
  bool dim = false,
}) => EggInk(
  roster,
  kind,
  light: light,
  dim: dim,
  background: background,
).glyph(rows, r, ch, mat);

/// How an individual's plate is coloured (bake.mjs `individualColor`): its
/// body runs down its colour family ([family]; a shiny one's is the
/// species' shiny gradient); a marking cell (`m`) is its [accent], an
/// extra's (`a`) the extra's colour, the odd eye (`e`) `rules.plate.oddEye`.
/// The same ink paints the species plate in the family until the
/// individual's own plate arrives (every cell of it is body).
class IndividualInk implements PlateCellInk {
  IndividualInk(
    this.roster,
    this.family, {
    this.accent,
    this.extra,
    this.background = plateReferenceBackground,
    this.burn = _white,
  });

  final DaemonRoster roster;
  final DaemonGradient family;
  final Color? accent, extra;
  final Color background;
  final Color burn;
  final _cache = <(int, int, String, String), Color?>{};

  @override
  Color get glow => family.bottom;

  @override
  Color? cell(int rows, int r, String ch, String mat) => glyph(rows, r, ch, mat);

  Color? glyph(int rows, int r, String ch, String mat) =>
      _cache.putIfAbsent((rows, r, ch, mat), () {
        final Color base;
        if (mat == 'm' && accent != null) {
          base = accent!;
        } else if (mat == 'a' && extra != null) {
          base = extra!;
        } else if (mat == 'e') {
          base = roster.rules.plate?.oddEye ?? const Color(0xff5fffd7);
        } else {
          base = plateMix(
            family.top,
            family.bottom,
            rows > 1 ? r / (rows - 1) : 0,
          );
        }
        return _inked(roster, base, ch, background, burn: burn);
      });
}

/// The colour of one character of an individual's plate, exactly as bake.mjs
/// `individualColor` computes it (checked against `frames.json`
/// `individualColors`). Null for a space or a species without traits.
Color? individualColor(
  DaemonRoster roster,
  DaemonDef d,
  ({String colour, String accent, String? extra}) traits,
  int rows,
  int r,
  String ch,
  String mat, {
  Color background = plateReferenceBackground,
  bool shiny = false,
}) {
  final catalogue = d.traits;
  if (catalogue == null) return null;
  final colour = catalogue.colour(traits.colour) ?? catalogue.colours.first;
  final family = shiny && d.shinyGradient != null
      ? d.shinyGradient!
      : colour.gradient;
  return IndividualInk(
    roster,
    family,
    accent: _hexColor(traits.accent),
    extra: catalogue.extra(traits.extra)?.colour,
    background: background,
  ).glyph(rows, r, ch, mat);
}
