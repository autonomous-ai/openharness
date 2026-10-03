import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'floating_glass.dart';
import 'tty.dart';
import 'voice_mic_mode.dart';

/// What the mic says it will do when tapped.
enum VoiceMicFace {
  /// At rest: tap to talk.
  talk,

  /// The microphone is opening: tap to call it off.
  starting,

  /// Recording: tap, and what was said is sent. Its bars move with the voice —
  /// what ChatGPT's dictation and Siri do while they listen — and a swipe down
  /// throws the take away.
  listening,

  /// Transcribing: nothing to tap until the words are back.
  busy,

  /// The words are on their way to the terminal: nothing to tap until that is
  /// back.
  sending,

  /// A send just landed: a tick where the arrow was, for a moment, before the
  /// mic is back at rest.
  ///
  /// ⚠️ **Never produced by `voiceMicAction`.** Nothing in the controller says
  /// "sent" — it goes from sending straight back to rest — so [VoiceMicFab]
  /// lays this over [talk] when it sees that happen, and it taps exactly like
  /// [talk], because that is what it is.
  sent,

  /// A send failed and its words are held: tap to send them again.
  retry,

  /// The microphone was refused: tap to ask again.
  off,

  /// Recording with the thumb dragged off the button — letting go now throws
  /// the take away. [VoiceMicMode.holdToTalk] only.
  ///
  /// Its own face rather than a flag on [listening] because it is the opposite
  /// promise: the fill goes to the warning colour and the glyph becomes a `×`.
  /// What is about to happen has to be readable at a glance, by someone whose
  /// thumb is covering the button.
  cancelling,
}

/// What the circle is filled with.
enum _Fill {
  /// The accent: the mic at rest, and everything it can be tapped to do. The
  /// mic is the page's one action, and it is filled like one.
  accent,

  /// The floating buttons' frosted glass: nothing this mic can do right now —
  /// dead, refused, or waiting on the transcription.
  glass,

  /// Letting go throws the take away, and that is not something the accent —
  /// which everywhere else in the app means "go" — should be saying.
  warn,
}

_Fill _fillFor(VoiceMicFace face, {required bool dead}) {
  if (dead) return _Fill.glass;
  // ⚠️ **Flat at rest; filled only while it records.** Over a terminal the mic is a quiet outline
  // in the terminal's own colours — a lit circle sitting on the agent's prompt all day was the
  // loudest thing on the screen. It fills (the terminal's red, a recording light) while a take is
  // live, and that is the one moment it should be loud.
  return switch (face) {
    VoiceMicFace.cancelling => _Fill.warn,
    VoiceMicFace.listening || VoiceMicFace.starting => _Fill.accent,
    VoiceMicFace.busy ||
    VoiceMicFace.off ||
    VoiceMicFace.talk ||
    VoiceMicFace.sending ||
    VoiceMicFace.sent ||
    VoiceMicFace.retry => _Fill.glass,
  };
}

/// The glyph for what a press will do.
enum _Glyph { mic, micOff, send, cancel, check, dots, bars }

_Glyph _glyphFor(VoiceMicFace face) => switch (face) {
  VoiceMicFace.talk || VoiceMicFace.starting => _Glyph.mic,
  // Live bars, not an arrow: a still `↑` read as "send", not as "listening".
  VoiceMicFace.listening => _Glyph.bars,
  VoiceMicFace.busy => _Glyph.dots,
  VoiceMicFace.sending || VoiceMicFace.retry => _Glyph.send,
  VoiceMicFace.sent => _Glyph.check,
  VoiceMicFace.off => _Glyph.micOff,
  VoiceMicFace.cancelling => _Glyph.cancel,
};

/// Whether the arc runs round the inside of the circle: something is under
/// way that the person is waiting on.
bool _spins(VoiceMicFace face) =>
    face == VoiceMicFace.starting ||
    face == VoiceMicFace.busy ||
    face == VoiceMicFace.sending;

/// The round, filled part of the mic: its colour, its glow, and the glyph for
/// what a press will do.
class VoiceMicCore extends StatelessWidget {
  const VoiceMicCore({
    super.key,
    required this.face,
    required this.dead,
    this.working = false,
    this.level,
  });

