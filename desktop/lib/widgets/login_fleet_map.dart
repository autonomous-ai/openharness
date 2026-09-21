import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;

/// The sign-in screen's picture: your machines, wherever they are, feeding
/// one window — this one.
///
/// Four pins on a dotted field — home, the office, a cloud region, a box under
/// a desk — with an arc from each into the window at the centre. It says
/// *where* rather than *how many*: distance is the thing a relay exists for,
/// and the old workspace preview (three agents side by side on one screen)
/// never hinted that the agents could be on other computers at all.
///
/// **Every motion is a packet.** One leaves a pin plain (a grey square — bytes
/// on hardware you own), rings the pin as it goes, is sealed on the way in
/// (the square turns accent and grows a halo) and lands in the pane it was
/// for, which flashes once. Nothing else moves on its own: no drifting dots,
/// no rotating rims. The four arcs fire a quarter of a cycle apart, so four
/// moving parts read as one instrument rather than four effects arguing.
///
/// Two clocks. [_entrance] runs ONCE, on first build: the window lands, the
/// pins pop in one after another, and each arc draws itself as its pin
/// arrives — "linking", said without a word. [_loop] is the heartbeat every
/// packet is a phase of, and it is the same 3.2 s the relay diagram before it
/// used, for the same reason: the aurora behind the card breathes at an exact
/// multiple, so the two never drift into a beat.
///
/// Reduce Motion (and a disabled `TickerMode`, which is how the widget tests
/// keep `pumpAndSettle` from hanging on an endless loop) parks both clocks:
/// the entrance at its end, so the field is fully drawn, and the loop at a
/// phase where one packet is sealed and another still plain — the picture
/// keeps making its point instead of becoming a diagram of nothing happening.
class LoginFleetMap extends StatefulWidget {
  const LoginFleetMap({super.key});

  /// The drawing's own aspect, so the caller can size it without guessing.
  static const double aspectRatio = 512 / 190;

  @override
  State<LoginFleetMap> createState() => _LoginFleetMapState();
}

/// The shared heartbeat. Every packet, ring and pane flash is a phase of it.
const Duration _period = Duration(milliseconds: 3200);

/// How long the field takes to assemble on first sight.
const Duration _entranceLength = Duration(milliseconds: 1700);

class _LoginFleetMapState extends State<LoginFleetMap>
    with TickerProviderStateMixin {
  late final AnimationController _entrance = AnimationController(
    vsync: this,
    duration: _entranceLength,
  );
  late final AnimationController _loop = AnimationController(
    vsync: this,
    duration: _period,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final stilled =
        MediaQuery.disableAnimationsOf(context) ||
        !TickerMode.valuesOf(context).enabled;
    if (stilled) {
      _entrance
        ..stop()
        ..value = 1;
      _loop
        ..stop()
        ..value = _reducedPhase;
    } else {
      if (!_entrance.isAnimating && _entrance.value < 1) _entrance.forward();
      if (!_loop.isAnimating) _loop.repeat();
    }
  }

  /// Where the loop stops for someone who asked for less motion: a quarter
  /// past the seal on one arc, so that packet glows while the next one along
  /// is still a plain grey square mid-flight.
  static const double _reducedPhase = 0.66;

  @override
  void dispose() {
    _entrance.dispose();
    _loop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Resolved HERE, not in the painter, which must never read a theme getter
    // from a paint callback.
    final palette = _MapPalette(
      dot: grid.AppPalette.guide,
      field: grid.AppGlass.surfaceFill,
      arc: grid.AppPalette.accentOnSurface,
      pinFill: grid.AppCard.inset,
      pinRim: grid.AppPalette.textSecondary,
      ink: grid.AppPalette.textPrimary,
      ink2: grid.AppPalette.textSecondary,
      faint: grid.AppPalette.textFaint,
      windowFill: grid.AppCard.inset,
      paneFill: grid.AppSurface.recess,
      hair: grid.AppCard.insetHair,
      accent: grid.AppPalette.accentOnSurface,
      raw: grid.AppPalette.textFaint,
      claude: const Color(0xFFD97757),
      codex: const Color(0xFF64D2FF),
      gemini: const Color(0xFFA78BFA),
      isDark: grid.AppTheme.isDark,
      sans: grid.AppFont.sans,
      sansFallback: grid.AppFont.sansFallback,
      mono: grid.AppFont.mono,
      monoFallback: grid.AppFont.monoFallback,
    );
    return RepaintBoundary(
      child: AspectRatio(
        aspectRatio: LoginFleetMap.aspectRatio,
        child: AnimatedBuilder(
          animation: Listenable.merge([_entrance, _loop]),
          builder: (context, _) => CustomPaint(
            painter: _MapPainter(
              entrance: Curves.easeOut.transform(_entrance.value),
              t: _loop.value,
              palette: palette,
            ),
            size: Size.infinite,
          ),
        ),
      ),
    );
  }
}

