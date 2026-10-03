/// Daemons drawn filled (`plate: true`, drop `init`): their baked plates, read
/// from the generated copy of `daemons/plates.json`, and the colour rule every
/// client follows (`plateColor` in `daemons/tools/bake.mjs`, README "Plate
/// colour"). `test/daemons/render_frames_test.dart` checks the colours against
/// `daemons/frames.json` `plateColors`.
///
/// A client never runs a model: it prints the baked text. Each daemon has two
/// widths ([PlateSize]); each version and mood a loop of frames (`idle` 8, the
/// others 4), one every `frameMs`; all frames of one width and version share
/// one crop, so nothing jumps between moods. Reduce Motion shows frame 0.
///
/// ⚠️ **About a megabyte of JSON.** [daemonPlates] is a top-level final, so it
/// is parsed once, on the first plate anything draws — never at launch, and
/// never for somebody whose daemons are all line art.
library;

import 'dart:convert';
import 'dart:ui' show Color;

import 'package:flutter/foundation.dart' show immutable;

import 'plates.g.dart';
import 'render.dart' show DaemonTraits;
import 'roster.dart';

/// The two widths a plate is baked at (`rules.plate.cols`): `portrait`, 28
/// columns and at most 12 rows, where a portrait shows (the sheet, the card);
/// `reveal`, 56 columns and at most 24 rows, for the hatch reveal.
enum PlateSize { portrait, reveal }

/// One frame of a plate with its materials: [rows] of glyphs, and [mats], a
/// letter per cell (`g` glow, `s` star, `p` peek on an egg; `m` a marking,
/// `a` a rare extra, `e` the odd eye on an individual; `.` none).
@immutable
class PlateFrame {
  const PlateFrame(this.rows, this.mats);

  /// A frame as plates.json and harnessd write it: rows joined by newlines.
  /// Material rows that do not match the rows in shape are dropped, so every
  /// cell is plain.
  factory PlateFrame.parse(String rows, String? mats) {
    final r = rows.split('\n');
    final m = mats?.split('\n');
    final fits =
        m != null &&
        m.length == r.length &&
        [for (var i = 0; i < r.length; i++) m[i].length == r[i].length]
            .every((ok) => ok);
    return PlateFrame(
      List.unmodifiable(r),
      List.unmodifiable(fits ? m : [for (final row in r) '.' * row.length]),
    );
  }

  final List<String> rows, mats;

  /// The material of the cell at row [r], column [c]; `.` outside.
  String mat(int r, int c) =>
      r >= 0 && c >= 0 && r < mats.length && c < mats[r].length
      ? mats[r][c]
      : '.';
}

class DaemonPlates {
  DaemonPlates._(Map raw)
    : source = raw['source'] as String? ?? '',
      frameMs = (raw['frameMs'] as num).toInt(),
      _daemons = raw['daemons'] as Map,
      _eggs = raw['eggs'] as Map? ?? const {};

  factory DaemonPlates.parse(String json) =>
      DaemonPlates._(jsonDecode(json) as Map);

  /// The hash of what the plates were baked from.
  final String source;

  /// One frame of a loop lasts this long.
  final int frameMs;

  final Map _daemons;
  final Map _eggs;
  final _loops = <String, List<List<String>>>{};
  final _eggLoops = <String, List<PlateFrame>>{};

  /// Every frame of [kind]'s egg at [size] and [stage] (plates.json
  /// `eggs[kind][size][stage]`), with its materials. `p0` and `p4` loop 8
  /// frames, `p1` to `p3` hold 1, opening `rock` 8, `burst` 6, `tumble` 8 and
  /// `open` 1; every stage of one kind and size shares one crop. Empty for a
  /// kind or stage not baked.
  List<PlateFrame> egg(String kind, PlateSize size, String stage) =>
      _eggLoops.putIfAbsent('$kind ${size.name} $stage', () {
        final list =
            ((_eggs[kind] as Map?)?[size.name] as Map?)?[stage] as List?;
        if (list == null) return const [];
        return List.unmodifiable([
          for (final f in list)
            PlateFrame.parse(
              (f as Map)['rows'] as String,
              f['mats'] as String?,
            ),
        ]);
      });

