import 'dart:async';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../daemons/daemon_plate_client.dart';
import '../daemons/individuals.dart';
import '../daemons/plates.dart';
import '../daemons/render.dart';
import '../daemons/roster.dart';
import 'daemon_slot.dart';

/// A daemon's portrait wherever one shows: the panel's zoo, the hatch
/// reveal, a duplicate's merge and a level-up.
///
/// A filled daemon (README, "Plates") prints its baked plate at [size], each
/// glyph in the plate colour ([daemonPlateInk]) with a soft glow in its
/// bottom colour, and steps through [mood]'s loop, a frame every `frameMs`
/// (170 ms), while [animate] is on and the page can move: Reduce Motion, a
/// paused ticker (the panel off screen) or [animate] off (a background
/// window, the Motion setting) show frame 0. Any other daemon draws its line
/// portrait in its one colour, as it always has, its parts moving with [t],
/// [lid] and [motion].
///
/// An individual ([traits]) is its own plate ([art], drawn on this computer
/// by the harness process, with its markings, extra and odd eye in their
/// colours) once that has arrived, and until then the species plate painted
/// in its colour family.
///
/// [silhouette] draws every glyph as `#` in [style]'s colour; [rows] draws
/// given rows (a morph between versions) in the daemon's colours, still.
class DaemonPortrait extends StatefulWidget {
  const DaemonPortrait({
    super.key,
    required this.roster,
    required this.def,
    required this.version,
    required this.style,
    required this.theme,
    this.mood = DaemonMood.idle,
    this.size = PlateSize.portrait,
    this.shiny = false,
    this.animate = false,
    this.background,
    this.silhouette = false,
    this.rows,
    this.t = 0,
    this.lid,
    this.motion = false,
    this.textKey,
    this.semanticsLabel,
    this.traits,
    this.art,
  });

  final DaemonRoster roster;
  final DaemonDef def;
  final String version;

  /// The ink: font, features and line height. A silhouette takes its colour.
  final TextStyle style;
  final TerminalTheme theme;
  final DaemonMood mood;
  final PlateSize size;
  final bool shiny;
  final bool animate;

  /// What the portrait is drawn on, which faint glyphs mix from: the
  /// daemon's backdrop or the terminal's background by default.
  final Color? background;
  final bool silhouette;
  final List<String>? rows;
  final int t;
  final String? lid;
  final bool motion;
  final Key? textKey;
  final String? semanticsLabel;

  /// The individual this is: its colour family paints the plate.
  final DaemonTraits? traits;

  /// Its own plate from the harness process, when that has arrived.
  final DaemonIndividualArt? art;

  @override
  State<DaemonPortrait> createState() => _DaemonPortraitState();
}

class _DaemonPortraitState extends State<DaemonPortrait> {
  Timer? _timer;
  int _tick = 0;

  List<List<String>> get _loop => daemonPlates.loop(
    widget.def.id,
    widget.size,
    widget.version,
    widget.mood,
  );

  /// The frames that loop: the individual's own when they have come.
  int get _frames => widget.art?.frames.length ?? _loop.length;
  int get _frameMs => widget.art?.frameMs ?? daemonPlates.frameMs;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _schedule();
  }

  @override
  void didUpdateWidget(DaemonPortrait old) {
    super.didUpdateWidget(old);
    // A new mood starts its loop at the beginning.
    if (old.mood != widget.mood ||
        old.def.id != widget.def.id ||
        old.version != widget.version ||
        old.size != widget.size ||
        old.art != widget.art) {
      _tick = 0;
      if (old.art?.frameMs != widget.art?.frameMs) {
        _timer?.cancel();
        _timer = null;
      }
    }
    _schedule();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  /// Whether the loop may run now: a plate, asked to move, on a page that
  /// can move (no Reduce Motion, a live ticker), with more than one frame.
  bool get _moving =>
      widget.animate &&
      widget.def.plate &&
      widget.rows == null &&
      !widget.silhouette &&
      !(MediaQuery.maybeDisableAnimationsOf(context) ?? false) &&
      TickerMode.valuesOf(context).enabled &&
      _frames > 1;

  void _schedule() {
    final moving = _moving;
    if (moving == (_timer != null)) return;
    _timer?.cancel();
    _timer = null;
    if (!moving) {
      _tick = 0;
      return;
    }
    _timer = Timer.periodic(Duration(milliseconds: _frameMs), (_) {
      if (mounted) setState(() => _tick++);
    });
  }

  @override
  Widget build(BuildContext context) {
    final w = widget;
    final label = w.semanticsLabel;
    if (!w.def.plate) {
      final rows =
          w.rows ??
          renderPortrait(
            w.roster,
            w.def,
            w.version,
            w.mood,
            t: w.t,
            lid: w.lid,
            motion: w.motion,
          );
      return Text(
        (w.silhouette ? rows.map(silhouette) : rows).join('\n'),
        key: w.textKey,
        semanticsLabel: label,
        style: w.silhouette
            ? w.style
            : w.style.copyWith(
                color: daemonColor(w.def, w.theme, shiny: w.shiny),
              ),
      );
    }
    final art = w.rows == null ? w.art : null;
    final loop = _loop;
    final own = art == null || art.frames.isEmpty
        ? null
        : art.frames[_tick % art.frames.length];
    final rows =
        w.rows ??
        own?.rows ??
        (loop.isEmpty ? const <String>[] : loop[_tick % loop.length]);
    if (w.silhouette) {
      return Text(
        rows.map(silhouette).join('\n'),
        key: w.textKey,
        semanticsLabel: label,
        style: w.style,
      );
    }
    final PlateCellInk ink =
        (w.traits == null
            ? null
            : daemonIndividualInk(
                w.roster,
                w.def,
                w.traits,
                w.theme,
                shiny: w.shiny,
                background: w.background,
              )) ??
        daemonPlateInk(
          w.roster,
          w.def,
          w.theme,
          shiny: w.shiny,
          background: w.background,
        )!;
    // The glow: one soft shadow in the bottom colour under every glyph.
    final size = w.style.fontSize ?? 13;
    final style = w.style.copyWith(
      shadows: [
        Shadow(color: ink.glow.withValues(alpha: .45), blurRadius: size * .8),
      ],
    );
    // Only the plate repaints on each frame of its loop.
    return RepaintBoundary(
      child: Text.rich(
        TextSpan(
          children: plateSpans(
            rows,
            w.art?.performance == null ? ink : _CompanionInk(ink),
            style,
            mats: own?.mats,
          ),
        ),
        key: w.textKey,
        semanticsLabel: label,
        style: style,
      ),
    );
  }
}

