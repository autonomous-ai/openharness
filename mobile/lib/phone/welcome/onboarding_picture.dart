import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../tty.dart';

/// What the onboarding's one picture shows: three computers around a phone.
///
/// ```
/// welcome   all three lit, an agent typing on each, packets running to the phone — the promise
/// looking   three dashed outlines, the laptop breathing, rings going out from the phone
/// joined    the laptop lit and linked, the others faded, the phone bright
/// ```
enum OnboardingScene { welcome, looking, joined }

/// The onboarding's picture — `docs/research/2026-10-11-phone-onboarding`, drawn on the spec's own
/// 320 × 300 grid so its coordinates read straight across from the page's SVGs.
///
/// ⚠️ **One picture, in the same place on every screen; only its state changes.** A new [scene]
/// eases from the one before (400ms, a 200ms fade under Reduce Motion). A screen that takes over
/// from another — the welcome handing over to "On your computer, go to" when the phone signs in, a
/// different widget tree — passes [enterFrom], so the picture still reads as the same one changing.
///
/// [join] drives the computer joining (`scene: joined`), 0 → 1 over [joinLength]:
///
/// ```
///   0 ms  the laptop's outline draws itself solid
/// 350 ms  the link draws from the laptop to the phone
/// 600 ms  the laptop's screen lights
/// 800 ms  the agent's name appears on it; the first packet lands on the phone, which brightens
/// ```
///
/// Without [join], a joined picture is drawn already joined. The haptics and the sound that go
/// with those beats are the caller's: this only draws.
///
/// Reduce Motion: no packets, no rings, no breathing (held at its peak, as [Pulse] holds), a steady
/// cursor, and every change a 200ms fade.
class OnboardingPicture extends StatefulWidget {
  const OnboardingPicture({
    super.key,
    required this.scene,
    this.enterFrom,
    this.agent,
    this.join,
  });

  final OnboardingScene scene;

  /// The scene the screen before this one showed: the picture eases from it on its first frame.
  final OnboardingScene? enterFrom;

  /// The agent typing on the laptop once it has joined — `opencode`, `claude`. Null draws only the
  /// cursor.
  final String? agent;

  /// The join's progress, 0 → 1 over [joinLength] — see the class comment.
  final Animation<double>? join;

  /// How long [join] runs, from the outline's first stroke to the phone brightening.
  static const joinLength = Duration(milliseconds: 1000);

  @override
  State<OnboardingPicture> createState() => _OnboardingPictureState();
}

