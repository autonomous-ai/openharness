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

import 'plates.g.dart';
import 'roster.dart';

/// The two widths a plate is baked at (`rules.plate.cols`): `portrait`, 28
/// columns and at most 12 rows, where a portrait shows (the sheet, the card);
/// `reveal`, 56 columns and at most 24 rows, for the hatch reveal.
enum PlateSize { portrait, reveal }

class DaemonPlates {
  DaemonPlates._(Map raw)
    : source = raw['source'] as String? ?? '',
      frameMs = (raw['frameMs'] as num).toInt(),
      _daemons = raw['daemons'] as Map;

  factory DaemonPlates.parse(String json) =>
      DaemonPlates._(jsonDecode(json) as Map);

  /// The hash of what the plates were baked from.
  final String source;

  /// One frame of a loop lasts this long.
  final int frameMs;

  final Map _daemons;
  final _loops = <String, List<List<String>>>{};

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