class _MapPalette {
  const _MapPalette({
    required this.dot,
    required this.field,
    required this.arc,
    required this.pinFill,
    required this.pinRim,
    required this.ink,
    required this.ink2,
    required this.faint,
    required this.windowFill,
    required this.paneFill,
    required this.hair,
    required this.accent,
    required this.raw,
    required this.claude,
    required this.codex,
    required this.gemini,
    required this.isDark,
    required this.sans,
    required this.sansFallback,
    required this.mono,
    required this.monoFallback,
  });

  final Color dot;
  final Color field;
  final Color arc;
  final Color pinFill;
  final Color pinRim;
  final Color ink;
  final Color ink2;
  final Color faint;
  final Color windowFill;
  final Color paneFill;
  final Color hair;
  final Color accent;
  final Color raw;
  final Color claude;
  final Color codex;
  final Color gemini;
  final bool isDark;
  final String sans;
  final List<String> sansFallback;
  final String mono;
  final List<String> monoFallback;

  /// Glow is tuned per theme rather than scaled: on white it can only be a
  /// tint before it turns to haze; on charcoal it has room to emit.
  double get haloAlpha => isDark ? 0.42 : 0.44;
  double get flowAlpha => isDark ? 0.95 : 0.85;
}

/// One machine on the field: where its pin sits, what it is called, and the
/// arc that carries its packets to the window.
class _Pin {
  const _Pin({
    required this.at,
    required this.name,
    required this.sub,
    required this.arc,
    required this.pane,
    required this.labelBelow,
  });

  final Offset at;
  final String name;
  final String sub;

  /// Control points of the cubic from the pin to the window's edge.
  final List<Offset> arc;

  /// Which pane in the window flashes when this machine's packet lands.
  final int pane;

  /// Whether the label hangs under the pin (top row) or sits over it (bottom
  /// row), so no label ever runs into the window.
  final bool labelBelow;
}

/// [color] at [k] of its OWN opacity. Several tokens here are translucent by
/// design (a recess is white at 6%, a hairline at 8%), and `withValues(alpha:)`
/// would replace that with a solid — a 6% white well painted as pure white.
Color _fade(Color color, double k) => color.withValues(alpha: color.a * k);

/// The drawing, in its own 512×190 space; the canvas is scaled to fit so every
/// number here is the one from the mockup rather than a fraction to re-derive.
class _MapPainter extends CustomPainter {
  _MapPainter({required this.entrance, required this.t, required this.palette});

  /// 0 → 1 over the first sight of the field; 1 forever after.
  final double entrance;

  /// The loop's phase, 0 → 1, wrapping.
  final double t;
  final _MapPalette palette;

  static const Size _design = Size(512, 190);

  /// The window at the centre.
  static const Rect _window = Rect.fromLTWH(190, 47, 132, 96);
  static const List<Rect> _panes = [
    Rect.fromLTWH(197, 66, 58, 32),
    Rect.fromLTWH(259, 66, 58, 32),
    Rect.fromLTWH(197, 102, 58, 32),
    Rect.fromLTWH(259, 102, 58, 32),
  ];