/// An egg as a filled plate (README, "Eggs"): its kind's shell at [stage],
/// the light inside plain while it is earned ([light] a rarity's once it
/// opens; a secret's opening [dim]), each glyph in [daemonEggInk], with a
/// soft glow in its bottom colour (in the light, once open). `p0` and `p4`
/// loop a frame every `eggMs.loop` (190 ms) while [animate] is on and the
/// page can move; `p1` to `p3` hold still. [frame] draws one fixed frame
/// (the hatch drives its own).
class DaemonEggPlate extends StatefulWidget {
  const DaemonEggPlate({
    super.key,
    required this.roster,
    required this.kind,
    required this.stage,
    required this.style,
    required this.theme,
    this.size = PlateSize.portrait,
    this.light = 'plain',
    this.dim = false,
    this.animate = false,
    this.frame,
    this.background,
    this.textKey,
    this.semanticsLabel,
  });

  final DaemonRoster roster;
  final String kind, stage;
  final TextStyle style;
  final TerminalTheme theme;
  final PlateSize size;
  final String light;
  final bool dim, animate;
  final int? frame;
  final Color? background;
  final Key? textKey;
  final String? semanticsLabel;

  @override
  State<DaemonEggPlate> createState() => _DaemonEggPlateState();
}

class _DaemonEggPlateState extends State<DaemonEggPlate> {
  Timer? _timer;
  int _tick = 0;

  List<PlateFrame> get _frames =>
      daemonPlates.egg(widget.kind, widget.size, widget.stage);

  bool get _moving =>
      widget.animate &&
      widget.frame == null &&
      (widget.stage == 'p0' || widget.stage == 'p4') &&
      !(MediaQuery.maybeDisableAnimationsOf(context) ?? false) &&
      TickerMode.valuesOf(context).enabled &&
      _frames.length > 1;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _schedule();
  }

  @override
  void didUpdateWidget(DaemonEggPlate old) {
    super.didUpdateWidget(old);
    if (old.kind != widget.kind ||
        old.stage != widget.stage ||
        old.size != widget.size) {
      _tick = 0;
    }
    _schedule();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _schedule() {
    final moving = _moving;
    if (moving == (_timer != null)) return;
    _timer?.cancel();
    _timer = null;
    if (!moving) {
      _tick = 0;
      return;
    }
    final ms = widget.roster.rules.plate?.eggMs.loop ?? 190;
    _timer = Timer.periodic(Duration(milliseconds: ms), (_) {
      if (mounted) setState(() => _tick++);
    });
  }

  @override
  Widget build(BuildContext context) {
    final w = widget;
    final frames = _frames;
    if (frames.isEmpty) return const SizedBox.shrink();
    final frame = frames[(w.frame ?? _tick) % frames.length];
    final ink = daemonEggInk(
      w.roster,
      w.kind,
      w.theme,
      light: w.light,
      dim: w.dim,
      background: w.background,
    );
    final size = w.style.fontSize ?? 13;
    final style = w.style.copyWith(
      shadows: [
        Shadow(
          color: ink.glow.withValues(alpha: w.dim ? .25 : .4),
          blurRadius: size * .8,
        ),
      ],
    );
    return RepaintBoundary(
      child: Text.rich(
        TextSpan(
          children: plateSpans(frame.rows, ink, style, mats: frame.mats),
        ),
        key: w.textKey,
        semanticsLabel: w.semanticsLabel,
        style: style,
      ),
    );
  }
}

// Tim's expressive pupils, lids and mouth use the same material color as #.
class _CompanionInk implements PlateCellInk {
  const _CompanionInk(this.base);
  final PlateCellInk base;
  @override
  Color get glow => base.glow;
  @override
  Color? cell(int rows, int r, String ch, String mat) => ch == ' '
      ? null
      : mat == 'p'
      ? const Color(0xffffffff)
      : (base.cell(rows, r, ch, mat) ?? base.cell(rows, r, '#', mat));
}