  /// Whether [kind] has baked eggs.
  bool hasEgg(String kind) => _eggs.containsKey(kind);

  /// Whether [id] has baked plates.
  bool has(String? id) => _daemons.containsKey(id);

  /// The loop [id] draws at [size], [version] and [mood], each frame as its
  /// rows. A version not baked draws as the nearest one below (else the
  /// first), a mood not baked as `idle`; empty for a daemon with no plates.
  List<List<String>> frames(
    String id,
    PlateSize size,
    String version,
    DaemonMood mood,
  ) => _loops.putIfAbsent('$id ${size.name} $version ${mood.name}', () {
    final bySize = (_daemons[id] as Map?)?[size.name] as Map?;
    if (bySize == null || bySize.isEmpty) return const [];
    // Versions are `0.1`, `1.0`, `2.0`: they order as numbers.
    double n(String v) => double.tryParse(v) ?? 0;
    final versions = [for (final v in bySize.keys) v as String]
      ..sort((a, b) => n(a).compareTo(n(b)));
    var at = versions.contains(version) ? version : null;
    if (at == null) {
      final below = versions.where((v) => n(v) <= n(version));
      at = below.isNotEmpty ? below.last : versions.first;
    }
    final byMood = bySize[at] as Map;
    final loop = (byMood[mood.name] ?? byMood['idle']) as List?;
    if (loop == null) return const [];
    return List.unmodifiable([
      for (final frame in loop)
        List<String>.unmodifiable((frame as String).split('\n')),
    ]);
  });

  /// The still a card and a Reduce Motion screen show: `idle`, frame 0.
  List<String> still(String id, PlateSize size, String version) {
    final loop = frames(id, size, version, DaemonMood.idle);
    return loop.isEmpty ? const [] : loop.first;
  }
}

/// Every baked plate, parsed once, the first time one is drawn.
final daemonPlates = DaemonPlates.parse(daemonPlatesJson);

/// The ground `frames.json` pins the colours on, and the one every plate on
/// the phone sits on (`DaemonInk.deep`).
const plateGround = Color(0xFF0C0C0C);

List<int> _rgb(String hex) => [
  for (final i in const [1, 3, 5])
    int.parse(hex.substring(i, i + 2), radix: 16),
];

/// `Math.round` of a non-negative mix, as bake.mjs rounds it.
List<int> _mix(List<int> a, List<int> b, double t) => [
  for (var i = 0; i < 3; i++) (a[i] + (b[i] - a[i]) * t).round(),
];

String _hex(List<int> c) =>
    '#${c.map((v) => v.toRadixString(16).padLeft(2, '0')).join()}';

List<int> _groundRgb(Color c) => [
  (c.r * 255).round(),
  (c.g * 255).round(),
  (c.b * 255).round(),
];

/// The colour of one glyph [ch] on row [r] of a plate [rows] tall, as
/// `#rrggbb` (bake.mjs `plateColor`): the row takes `mix(top, bottom, r / (rows
/// - 1))` of the daemon's gradient (its shiny one when [shiny]); a glyph at
/// most 1 bright mixes from [ground] toward it, one above 1 mixes on toward
/// white by the excess. Null for a character that is not ink (a space is not
/// drawn), and for a daemon with no gradient.
String? plateHex(
  DaemonRoster roster,
  DaemonDef d,
  int rows,
  int r,
  String ch, {
  Color ground = plateGround,
  bool shiny = false,
}) {
  final g = d.gradientFor(shiny: shiny);
  final level = roster.rules.plate?.ink[ch];
  if (g == null || level == null) return null;
  final row = _mix(_rgb(g.top), _rgb(g.bottom), rows > 1 ? r / (rows - 1) : 0);
  return _hex(
    level > 1
        ? _mix(row, const [255, 255, 255], level - 1)
        : _mix(_groundRgb(ground), row, level),
  );
}