  static const List<_Pin> _pins = [
    _Pin(
      at: Offset(49, 39),
      name: 'Studio Mac',
      sub: 'home · claude, codex',
      arc: [Offset(120, 30), Offset(160, 80), Offset(190, 90)],
      pane: 0,
      labelBelow: true,
    ),
    _Pin(
      at: Offset(101, 125),
      name: 'Mac mini',
      sub: 'office · codex',
      arc: [Offset(150, 130), Offset(170, 110), Offset(190, 100)],
      pane: 1,
      labelBelow: true,
    ),
    _Pin(
      at: Offset(439, 31),
      name: 'dev-server',
      sub: 'us-east · claude, gemini',
      arc: [Offset(380, 30), Offset(350, 80), Offset(322, 90)],
      pane: 2,
      labelBelow: true,
    ),
    _Pin(
      at: Offset(477, 123),
      name: 'gpu-box',
      sub: 'under the desk · claude',
      arc: [Offset(420, 130), Offset(370, 110), Offset(322, 100)],
      pane: 3,
      labelBelow: true,
    ),
  ];

  /// When, within the entrance, each pin pops and its arc starts drawing.
  static const List<double> _pinAt = [0.18, 0.36, 0.54, 0.72];

  /// How far along its arc a packet is sealed. Past the field's middle, so
  /// the halo reads as "on the way in", never "at the pin".
  static const double _sealAt = 0.58;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.width / _design.width;
    canvas.save();
    canvas.scale(scale);
    canvas.clipRRect(
      RRect.fromRectAndRadius(Offset.zero & _design, const Radius.circular(10)),
    );

    _paintField(canvas);
    final arcs = [for (final pin in _pins) _arcPath(pin)];
    _paintArcs(canvas, arcs);
    _paintWindow(canvas);
    _paintPins(canvas);
    if (entrance >= 1) _paintPackets(canvas, arcs);

