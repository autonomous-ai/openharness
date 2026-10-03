import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart'
    show DaemonTraits, silhouette;
import 'package:harness_mobile/daemons/roster.dart';

import 'daemon_style.dart';

/// A daemon drawn filled (drop `init`), as the phone shows it: its baked plate
/// at a [size], [version] and [mood], every glyph in the plate colour of its
/// row (`plates.dart`, README "Plate colour") on [ground] — the shiny gradient
/// when [shiny] — over a soft glow in the gradient's bottom colour.
///
/// The loop runs a frame every `frameMs` (170 ms) while [animate] and nothing
/// asks for less: Reduce Motion, a route in front of it (its [TickerMode]), or
/// [animate] false (the app in the background) show frame 0. A timer, not a
/// ticker, so a screen with a plate on it still settles between frames.
///
/// [asSilhouette] draws frame 0 as the hatch's `#` shape in [faint]: no
/// colour, glow or motion; [rowsShown] draws only its top rows, at the
/// bottom of its full height, as the hatchling rises out of its shell.
///
/// An individual ([traits], README "Individuals") wears its own colour family
/// down the rows, and, once harnessd has drawn it, its own [art]: frames with
/// materials, its markings in its accent, its extra in the extra's colour, its
/// odd eye. Until then (or where no computer can draw it) it is the species
/// plate in its colour family. Seed 0 is the species itself.
///
/// Art is never wrapped and never grows with the text: it is scaled down to
/// fit, as the line art is.
class DaemonPlateView extends StatefulWidget {
  const DaemonPlateView({
    super.key,
    required this.roster,
    required this.def,
    required this.size,
    required this.version,
    this.mood = DaemonMood.idle,
    this.shiny = false,
    this.ground = DaemonInk.deep,
    this.fontSize = 14,
    this.animate = true,
    this.asSilhouette = false,
    this.faint,
    this.traits,
    this.art,
    this.rowsShown,
  });

  final DaemonRoster roster;
  final DaemonDef def;
  final PlateSize size;
  final String version;
  final DaemonMood mood;
  final bool shiny;

  /// What it is drawn on: a faint glyph mixes from it toward its row's colour.
  final Color ground;
  final double fontSize;
  final bool animate, asSilhouette;

  /// The silhouette's colour.
  final Color? faint;

  /// The individual drawn: its colour family, and with [art] its materials.
  /// Null (or seed 0) for the species.
  final DaemonTraits? traits;

  /// The individual's own loop, as harnessd drew it; null for the species
  /// plate in the individual's colours.
  final List<PlateFrame>? art;

  /// Only this many of the top rows, at the bottom of the plate's height.
  final int? rowsShown;

  /// Whether this draws an individual's own colours rather than the
  /// species'.
  bool get individual => traits != null && traits!.seed != 0;

  /// A cell of mono is 1.2em tall, as the line art's is: about twice as tall
  /// as wide, the terminal cell the plates were shaded for.
  static const lineHeight = 1.2;

  /// The loop this view draws: the individual's own, else the species'.
  List<List<String>> get loop {
    final own = art;
    if (own != null && own.isNotEmpty) return [for (final f in own) f.rows];
    return daemonPlates.frames(def.id, size, version, mood);
  }

  @override
  State<DaemonPlateView> createState() => _DaemonPlateViewState();
}

class _DaemonPlateViewState extends State<DaemonPlateView> {
  Timer? _timer;
  int _tick = 0;
  bool _reduceMotion = false;
  ValueListenable<TickerModeData>? _tickerMode;

