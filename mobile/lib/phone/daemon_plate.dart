import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart' show silhouette;
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
/// colour, glow or motion.
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

  /// A cell of mono is 1.2em tall, as the line art's is: about twice as tall
  /// as wide, the terminal cell the plates were shaded for.
  static const lineHeight = 1.2;

  /// The loop this view draws.
  List<List<String>> get loop =>
      daemonPlates.frames(def.id, size, version, mood);

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
    // A new mood, version or size starts its own loop from the top.
    if (old.def.id != widget.def.id ||
        old.mood != widget.mood ||
        old.version != widget.version ||
        old.size != widget.size) {
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

  /// One frame's rows as runs of one colour: a space rides in the run before
  /// it, since nothing of it is drawn.
  InlineSpan _frameSpan(List<String> rows) {
    final palette = PlatePalette.of(
      widget.roster,
      widget.def,
      rows.length,
      ground: widget.ground,
      shiny: widget.shiny,
    );
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
        final next = palette.at(r, ch);
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
      return FittedBox(
        fit: BoxFit.scaleDown,
        child: Text(
          rows.map(silhouette).join('\n'),
          softWrap: false,
          textScaler: TextScaler.noScaling,
          style: style.copyWith(color: widget.faint ?? DaemonInk.faint),
        ),
      );
    }
    final key = (loop, widget.shiny, widget.ground, widget.roster);
    if (_spansFor != key) {
      _spans.clear();
      _spansFor = key;
    }
    final glow = widget.def.gradientFor(shiny: widget.shiny)?.bottomColor;
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
          _spans.putIfAbsent(index, () => _frameSpan(rows)),
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