  /// The microphone's level, 0–1, which the bars follow while it listens. Null draws them idling.
  final ValueListenable<double>? level;

  /// The visible circle's diameter: Siri's orb, near enough. Centred at the foot of Focus it is
  /// the one control on the screen, the way a camera's shutter is — and it is held through a
  /// whole sentence, so it is sized for a thumb, not a fingertip.
  static const double diameter = 72;

  final VoiceMicFace face;

  /// Drawn as a button that cannot be pressed: frosted, not filled.
  final bool dead;

  /// The agent is working: the rim is a 2pt ring in the text's faint ink rather than a hairline —
  /// at the thumb, whose turn it is.
  final bool working;

  static const Duration _morph = Duration(milliseconds: 300);

  @override
  Widget build(BuildContext context) {
    final motion = !MediaQuery.disableAnimationsOf(context);
    final fill = _fillFor(face, dead: dead);
    final tty = Tty.of(context);
    final ink = _inkFor(fill, tty);
    final glyph = _glyphFor(face);
    return FloatingGlass(
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 240),
        curve: Curves.easeOutCubic,
        width: diameter,
        height: diameter,
        decoration: _decoration(fill, tty),
        child: Stack(
          alignment: Alignment.center,
          clipBehavior: Clip.none,
          children: [
            AnimatedOpacity(
              duration: const Duration(milliseconds: 200),
              opacity: _spins(face) ? 1 : 0,
              child: _BusyArc(
                color: fill == _Fill.accent
                    ? tty.onFill(tty.theme.brightWhite)
                    : tty.text,
                spin: motion && _spins(face),
              ),
            ),
            AnimatedSwitcher(
              duration: motion ? _morph : const Duration(milliseconds: 120),
              transitionBuilder: motion
                  ? _morphIn
                  : AnimatedSwitcher.defaultTransitionBuilder,
              child: KeyedSubtree(
                key: ValueKey(glyph),
                child: _glyph(
                  glyph,
                  ink,
                  bob: motion && face == VoiceMicFace.sending,
                  motion: motion,
                  level: level,
                ),
              ),
            ),
            // On the rim, top right — where a badge sits on any icon.
            Positioned(
              top: 1,
              right: 1,
              child: _HeldBadge(shown: face == VoiceMicFace.retry),
            ),
          ],
        ),
      ),
    );
  }

  Color _inkFor(_Fill fill, Tty tty) => switch (fill) {
    _Fill.accent => tty.onFill(tty.theme.black),
    _Fill.warn => tty.onFill(tty.theme.black),
    _Fill.glass => face == VoiceMicFace.off ? tty.dim : tty.text,
  };

  /// ⚠️ **Two different shadows for two different jobs, and the frosted one
  /// is not optional.** Filled, the button glows in its own colour. Frosted, it
  /// casts a plain drop shadow instead: it floats over streaming output rather
  /// than over a surface, and without one its edge disappears against every
  /// dark line it happens to sit on.
  /// Flat, the terminal's way: no gradient, no glow, no shadow — see [_fillFor].
  BoxDecoration _decoration(_Fill fill, Tty tty) {
    if (fill == _Fill.glass) {
      return BoxDecoration(
        shape: BoxShape.circle,
        // The terminal's own ground, near-opaque, so the glyph reads over any line of output.
        color: tty.ground,
        border: working
            ? Border.all(color: tty.faint, width: 2)
            : Border.all(color: tty.dim, width: 1.5),
      );
    }
    // Recording, the face is the send button: green, the colour of go. Red stays on the bar's
    // `●` and its clock, where it means "recording" and nothing else.
    return BoxDecoration(
      shape: BoxShape.circle,
      color: fill == _Fill.warn ? tty.yellow : tty.green,
    );
  }

  static Widget _glyph(
    _Glyph glyph,
    Color ink, {
    required bool bob,
    required bool motion,
    ValueListenable<double>? level,
  }) {
    Icon icon(IconData data) => Icon(data, size: 30, color: ink);
    return switch (glyph) {
      _Glyph.mic => icon(LucideIcons.mic300),
      _Glyph.micOff => icon(LucideIcons.micOff300),
      _Glyph.send => _Bob(active: bob, child: icon(LucideIcons.arrowUp300)),
      _Glyph.cancel => icon(LucideIcons.x300),
      _Glyph.check => icon(LucideIcons.check300),
      _Glyph.dots => _Dots(color: ink, animate: motion),
      _Glyph.bars => _LiveBars(color: ink, level: level, animate: motion),
    };
  }

  /// One glyph turns into the next: the old one shrinks away and the new one
  /// swings up out of it, a little past full size. The press changes what the
  /// button means, and the change is meant to be seen.
  static Widget _morphIn(Widget child, Animation<double> animation) {
    final spring = CurvedAnimation(
      parent: animation,
      curve: Curves.easeOutBack,
    );
    return FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: RotationTransition(
        turns: Tween<double>(begin: -40 / 360, end: 0).animate(spring),
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.5, end: 1).animate(spring),
          child: child,
        ),
      ),
    );
  }
}