  /// Built spans, by frame, for the inputs they were built from.
  final _spans = <int, InlineSpan>{};
  Object? _spansFor;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final mode = TickerMode.getValuesNotifier(context);
    if (!identical(mode, _tickerMode)) {
      _tickerMode?.removeListener(_tickerChanged);
      _tickerMode = mode..addListener(_tickerChanged);
    }
    _sync();
  }

  @override
  void didUpdateWidget(DaemonPlateView old) {
    super.didUpdateWidget(old);
    // A new mood, version, size or art starts its own loop from the top.
    if (old.def.id != widget.def.id ||
        old.mood != widget.mood ||
        old.version != widget.version ||
        old.size != widget.size ||
        !identical(old.art, widget.art)) {
      _tick = 0;
    }
    _sync();
  }

  void _tickerChanged() {
    if (mounted) setState(_sync);
  }

  bool get _running => _timer != null;

  void _sync() {
    final run =
        widget.animate &&
        !widget.asSilhouette &&
        !_reduceMotion &&
        (_tickerMode?.value.enabled ?? true) &&
        widget.loop.length > 1;
    if (run && _timer == null) {
      _timer = Timer.periodic(Duration(milliseconds: daemonPlates.frameMs), (
        _,
      ) {
        if (mounted) setState(() => _tick++);
      });
    } else if (!run && _timer != null) {
      _timer!.cancel();
      _timer = null;
      _tick = 0;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _tickerMode?.removeListener(_tickerChanged);
    super.dispose();
  }

  /// One frame's rows in their colours: the species' palette, or the
  /// individual's (with its materials when it is its own art).
  InlineSpan _frameSpan(List<String> rows, int index) {
    if (widget.individual) {
      final traits = widget.traits!;
      final palette = CellPalette.individual(
        widget.roster,
        widget.def,
        traits,
        rows.length,
        ground: widget.ground,
        shiny: widget.shiny,
      );
      final own = widget.art;
      final frame = own != null && index < own.length ? own[index] : null;
      return plateSpan(
        rows,
        (r, c, ch) => palette.at(r, ch, frame?.mat(r, c) ?? '.'),
      );
    }
    final palette = PlatePalette.of(
      widget.roster,
      widget.def,
      rows.length,
      ground: widget.ground,
      shiny: widget.shiny,
    );
    return plateSpan(rows, (r, c, ch) => palette.at(r, ch));
  }

  @override
  Widget build(BuildContext context) {
    final loop = widget.loop;
    if (loop.isEmpty) return const SizedBox.shrink();
    final index = _running ? _tick % loop.length : 0;
    final rows = loop[index];
    final style = DaemonInk.mono(
      size: widget.fontSize,
      height: DaemonPlateView.lineHeight,
    );
    if (widget.asSilhouette) {
      final shown = (widget.rowsShown ?? rows.length).clamp(0, rows.length);
      final blank = ' ' * rows.first.length;
      return FittedBox(
        fit: BoxFit.scaleDown,
        child: Text(
          [
            for (var i = 0; i < rows.length - shown; i++) blank,
            ...rows.take(shown).map(silhouette),
          ].join('\n'),
          softWrap: false,
          textScaler: TextScaler.noScaling,
          style: style.copyWith(color: widget.faint ?? DaemonInk.faint),
        ),
      );
    }
    final key = (
      loop,
      widget.shiny,
      widget.ground,
      widget.roster,
      widget.traits?.seed,
      widget.art,
    );
    if (_spansFor != key) {
      _spans.clear();
      _spansFor = key;
    }
    final family = widget.individual
        ? widget.def.traits?.colour(widget.traits!.colour)
        : null;
    final glow = widget.shiny || family == null
        ? widget.def.gradientFor(shiny: widget.shiny)?.bottomColor
        : _colour(family.bottom);
    return FittedBox(
      fit: BoxFit.scaleDown,
      child: DecoratedBox(
        decoration: BoxDecoration(
          // A soft glow in the bottom colour, where it is cheap: one gradient
          // behind the text, never a shadow per glyph.
          gradient: glow == null
              ? null
              : RadialGradient(
                  // Faded out by the nearest edge, so no box shows.
                  radius: .5,
                  colors: [
                    glow.withValues(alpha: .2),
                    glow.withValues(alpha: 0),
                  ],
                ),
        ),
        child: Text.rich(
          _spans.putIfAbsent(index, () => _frameSpan(rows, index)),
          softWrap: false,
          textScaler: TextScaler.noScaling,
          style: style,
        ),
      ),
    );
  }
}