    canvas.restore();
  }

  // ── the field ───────────────────────────────────────────────────────────

  void _paintField(Canvas canvas) {
    final dot = Paint()..color = _fade(palette.dot, 0.55);
    for (var y = 5.0; y < _design.height; y += 10) {
      for (var x = 5.0; x < _design.width; x += 10) {
        canvas.drawCircle(Offset(x, y), 0.8, dot);
      }
    }
    // A vignette to the card's own colour: the dots are a field, not a grid
    // with edges, and the window in the middle should sit on the brightest
    // part of it.
    final centre = (Offset.zero & _design).center;
    canvas.drawRect(
      Offset.zero & _design,
      Paint()
        ..shader = ui.Gradient.radial(
          centre,
          _design.width * 0.62,
          [_fade(palette.field, 0), _fade(palette.field, 0), palette.field],
          const [0, 0.42, 1],
        ),
    );
  }

  // ── arcs ────────────────────────────────────────────────────────────────

  Path _arcPath(_Pin pin) => Path()
    ..moveTo(pin.at.dx, pin.at.dy)
    ..cubicTo(
      pin.arc[0].dx,
      pin.arc[0].dy,
      pin.arc[1].dx,
      pin.arc[1].dy,
      pin.arc[2].dx,
      pin.arc[2].dy,
    );

  /// How much of pin [i]'s entrance has played, 0 → 1.
  double _arrival(int i) {
    const span = 0.26;
    return ((entrance - _pinAt[i]) / span).clamp(0.0, 1.0);
  }

  void _paintArcs(Canvas canvas, List<Path> arcs) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..strokeCap = StrokeCap.round
      ..color = palette.arc.withValues(alpha: 0.35);
    for (var i = 0; i < arcs.length; i++) {
      final drawn = Curves.easeOut.transform(_arrival(i));
      if (drawn <= 0) continue;
      for (final metric in arcs[i].computeMetrics()) {
        canvas.drawPath(metric.extractPath(0, metric.length * drawn), paint);
      }
    }
  }

  // ── the window ──────────────────────────────────────────────────────────

  void _paintWindow(Canvas canvas) {
    // Lands first, from slightly below, so the pins have something to aim at.
    final landed = Curves.easeOut.transform((entrance / 0.3).clamp(0.0, 1.0));
    if (landed <= 0) return;
    canvas.save();
    canvas.translate(0, (1 - landed) * 8);
    final rrect = RRect.fromRectAndRadius(_window, const Radius.circular(9));
    // The glow says "here": the one place on the field that is this computer.
    canvas.drawRRect(
      rrect.inflate(1),
      Paint()
        ..color = palette.accent.withValues(alpha: 0.35 * landed)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 14),
    );
    canvas.drawRRect(rrect, Paint()..color = _fade(palette.windowFill, landed));
    canvas.drawRRect(
      rrect,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = palette.accent.withValues(alpha: 0.9 * landed),
    );
    _text(
      canvas,
      '● this Mac · 4 linked',
      Offset(_window.left + 7, _window.top + 6),
      size: 9,
      color: _fade(palette.ink2, landed),
    );
    const names = ['Claude', 'Codex', 'Gemini', '+'];
    final tints = [
      palette.claude,
      palette.codex,
      palette.gemini,
      palette.faint,
    ];
    for (var i = 0; i < _panes.length; i++) {
      final pane = _panes[i];
      final pr = RRect.fromRectAndRadius(pane, const Radius.circular(4));
      canvas.drawRRect(pr, Paint()..color = _fade(palette.paneFill, landed));
      canvas.drawRRect(
        pr,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 0.8
          ..color = _fade(palette.hair, landed),
      );
      _text(
        canvas,
        names[i],
        Offset(pane.left + 5, pane.top + 4),
        size: 8,
        weight: FontWeight.w600,
        color: _fade(tints[i], landed),
      );
      // The flash: the pane a packet has just landed in, fading over an eighth
      // of a cycle. Gated on the entrance so nothing flashes before a packet
      // could have arrived.
      if (entrance >= 1) {
        final since = _sinceLanding(i);
        if (since != null) {
          canvas.drawRRect(
            pr,
            Paint()
              ..color = palette.accent.withValues(
                alpha: 0.28 * (1 - Curves.easeOut.transform(since / 0.12)),
              ),
          );
        }
      }
    }
    canvas.restore();
  }

  /// How far past the landing pin [i]'s packet is, in loop phase, or null if
  /// it is not within the flash window.
  double? _sinceLanding(int i) {
    final phase = _phase(i);
    // A packet lands at 0.9 of its travel (the last tenth is its fade).
    final since = phase - 0.9;
    if (since < 0 || since > 0.12) return null;
    return since;
  }

  // ── pins ────────────────────────────────────────────────────────────────

  void _paintPins(Canvas canvas) {
    for (var i = 0; i < _pins.length; i++) {
      final pin = _pins[i];
      final arrived = Curves.easeOutBack.transform(_arrival(i));
      if (arrived <= 0) continue;
      final alpha = _arrival(i).clamp(0.0, 1.0);
      canvas.save();
      canvas.translate(pin.at.dx, pin.at.dy);
      canvas.scale(arrived);
      // The ring: the pin says "a packet just left me". It runs on the loop,
      // once the field is assembled.
      if (entrance >= 1) {
        final phase = _phase(i);
        if (phase < 0.3) {
          final k = phase / 0.3;
          canvas.drawCircle(
            Offset.zero,
            5 + 9 * Curves.easeOut.transform(k),
            Paint()
              ..style = PaintingStyle.stroke
              ..strokeWidth = 1
              ..color = palette.accent.withValues(alpha: 0.8 * (1 - k)),
          );
        }
      }
      canvas.drawCircle(Offset.zero, 5, Paint()..color = palette.pinFill);
      canvas.drawCircle(
        Offset.zero,
        5,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5
          ..color = palette.pinRim,
      );
      canvas.restore();

      // Labels are laid out in unscaled space and only faded, so the text
      // never renders at a fractional scale mid-pop.
      final nameWidth = _measure(pin.name, size: 10.5, weight: FontWeight.w500);
      final subWidth = _measure(pin.sub, size: 8.5, mono: true);
      final width = math.max(nameWidth, subWidth);
      // Centred on the pin, but never off the field.
      final left = (pin.at.dx - width / 2).clamp(
        6.0,
        _design.width - width - 6,
      );
      final top = pin.labelBelow ? pin.at.dy + 10 : pin.at.dy - 34;
      _text(
        canvas,
        pin.name,
        Offset(left + (width - nameWidth) / 2, top),
        size: 10.5,
        weight: FontWeight.w500,
        color: _fade(palette.ink2, alpha),
      );
      _text(
        canvas,
        pin.sub,
        Offset(left + (width - subWidth) / 2, top + 13),
        size: 8.5,
        mono: true,
        color: _fade(palette.faint, alpha),
      );
    }
  }

  // ── packets ─────────────────────────────────────────────────────────────

  /// Pin [i]'s place in the loop, a quarter of a cycle behind the one before.
  double _phase(int i) => (t - i / 4 + 1) % 1;

  void _paintPackets(Canvas canvas, List<Path> arcs) {
    for (var i = 0; i < arcs.length; i++) {
      final phase = _phase(i);
      // The packet is in flight for the first nine tenths and gone for the
      // last: a beat of nothing before the next one, so a lane is never a
      // conveyor belt.
      if (phase > 0.9) continue;
      final travel = Curves.easeInOut.transform(phase / 0.9);
      final metric = arcs[i].computeMetrics().first;
      final tangent = metric.getTangentForOffset(metric.length * travel);
      if (tangent == null) continue;
      final at = tangent.position;
      // In and out over the first and last tenth of the flight.
      final fade = math.min(phase / 0.09, (0.9 - phase) / 0.09).clamp(0.0, 1.0);
      final sealed = travel >= _sealAt;
      final rect = RRect.fromRectAndRadius(
        Rect.fromCenter(center: at, width: 9, height: 9),
        const Radius.circular(2),
      );
      if (sealed) {
        // The halo grows over the first stretch after the seal, then holds.
        final grown = ((travel - _sealAt) / 0.1).clamp(0.0, 1.0);
        canvas.drawRRect(
          rect.inflate(3 * grown),
          Paint()
            ..color = palette.accent.withValues(
              alpha: palette.haloAlpha * fade * grown,
            )
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 5),
        );
        canvas.drawRRect(
          rect,
          Paint()
            ..color = palette.accent.withValues(
              alpha: palette.flowAlpha * fade,
            ),
        );
      } else {
        canvas.drawRRect(rect, Paint()..color = _fade(palette.raw, 0.9 * fade));
      }
    }
  }

  // ── text ────────────────────────────────────────────────────────────────

  TextPainter _layout(
    String text, {
    required double size,
    FontWeight weight = FontWeight.w400,
    bool mono = false,
    Color color = const Color(0xFFFFFFFF),
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: TextStyle(
          fontFamily: mono ? palette.mono : palette.sans,
          fontFamilyFallback: mono
              ? palette.monoFallback
              : palette.sansFallback,
          fontSize: size,
          fontWeight: weight,
          color: color,
          height: 1.2,
        ),
      ),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      ellipsis: '…',
    )..layout(maxWidth: 160);
    return painter;
  }

  double _measure(
    String text, {
    required double size,
    FontWeight weight = FontWeight.w400,
    bool mono = false,
  }) => _layout(text, size: size, weight: weight, mono: mono).width;

  void _text(
    Canvas canvas,
    String text,
    Offset at, {
    required double size,
    required Color color,
    FontWeight weight = FontWeight.w400,
    bool mono = false,
  }) {
    _layout(
      text,
      size: size,
      weight: weight,
      mono: mono,
      color: color,
    ).paint(canvas, at);
  }

  @override
  bool shouldRepaint(_MapPainter old) =>
      old.t != t || old.entrance != entrance || old.palette != palette;
}