/// A short arc running round the inside of the circle while the mic is
/// opening, transcribing or sending.
///
/// ⚠️ Held still, not hidden, under Reduce Motion: the arc still says "under
/// way"; it only stops going round.
class _BusyArc extends StatefulWidget {
  const _BusyArc({required this.color, required this.spin});

  final Color color;
  final bool spin;

  @override
  State<_BusyArc> createState() => _BusyArcState();
}

class _BusyArcState extends State<_BusyArc>
    with SingleTickerProviderStateMixin {
  late final AnimationController _turn = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_BusyArc old) {
    super.didUpdateWidget(old);
    _sync();
  }

  /// ⚠️ Stopped whenever it is not showing. It is always in the tree — so it
  /// can fade rather than blink — and a controller left repeating under an
  /// invisible arc would keep the page drawing frames for nothing.
  void _sync() {
    if (!widget.spin) {
      _turn.stop();
    } else if (!_turn.isAnimating) {
      _turn.repeat();
    }
  }

  @override
  void dispose() {
    _turn.dispose();
    super.dispose();
  }

  // The boundary keeps the turning arc off the glass: without it every frame
  // would repaint the backdrop blur under the whole button.
  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: RotationTransition(
      turns: _turn,
      child: CustomPaint(
        size: const Size.square(VoiceMicCore.diameter - 14),
        painter: _ArcPainter(widget.color),
      ),
    ),
  );
}

class _ArcPainter extends CustomPainter {
  const _ArcPainter(this.color);

  final Color color;

  static const double _stroke = 2.25;

  /// A quarter of the way round, and a little over.
  static const double _sweep = math.pi * 2 * 0.26;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawArc(
      (Offset.zero & size).deflate(_stroke / 2),
      -math.pi / 2,
      _sweep,
      false,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = _stroke
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(_ArcPainter old) => old.color != color;
}

/// Three dots rising in turn: the words are being worked out.
class _Dots extends StatefulWidget {
  const _Dots({required this.color, required this.animate});

  final Color color;
  final bool animate;

  @override
  State<_Dots> createState() => _DotsState();
}

class _DotsState extends State<_Dots> with SingleTickerProviderStateMixin {
  late final AnimationController _beat = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  static const double _dot = 5;
  static const double _gap = 4;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_Dots old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    if (!widget.animate) {
      _beat.stop();
    } else if (!_beat.isAnimating) {
      _beat.repeat();
    }
  }

  @override
  void dispose() {
    _beat.dispose();
    super.dispose();
  }

  /// How far up a dot is at [phase] of its beat: up and down in the first
  /// four fifths, then resting until the next.
  static double _rise(double phase) =>
      phase < 0.8 ? math.sin(math.pi * phase / 0.8) : 0;

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: AnimatedBuilder(
      animation: _beat,
      builder: (context, _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) const SizedBox(width: _gap),
            _dotAt(widget.animate ? _rise((_beat.value - i * 0.14) % 1.0) : 1),
          ],
        ],
      ),
    ),
  );

  Widget _dotAt(double rise) => Transform.translate(
    offset: Offset(0, widget.animate ? -4 * rise : 0),
    child: Container(
      width: _dot,
      height: _dot,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: widget.color.withValues(
          alpha: widget.color.a * (0.45 + 0.55 * rise),
        ),
      ),
    ),
  );
}