/// How the hatch reveal draws a plate in [width] points (README "Plates"):
/// at `reveal` size when its 56-column canvas fits at a legible size, else at
/// `portrait` size scaled to the width. One font for every version at a size,
/// so a hatchling's plate stays small beside the grown one's, as it should.
({PlateSize size, double fontSize}) revealPlateFit(
  DaemonRoster roster,
  double width,
) {
  final cols = roster.rules.plate?.cols ?? const {};
  final reveal = (cols['reveal'] ?? 56) * cellAdvance;
  final portrait = (cols['portrait'] ?? 28) * cellAdvance;
  final font = width / reveal;
  if (font >= revealMinFont) {
    return (size: PlateSize.reveal, fontSize: font.clamp(0, revealMaxFont));
  }
  return (
    size: PlateSize.portrait,
    fontSize: (width / portrait).clamp(0, portraitMaxFont),
  );
}

/// A monospace cell is 0.6em wide in every face the phone draws art in (SF
/// Mono, Menlo, JetBrains Mono, Roboto Mono); a wider one is scaled down.
const cellAdvance = .6;

/// Below this a reveal plate's cells stop reading as glyphs: 8pt is a 320pt
/// phone's width across its 56 columns, inside the reveal's margins.
const revealMinFont = 8.0;

/// A tablet does not blow the reveal plate up past a comfortable size.
const revealMaxFont = 13.0;

/// The portrait plate, scaled up to a narrow width, stops here.
const portraitMaxFont = 22.0;


Color _colour(String hex) =>
    Color(0xff000000 | int.parse(hex.substring(1), radix: 16));

/// A plate's [rows] as runs of one colour, [colourAt] a cell's (null for a
/// space: it rides in the run before it, since nothing of it is drawn).
InlineSpan plateSpan(
  List<String> rows,
  Color? Function(int r, int c, String ch) colourAt,
) {
  final spans = <TextSpan>[];
  for (var r = 0; r < rows.length; r++) {
    final row = rows[r];
    final run = StringBuffer();
    Color? colour;
    void flush() {
      if (run.isEmpty) return;
      spans.add(
        TextSpan(
          text: run.toString(),
          style: colour == null ? null : TextStyle(color: colour),
        ),
      );
      run.clear();
    }

    for (var c = 0; c < row.length; c++) {
      final ch = row[c];
      final next = ch == ' ' ? null : colourAt(r, c, ch);
      if (next != null && next != colour && run.isNotEmpty) {
        // Leading spaces went out with the previous colour; that is fine.
        flush();
      }
      if (next != null) colour = next;
      run.write(ch);
    }
    if (r < rows.length - 1) run.write('\n');
    flush();
  }
  return TextSpan(children: spans);
}

/// An egg drawn filled (README "Eggs"): its kind's shell at a [stage] of its
/// baked plates, each glyph in its egg colour (`eggHex`: the shell down its
/// kind's gradient, the light inside in [light], a secret's opening [dim]) on
/// [ground], over a soft glow in the shell's bottom colour, or in the light
/// once it is opened.
///
/// `p0` and `p4` loop a frame every `eggMs.loop` (190 ms) while [animate] and
/// nothing asks for less (Reduce Motion, a route in front of it); `p1` to
/// `p3` hold still. The hatch reveal passes the [frame] it is on instead.
class EggPlateView extends StatefulWidget {
  const EggPlateView({
    super.key,
    required this.roster,
    required this.kind,
    required this.stage,
    this.size = PlateSize.portrait,
    this.frame,
    this.light = 'plain',
    this.dim = false,
    this.ground = DaemonInk.deep,
    this.fontSize = 14,
    this.animate = true,
    this.fromRow = 0,
  });

  final DaemonRoster roster;
  final String kind, stage;
  final PlateSize size;

  /// Draw this frame of the stage, still; null loops a waiting egg.
  final int? frame;