class _OnboardingPictureState extends State<OnboardingPicture>
    with TickerProviderStateMixin {
  late final AnimationController _blend = AnimationController(
    vsync: this,
    duration: _blendLength,
    value: 1,
  );

  /// Seconds since the picture came up: the packets', rings', breath's and cursor's clock.
  final _clock = ValueNotifier<double>(0);
  late final Ticker _ticker = createTicker(
    (elapsed) => _clock.value = elapsed.inMicroseconds / 1e6,
  );

  late _Look _from = _Look.of(widget.enterFrom ?? widget.scene);
  late _Look _to = _Look.of(widget.scene);
  bool _still = false;

  static const _blendLength = Duration(milliseconds: 400);
  static const _stillBlendLength = Duration(milliseconds: 200);

  @override
  void initState() {
    super.initState();
    if (widget.enterFrom case final from? when from != widget.scene) {
      _blend.forward(from: 0);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    _blend.duration = _still ? _stillBlendLength : _blendLength;
    if (_still) {
      if (_ticker.isActive) _ticker.stop();
    } else if (!_ticker.isActive) {
      _ticker.start();
    }
  }

  @override
  void didUpdateWidget(covariant OnboardingPicture oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scene != widget.scene) {
      // From wherever it is now — a scene changed mid-ease does not jump back to its start.
      _from = _Look.lerp(_from, _to, _blend.value);
      _to = _Look.of(widget.scene);
      _blend.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    _blend.dispose();
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final join = widget.join;
    return ExcludeSemantics(
      child: RepaintBoundary(
        child: CustomPaint(
          size: Size.infinite,
          painter: _PicturePainter(
            from: _from,
            to: _to,
            blend: _blend,
            clock: _clock,
            join: widget.scene == OnboardingScene.joined ? join : null,
            joined: widget.scene == OnboardingScene.joined,
            welcome: widget.scene == OnboardingScene.welcome,
            agent: widget.agent,
            still: _still,
            colors: _Colors.of(tty),
            text: tty.style(size: 9),
          ),
        ),
      ),
    );
  }
}

/// The picture's colours, from the terminal's own: its text for outlines, its green for what is
/// alive, its ground for the phone's body — so it is at home on Mist as on the dark default.
@immutable
class _Colors {
  const _Colors({
    required this.ink,
    required this.green,
    required this.packet,
    required this.ground,
    required this.dotted,
  });

  factory _Colors.of(Tty tty) => _Colors(
    ink: tty.text,
    green: tty.green,
    // A packet is the green at its brightest: lifted toward white on a dark ground, the green
    // itself on a light one, where lifting it would wash it out.
    packet: tty.isLight
        ? tty.green
        : Color.lerp(tty.green, Colors.white, 0.45)!,
    ground: tty.ground,
    dotted: tty.dim,
  );

  final Color ink;
  final Color green;
  final Color packet;
  final Color ground;
  final Color dotted;

  @override
  bool operator ==(Object other) =>
      other is _Colors &&
      other.ink == ink &&
      other.green == green &&
      other.packet == packet &&
      other.ground == ground &&
      other.dotted == dotted;

  @override
  int get hashCode => Object.hash(ink, green, packet, ground, dotted);
}

/// One scene's values, per computer — laptop, monitor, server — so two scenes ease into each other
/// by plain interpolation.
@immutable
class _Look {
  const _Look({
    required this.lit,
    required this.ghost,
    required this.link,
    required this.dotted,
    required this.breath,
    required this.rings,
    required this.phone,
  });

  /// 1: drawn solid, its screen green, its glow under it, its agent typing. 0: a dashed outline.
  final List<double> lit;

  /// The dashed outline's opacity, where it is not [lit].
  final List<double> ghost;

  /// The link to the phone, solid green.
  final List<double> link;

  /// The link to the phone, a grey dotted line: the way it would go.
  final List<double> dotted;

  /// How much the laptop's dashed outline breathes — looking for it.
  final double breath;

  /// The rings going out from the phone.
  final double rings;

  /// The phone brightened: its glow, screen and lines up.
  final double phone;

  static const welcome = _Look(
    lit: [1, 1, 1],
    ghost: [0, 0, 0],
    link: [1, 1, 1],
    dotted: [0, 0, 0],
    breath: 0,
    rings: 0,
    phone: 0,
  );

  static const looking = _Look(
    lit: [0, 0, 0],
    ghost: [.3, .3, .3],
    link: [0, 0, 0],
    dotted: [1, 1, 1],
    breath: 1,
    rings: 1,
    phone: 0,
  );

  static const joined = _Look(
    lit: [1, 0, 0],
    ghost: [0, .2, .2],
    link: [1, 0, 0],
    dotted: [0, 0, 0],
    breath: 0,
    rings: 0,
    phone: 1,
  );

  static _Look of(OnboardingScene scene) => switch (scene) {
    OnboardingScene.welcome => welcome,
    OnboardingScene.looking => looking,
    OnboardingScene.joined => joined,
  };

  static _Look lerp(_Look a, _Look b, double t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    List<double> each(List<double> x, List<double> y) => [
      for (var i = 0; i < x.length; i++) _mix(x[i], y[i], t),
    ];
    return _Look(
      lit: each(a.lit, b.lit),
      ghost: each(a.ghost, b.ghost),
      link: each(a.link, b.link),
      dotted: each(a.dotted, b.dotted),
      breath: _mix(a.breath, b.breath, t),
      rings: _mix(a.rings, b.rings, t),
      phone: _mix(a.phone, b.phone, t),
    );
  }
}

double _mix(double a, double b, double t) => a + (b - a) * t;

/// [value] from [start] to [end] as 0 → 1, held at either end.
double _span(double value, double start, double end) =>
    ((value - start) / (end - start)).clamp(0.0, 1.0);

/// The spec's grid, and everything drawn on it.
abstract final class _Grid {
  static const size = Size(320, 300);

  /// The phone's centre — where the rings start.
  static const phoneCentre = Offset(160, 157);

  static Path _box(double x, double y, double w, double h, double r) =>
      Path()..addRRect(RRect.fromLTRBR(x, y, x + w, y + h, Radius.circular(r)));

  /// Each computer's outline, its inner screen, and what it stands on — laptop, monitor, server.
  static final outlines = <List<Path>>[
    [
      _box(14, 22, 98, 64, 6),
      Path()
        ..moveTo(4, 90)
        ..relativeLineTo(118, 0)
        ..relativeLineTo(-8, 7)
        ..relativeLineTo(-102, 0)
        ..close(),
    ],
    [
      _box(208, 18, 98, 64, 6),
      Path()
        ..moveTo(257, 82)
        ..relativeLineTo(0, 12)
        ..moveTo(240, 96)
        ..relativeLineTo(34, 0),
    ],
    [
      _box(108, 232, 104, 23, 4),
      _box(108, 255, 104, 23, 4),
      Path()
        ..moveTo(118, 285)
        ..relativeLineTo(84, 0),
    ],
  ];

  /// The two screens, drawn at half the outline's ink and filled green when lit. The server has none.
  static final screens = <RRect?>[
    RRect.fromLTRBR(20, 28, 106, 80, const Radius.circular(3)),
    RRect.fromLTRBR(214, 24, 300, 76, const Radius.circular(3)),
    null,
  ];

  static final dashedOutlines = [
    for (final (i, paths) in outlines.indexed)
      _dash(
        [...paths, if (screens[i] case final s?) Path()..addRRect(s)],
        3,
        3,
      ),
  ];

  /// The glow each lit computer sits on: centre, radii, opacity.
  static const glows = <(Offset, double, double, double)>[
    (Offset(62, 100), 54, 8, .22),
    (Offset(257, 98), 48, 7, .18),
    (Offset(160, 288), 56, 7, .18),
  ];

  /// The server's two lights.
  static const lights = [Offset(200, 244), Offset(200, 266)];

  /// Each computer's link to the phone.
  static final links = <Path>[
    Path()
      ..moveTo(96, 98)
      ..quadraticBezierTo(120, 116, 136, 140),
    Path()
      ..moveTo(240, 98)
      ..quadraticBezierTo(204, 116, 184, 140),
    Path()
      ..moveTo(160, 232)
      ..lineTo(160, 206),
  ];

  /// Each link measured once, for the packets riding it every frame.
  static final linkMetrics = [
    for (final link in links) link.computeMetrics().first,
  ];

  static final dottedLinks = [
    for (final link in links) _dash([link], 1.2, 4),
  ];

  /// The faint lines between the computers: one account, every device seeing every other.
  static final between = _dash(
    [
      Path()
        ..moveTo(112, 50)
        ..lineTo(208, 48),
      Path()
        ..moveTo(60, 100)
        ..lineTo(132, 232),
      Path()
        ..moveTo(260, 98)
        ..lineTo(188, 232),
    ],
    2,
    5,
  );

  /// What each computer's agents type in the welcome: text, where its baseline starts, and whether
  /// the cursor follows it.
  static const typing = <List<(String, Offset, bool)>>[
    [('claude', Offset(26, 44), true), ('codex', Offset(26, 56), false)],
    [('opencode', Offset(219, 42), true)],
    [('codex', Offset(122, 247), true)],
  ];

  /// Where the joined laptop's agent types.
  static const joinedTyping = Offset(26, 44);

  static final phoneBody = RRect.fromLTRBR(
    136,
    110,
    184,
    204,
    const Radius.circular(10),
  );
  static final phoneScreen = RRect.fromLTRBR(
    141,
    119,
    179,
    193,
    const Radius.circular(5),
  );
  static final phoneNotch = RRect.fromLTRBR(
    154,
    113.5,
    166,
    116.5,
    const Radius.circular(1.5),
  );

  /// The phone's lines of text: their widths, from x 146, every 8 down from y 128.
  static const phoneLines = <double>[22, 16, 26, 12, 20];

  static Path _dash(List<Path> paths, double on, double off) {
    final out = Path();
    for (final path in paths) {
      for (final metric in path.computeMetrics()) {
        for (var d = 0.0; d < metric.length; d += on + off) {
          out.addPath(
            metric.extractPath(d, math.min(d + on, metric.length)),
            Offset.zero,
          );
        }
      }
    }
    return out;
  }
}

class _PicturePainter extends CustomPainter {
  _PicturePainter({
    required this.from,
    required this.to,
    required this.blend,
    required this.clock,
    required this.join,
    required this.joined,
    required this.welcome,
    required this.agent,
    required this.still,
    required this.colors,
    required this.text,
  }) : super(repaint: Listenable.merge([blend, clock, ?join]));

  final _Look from;
  final _Look to;
  final Animation<double> blend;
  final ValueNotifier<double> clock;
  final Animation<double>? join;
  final bool joined;
  final bool welcome;
  final String? agent;
  final bool still;
  final _Colors colors;
  final TextStyle text;

  static const _stroke = 1.5;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = math.min(
      size.width / _Grid.size.width,
      size.height / _Grid.size.height,
    );
    if (scale <= 0 || !scale.isFinite) return;
    canvas
      ..save()
      ..translate(
        (size.width - _Grid.size.width * scale) / 2,
        (size.height - _Grid.size.height * scale) / 2,
      )
      ..scale(scale);

    final t = clock.value;
    final look = _Look.lerp(from, to, blend.value);
    // The join, in milliseconds; settled (all of it done) when nothing drives it.
    final ms = joined ? (join?.value ?? 1) * 1000 : double.infinity;
    final driven = joined && join != null;

    // The laptop's own values while it joins come from the join's beats, not the ease: its outline
    // and link DRAW themselves. Anything else that changes — a scene easing into another — fades.
    // Under Reduce Motion the join is a fade too: everything of the laptop's comes up together, in
    // 200ms, as its screen lights.
    final fadeIn = _span(ms, 600, 800);
    final outline = driven && !still ? _span(ms, 0, 350) : 1.0;
    final laptopSolid = !driven ? look.lit[0] : (still ? fadeIn : 1.0);
    final linkDrawn = driven && !still ? _span(ms, 350, 600) : 1.0;
    final linkAlpha = !driven ? look.link[0] : (still ? fadeIn : 1.0);
    final screenLit = !driven
        ? look.lit[0]
        : (still ? fadeIn : _span(ms, 600, 750));
    final phone = driven ? _span(ms, 800, 1000) : look.phone;

    _paintBetween(canvas);
    if (!still) _paintRings(canvas, look.rings, t);

    for (var i = 0; i < 3; i++) {
      _paintLink(
        canvas,
        i,
        drawn: i == 0 ? linkDrawn : 1,
        alpha: i == 0 ? linkAlpha : look.link[i],
        dotted: look.dotted[i],
      );
    }
    if (!still) _paintPackets(canvas, look, t, ms, driven: driven);

    for (var i = 0; i < 3; i++) {
      var ghost = look.ghost[i];
      if (i == 0 && look.breath > 0) {
        // Looking: the laptop breathes, .25 ↔ .6 every 2.4s — held at its peak when still.
        final wave = still ? 1.0 : (1 - math.cos(t / 2.4 * 2 * math.pi)) / 2;
        ghost = _mix(ghost, .25 + .35 * wave, look.breath);
      }
      if (i == 0 && driven) {
        // The dashed laptop gives way to the solid one as it draws — or fades in.
        ghost = math.max(ghost, .3 * (1 - (still ? laptopSolid : outline)));
      }
      _paintComputer(
        canvas,
        i,
        drawn: i == 0 ? outline : 1,
        solid: i == 0 ? laptopSolid : look.lit[i],
        lit: i == 0 ? screenLit : look.lit[i],
        ghost: ghost,
      );
    }
    _paintTyping(canvas, look, t, ms, laptop: screenLit);
    _paintPhone(canvas, phone);
    canvas.restore();
  }

  void _paintBetween(Canvas canvas) {
    canvas.drawPath(
      _Grid.between,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..color = colors.ink.withValues(alpha: .07),
    );
  }

  /// Three rings out from the phone, 2.4s each, a third apart.
  void _paintRings(Canvas canvas, double rings, double t) {
    if (rings <= 0) return;
    for (var k = 0; k < 3; k++) {
      final p = ((t - k * .8) % 2.4) / 2.4;
      if (t < k * .8) continue;
      canvas.drawCircle(
        _Grid.phoneCentre,
        _mix(8, 120, p),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2
          ..color = colors.green.withValues(alpha: .55 * (1 - p) * rings),
      );
    }
  }

  /// A link to the phone: [drawn] is how much of it has drawn itself (the join), [alpha] how much
  /// of it is there at all (a scene easing in or out).
  void _paintLink(
    Canvas canvas,
    int i, {
    required double drawn,
    required double alpha,
    required double dotted,
  }) {
    if (dotted > 0) {
      canvas.drawPath(
        _Grid.dottedLinks[i],
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.4
          ..strokeCap = StrokeCap.round
          ..color = colors.dotted.withValues(alpha: dotted),
      );
    }
    if (drawn > 0 && alpha > 0) {
      canvas.drawPath(
        _part(_Grid.links[i], drawn),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.6
          ..strokeCap = StrokeCap.round
          ..color = colors.green.withValues(alpha: .45 * alpha),
      );
    }
  }

  /// The packets running down the links. In the welcome, one on each link every 1.4s, out for the
  /// first half and gone for the second, a third of a beat apart. Joined, one after another down the
  /// laptop's link every 0.7s — and while it joins, the first one leaves as the screen lights and
  /// lands as the phone brightens.
  void _paintPackets(
    Canvas canvas,
    _Look look,
    double t,
    double ms, {
    required bool driven,
  }) {
    if (welcome) {
      const begins = [0.0, .47, .93];
      for (var i = 0; i < 3; i++) {
        if (look.link[i] < 1 || t < begins[i]) continue;
        final p = ((t - begins[i]) % 1.4) / 1.4;
        if (p >= .5) continue;
        _packet(canvas, i, p / .5, look.lit[i]);
      }
      return;
    }
    if (!joined) return;
    if (driven && ms < 800) {
      if (ms >= 600) _packet(canvas, 0, _span(ms, 600, 800), 1);
      return;
    }
    _packet(canvas, 0, (t % .7) / .7, look.link[0]);
  }

  void _packet(Canvas canvas, int link, double along, double alpha) {
    if (alpha <= 0) return;
    final metric = _Grid.linkMetrics[link];
    final at = metric.getTangentForOffset(metric.length * along)?.position;
    if (at == null) return;
    canvas
      ..drawCircle(
        at,
        4.2,
        Paint()
          ..color = colors.packet.withValues(alpha: .55 * alpha)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.6),
      )
      ..drawCircle(
        at,
        2.6,
        Paint()..color = colors.packet.withValues(alpha: alpha),
      );
  }

  /// A computer: [drawn] is how much of its solid outline has drawn itself (the join), [solid] how
  /// much of that outline is there (a scene easing), [lit] its screen, glow and lights, [ghost] its
  /// dashed outline.
  void _paintComputer(
    Canvas canvas,
    int i, {
    required double drawn,
    required double solid,
    required double lit,
    required double ghost,
  }) {
    final (centre, rx, ry, glow) = _Grid.glows[i];
    if (lit > 0) {
      canvas.drawOval(
        Rect.fromCenter(center: centre, width: rx * 2, height: ry * 2),
        Paint()
          ..color = colors.green.withValues(alpha: glow * lit)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6),
      );
    }
    if (ghost > 0) {
      canvas.drawPath(
        _Grid.dashedOutlines[i],
        _line(colors.ink.withValues(alpha: ghost)),
      );
    }
    if (drawn > 0 && solid > 0) {
      final ink = _line(colors.ink.withValues(alpha: solid));
      for (final path in _Grid.outlines[i]) {
        canvas.drawPath(_part(path, drawn), ink);
      }
      if (_Grid.screens[i] case final screen?) {
        canvas.drawPath(
          _part(Path()..addRRect(screen), drawn),
          _line(colors.ink.withValues(alpha: .5 * solid)),
        );
      }
    }
    if (lit > 0) {
      if (_Grid.screens[i] case final screen?) {
        canvas.drawRRect(
          screen,
          Paint()..color = colors.green.withValues(alpha: .10 * lit),
        );
      }
      if (i == 2) {
        for (final light in _Grid.lights) {
          canvas.drawCircle(
            light,
            1.7,
            Paint()..color = colors.green.withValues(alpha: lit),
          );
        }
      }
    }
  }

  /// The agents typing — on all three in the welcome, on the laptop once it has joined (from the
  /// join's 800ms), each line ending in the blinking block cursor.
  void _paintTyping(
    Canvas canvas,
    _Look look,
    double t,
    double ms, {
    required double laptop,
  }) {
    final blinkOn = still || (t % 1) < .5;
    void type(String word, Offset baseline, bool cursor, double alpha) {
      if (alpha <= 0) return;
      final green = colors.green.withValues(alpha: alpha);
      var end = baseline.dx;
      if (word.isNotEmpty) {
        final painter = TextPainter(
          text: TextSpan(
            text: word,
            style: text.copyWith(color: green),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        final ascent = painter.computeDistanceToActualBaseline(
          TextBaseline.alphabetic,
        );
        painter.paint(canvas, baseline - Offset(0, ascent));
        end += painter.width + 1.8;
        painter.dispose();
      } else {
        end += 1.5;
      }
      if (cursor && blinkOn) {
        canvas.drawRect(
          Rect.fromLTWH(end, baseline.dy - 7, 4.6, 8),
          Paint()..color = green,
        );
      }
    }

    if (joined) {
      final shown = ms >= 800 ? (agent ?? '') : '';
      type(shown, _Grid.joinedTyping, true, laptop);
      return;
    }
    for (var i = 0; i < 3; i++) {
      for (final (word, baseline, cursor) in _Grid.typing[i]) {
        type(word, baseline, cursor, look.lit[i]);
      }
    }
  }

  void _paintPhone(Canvas canvas, double phone) {
    canvas
      ..drawOval(
        Rect.fromCenter(center: const Offset(160, 206), width: 68, height: 12),
        Paint()
          ..color = colors.green.withValues(alpha: _mix(.14, .28, phone))
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6),
      )
      ..drawRRect(_Grid.phoneBody, Paint()..color = colors.ground)
      ..drawRRect(
        _Grid.phoneBody,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.6
          ..color = colors.ink,
      )
      ..drawRRect(
        _Grid.phoneScreen,
        Paint()..color = colors.green.withValues(alpha: _mix(.05, .10, phone)),
      )
      ..drawRRect(
        _Grid.phoneNotch,
        Paint()..color = colors.ink.withValues(alpha: .6),
      );
    final line = Paint()
      ..color = colors.green.withValues(alpha: _mix(.85, 1, phone));
    for (final (k, width) in _Grid.phoneLines.indexed) {
      canvas.drawRRect(
        RRect.fromLTRBR(
          146,
          128 + k * 8.0,
          146 + width,
          130.4 + k * 8.0,
          const Radius.circular(1.2),
        ),
        line,
      );
    }
  }

  static Paint _line(Color color) => Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = _stroke
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round
    ..color = color;

  /// The first [fraction] of each of [path]'s strokes — every stroke drawing itself at once.
  static Path _part(Path path, double fraction) {
    if (fraction >= 1) return path;
    final out = Path();
    for (final metric in path.computeMetrics()) {
      out.addPath(metric.extractPath(0, metric.length * fraction), Offset.zero);
    }
    return out;
  }

  @override
  bool shouldRepaint(covariant _PicturePainter old) =>
      old.from != from ||
      old.to != to ||
      old.blend != blend ||
      old.clock != clock ||
      old.join != join ||
      old.joined != joined ||
      old.welcome != welcome ||
      old.agent != agent ||
      old.still != still ||
      old.colors != colors ||
      old.text != text;
}