/// [plateHex] as a colour.
Color? plateColor(
  DaemonRoster roster,
  DaemonDef d,
  int rows,
  int r,
  String ch, {
  Color ground = plateGround,
  bool shiny = false,
}) {
  final hex = plateHex(roster, d, rows, r, ch, ground: ground, shiny: shiny);
  return hex == null
      ? null
      : Color(0xff000000 | int.parse(hex.substring(1), radix: 16));
}

/// Every colour a plate of [rows] rows can take, per row and glyph: worked
/// out once per daemon, height, shine and ground, not once per cell a frame.
class PlatePalette {
  PlatePalette._(this._rows);

  static final _cache = <String, PlatePalette>{};

  factory PlatePalette.of(
    DaemonRoster roster,
    DaemonDef d,
    int rows, {
    Color ground = plateGround,
    bool shiny = false,
  }) => _cache.putIfAbsent(
    '${d.id} $rows $shiny ${ground.toARGB32()} ${identityHashCode(roster)}',
    () => PlatePalette._([
      for (var r = 0; r < rows; r++)
        {
          for (final ch in roster.rules.plate?.ink.keys ?? const <String>[])
            ch: plateColor(
              roster,
              d,
              rows,
              r,
              ch,
              ground: ground,
              shiny: shiny,
            )!,
        },
    ]),
  );

  final List<Map<String, Color>> _rows;

  /// The colour of [ch] on row [r]; null for a space.
  Color? at(int r, String ch) => r < _rows.length ? _rows[r][ch] : null;
}


/// One glyph of ink over a base colour (bake.mjs `inked`): at most 1 bright
/// mixes from [ground] toward it, above 1 on toward white by the excess. Null
/// for a character that is not ink.
String? _inked(DaemonRoster roster, List<int> base, String ch, Color ground) {
  final level = roster.rules.plate?.ink[ch];
  if (level == null) return null;
  return _hex(
    level > 1
        ? _mix(base, const [255, 255, 255], level - 1)
        : _mix(_groundRgb(ground), base, level),
  );
}

Color _colour(String hex) =>
    Color(0xff000000 | int.parse(hex.substring(1), radix: 16));

/// The colour of one glyph of an egg plate, `#rrggbb` (bake.mjs `eggColor`).
/// The shell runs down its kind's gradient a row at a time, like a daemon's
/// plate; a glow cell (`g`, the light inside) is `rules.plate.light[light]`,
/// `plain` while it is earned and the rarity's once it opens; a peek cell
/// (`p`) is `light.peek`; a star (`s`) the kind's stars. [dim], a secret's
/// opening, takes the shell down to 0.22 of its colour and the stars to 0.3;
/// the light stays. Null for a character that is not ink.
String? eggHex(
  DaemonRoster roster,
  String kind,
  int rows,
  int r,
  String ch,
  String mat, {
  Color ground = plateGround,
  String light = 'plain',
  bool dim = false,
}) {
  final egg = roster.rules.eggs[kind];
  final plate = roster.rules.plate;
  if (egg == null || plate == null) return null;
  final bg = _groundRgb(ground);
  final List<int> base;
  if (mat == 'g') {
    base = _rgb(plate.light[light] ?? plate.light['plain'] ?? '#ffffd7');
  } else if (mat == 'p') {
    base = _rgb(plate.light['peek'] ?? '#ffffff');
  } else if (mat == 's' && egg.stars != null) {
    base = dim ? _mix(bg, _rgb(egg.stars!), 0.3) : _rgb(egg.stars!);
  } else {
    final row = _mix(
      _rgb(egg.gradient.top),
      _rgb(egg.gradient.bottom),
      rows > 1 ? r / (rows - 1) : 0,
    );
    base = dim ? _mix(bg, row, 0.22) : row;
  }
  return _inked(roster, base, ch, ground);
}