  /// The light inside: `plain` while earned, the rarity's once opened.
  final String light;
  final bool dim;
  final Color ground;
  final double fontSize;
  final bool animate;

  /// Rows above this are left out (the empty top of an opened shell, under a
  /// hatchling rising out of it).
  final int fromRow;

  List<PlateFrame> get frames => daemonPlates.egg(kind, size, stage);

  @override
  State<EggPlateView> createState() => _EggPlateViewState();
}

class _EggPlateViewState extends State<EggPlateView> {
  Timer? _timer;
  int _tick = 0;
  bool _reduceMotion = false;
  ValueListenable<TickerModeData>? _tickerMode;
  final _spans = <int, InlineSpan>{};
  Object? _spansFor;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final mode = TickerMode.getValuesNotifier(context);
    if (!identical(mode, _tickerMode)) {
      _tickerMode?.removeListener(_tickerChanged);
      _tickerMode = mode..addListener(_tickerChanged);
    }
    _sync();
  }

  @override
  void didUpdateWidget(EggPlateView old) {
    super.didUpdateWidget(old);
    if (old.kind != widget.kind || old.stage != widget.stage) _tick = 0;
    _sync();
  }

  void _tickerChanged() {
    if (mounted) setState(_sync);
  }

  void _sync() {
    final run =
        widget.frame == null &&
        widget.animate &&
        !_reduceMotion &&
        (_tickerMode?.value.enabled ?? true) &&
        widget.frames.length > 1;
    if (run && _timer == null) {
      final ms = widget.roster.rules.plate?.eggMs.loop ?? 190;
      _timer = Timer.periodic(Duration(milliseconds: ms), (_) {
        if (mounted) setState(() => _tick++);
      });
    } else if (!run && _timer != null) {
      _timer!.cancel();
      _timer = null;
      _tick = 0;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _tickerMode?.removeListener(_tickerChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final frames = widget.frames;
    if (frames.isEmpty) return const SizedBox.shrink();
    final index = widget.frame != null
        ? widget.frame!.clamp(0, frames.length - 1)
        : _timer != null
        ? _tick % frames.length
        : 0;
    final frame = frames[index];
    final key = (
      frames,
      widget.light,
      widget.dim,
      widget.ground,
      widget.fromRow,
    );
    if (_spansFor != key) {
      _spans.clear();
      _spansFor = key;
    }
    final palette = CellPalette.egg(
      widget.roster,
      widget.kind,
      frame.rows.length,
      ground: widget.ground,
      light: widget.light,
      dim: widget.dim,
    );
    final from = widget.fromRow.clamp(0, frame.rows.length - 1);
    final span = _spans.putIfAbsent(
      index,
      () => plateSpan(
        frame.rows.sublist(from),
        (r, c, ch) => palette.at(r + from, ch, frame.mat(r + from, c)),
      ),
    );
    final egg = widget.roster.rules.eggs[widget.kind];
    final light = widget.roster.rules.plate?.light[widget.light];
    final glow = widget.light != 'plain' && light != null
        ? _colour(light)
        : widget.dim || egg == null
        ? null
        : egg.gradient.bottomColor;
    return FittedBox(
      fit: BoxFit.scaleDown,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: glow == null
              ? null
              : RadialGradient(
                  radius: .5,
                  colors: [glow.withValues(alpha: .2), glow.withValues(alpha: 0)],
                ),
        ),
        child: Text.rich(
          span,
          softWrap: false,
          textScaler: TextScaler.noScaling,
          style: DaemonInk.mono(
            size: widget.fontSize,
            height: DaemonPlateView.lineHeight,
          ),
        ),
      ),
    );
  }
}

/// The first row with ink in the `open` stage of [kind]'s egg at [size]: the
/// rim of the bottom half, where a hatchling rises from.
int eggRim(String kind, PlateSize size) {
  final open = daemonPlates.egg(kind, size, 'open');
  if (open.isEmpty) return 0;
  final rows = open.first.rows;
  final at = rows.indexWhere((r) => r.trim().isNotEmpty);
  return at < 0 ? 0 : at;
}