/// Five bars that move with the voice while the mic listens: short at silence, tall when loud,
/// each on its own phase so they never move as one block. They idle gently when there is no
/// level to follow, so the mic never looks frozen while it is recording.
class _LiveBars extends StatefulWidget {
  const _LiveBars({
    required this.color,
    required this.level,
    required this.animate,
  });

  final Color color;
  final ValueListenable<double>? level;
  final bool animate;

  @override
  State<_LiveBars> createState() => _LiveBarsState();
}

class _LiveBarsState extends State<_LiveBars>
    with SingleTickerProviderStateMixin {
  late final AnimationController _wave = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1000),
  );

  /// The level, eased toward what the microphone reports, so the bars glide.
  double _shown = 0;

  static const _weights = [0.55, 0.85, 1.0, 0.8, 0.5];
  static const double _bar = 4;
  static const double _gap = 4;
  static const double _low = 5;
  static const double _high = 30;

  @override
  void initState() {
    super.initState();
    if (widget.animate) unawaited(_wave.repeat());
  }

  @override
  void didUpdateWidget(_LiveBars old) {
    super.didUpdateWidget(old);
    if (widget.animate && !_wave.isAnimating) unawaited(_wave.repeat());
    if (!widget.animate) _wave.stop();
  }

  @override
  void dispose() {
    _wave.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: AnimatedBuilder(
      animation: _wave,
      builder: (context, _) {
        final target = (widget.level?.value ?? 0.15).clamp(0.0, 1.0);
        _shown += (target - _shown) * 0.35;
        return Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            for (var i = 0; i < _weights.length; i++) ...[
              if (i > 0) const SizedBox(width: _gap),
              Container(
                width: _bar,
                height: _heightOf(i),
                decoration: BoxDecoration(
                  color: widget.color,
                  borderRadius: BorderRadius.circular(_bar / 2),
                ),
              ),
            ],
          ],
        );
      },
    ),
  );

  double _heightOf(int i) {
    // A breath of motion always, more of it the louder the voice.
    final phase = math.sin(2 * math.pi * (_wave.value + i * 0.18));
    final swing = 0.18 + 0.82 * _shown;
    final amount = (_weights[i] * swing * (0.75 + 0.25 * phase)).clamp(
      0.0,
      1.0,
    );
    return _low + (_high - _low) * amount;
  }
}

/// The send arrow, nudging upward while the words are on their way.
class _Bob extends StatefulWidget {
  const _Bob({required this.active, required this.child});

  final bool active;
  final Widget child;

  @override
  State<_Bob> createState() => _BobState();
}

class _BobState extends State<_Bob> with SingleTickerProviderStateMixin {
  late final AnimationController _lift = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 450),
  );
  late final Animation<double> _eased = CurvedAnimation(
    parent: _lift,
    curve: Curves.easeInOut,
  );

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_Bob old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    if (!widget.active) {
      _lift
        ..stop()
        ..value = 0;
    } else if (!_lift.isAnimating) {
      _lift.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _lift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _eased,
    child: widget.child,
    builder: (context, child) => Transform.translate(
      offset: Offset(0, widget.active ? 1 - 4 * _eased.value : 0),
      child: child,
    ),
  );
}

/// The amber dot on the rim of the retry face: the last send did not land and
/// its words are still here.
class _HeldBadge extends StatelessWidget {
  const _HeldBadge({required this.shown});

  final bool shown;

  static const double size = 13;

  @override
  Widget build(BuildContext context) => AnimatedScale(
    duration: const Duration(milliseconds: 300),
    curve: shown ? Curves.easeOutBack : Curves.easeIn,
    scale: shown ? 1 : 0,
    child: Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: AppPalette.warn,
        // A ring the terminal's own near-black, so the dot reads as sitting
        // ON the rim rather than as a stain on the fill — its ground, on a
        // light one.
        border: Border.all(
          color: Tty.of(context).isLight
              ? Tty.of(context).ground
              : const Color(0xFF141414),
          width: 2,
        ),
      ),
    ),
  );
}