/// The colour of one glyph of an individual's plate, `#rrggbb` (bake.mjs
/// `individualColor`). Its body runs down its colour family ([traits]
/// `colour`; a shiny one's is the species' shiny gradient); a marking (`m`) is
/// its accent, an extra's cell (`a`) the extra's colour, the odd eye (`e`)
/// `rules.plate.oddEye`. A species plate has no materials: painted this way it
/// is the individual's colour family, which is what a phone shows until the
/// individual's own art arrives. Null for a character that is not ink.
String? individualHex(
  DaemonRoster roster,
  DaemonDef d,
  DaemonTraits traits,
  int rows,
  int r,
  String ch,
  String mat, {
  Color ground = plateGround,
  bool shiny = false,
}) {
  final catalogue = d.traits;
  final List<int> base;
  final extra = catalogue?.extra(traits.extra)?.hex;
  if (mat == 'm') {
    base = _rgb(traits.accent);
  } else if (mat == 'a' && extra != null) {
    base = _rgb(extra);
  } else if (mat == 'e') {
    base = _rgb(roster.rules.plate?.oddEye ?? '#5fffd7');
  } else {
    final family = catalogue?.colour(traits.colour);
    final shinyStops = shiny ? d.shinyGradient : null;
    final top = shinyStops?.top ?? family?.top ?? d.gradient?.top;
    final bottom = shinyStops?.bottom ?? family?.bottom ?? d.gradient?.bottom;
    if (top == null || bottom == null) return null;
    base = _mix(_rgb(top), _rgb(bottom), rows > 1 ? r / (rows - 1) : 0);
  }
  return _inked(roster, base, ch, ground);
}

/// Every colour a plate's cells take, worked out once per row, glyph and
/// material and kept: a frame repaints from here, not from the colour rules.
class CellPalette {
  CellPalette(this._hexAt);

  final String? Function(int r, String ch, String mat) _hexAt;
  final _cells = <int, Map<String, Color?>>{};

  /// The colour of [ch] (made of [mat]) on row [r]; null for a space.
  Color? at(int r, String ch, [String mat = '.']) {
    final row = _cells.putIfAbsent(r, () => {});
    final key = '$ch$mat';
    if (row.containsKey(key)) return row[key];
    final hex = _hexAt(r, ch, mat);
    return row[key] = hex == null ? null : _colour(hex);
  }

  static final _eggs = <String, CellPalette>{};
  static final _individuals = <String, CellPalette>{};

  /// An egg plate of [rows] rows of [kind] in [light] ([dim] for a secret's
  /// opening) on [ground].
  factory CellPalette.egg(
    DaemonRoster roster,
    String kind,
    int rows, {
    Color ground = plateGround,
    String light = 'plain',
    bool dim = false,
  }) => _eggs.putIfAbsent(
    '$kind $rows $light $dim ${ground.toARGB32()} ${identityHashCode(roster)}',
    () => CellPalette(
      (r, ch, mat) => eggHex(
        roster,
        kind,
        rows,
        r,
        ch,
        mat,
        ground: ground,
        light: light,
        dim: dim,
      ),
    ),
  );

  /// An individual's plate of [rows] rows (its own art, or the species plate
  /// recoloured) on [ground].
  factory CellPalette.individual(
    DaemonRoster roster,
    DaemonDef d,
    DaemonTraits traits,
    int rows, {
    Color ground = plateGround,
    bool shiny = false,
  }) => _individuals.putIfAbsent(
    '${d.id} ${traits.colour} ${traits.accent} ${traits.extra} $rows $shiny '
    '${ground.toARGB32()} ${identityHashCode(roster)}',
    () => CellPalette(
      (r, ch, mat) => individualHex(
        roster,
        d,
        traits,
        rows,
        r,
        ch,
        mat,
        ground: ground,
        shiny: shiny,
      ),
    ),
  );
}
