import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'floating_glass.dart';
import 'voice_mic_mode.dart';

/// What the mic says it will do when tapped.
enum VoiceMicFace {
  /// At rest: tap to talk.
  talk,

  /// The microphone is opening: tap to call it off.
  starting,

  /// Recording: tap, and what was said is sent. The waveform in the capsule
  /// beside it is what shows it listening — see `voice_take_meter.dart`.
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
  return switch (face) {
    VoiceMicFace.cancelling => _Fill.warn,
    VoiceMicFace.busy || VoiceMicFace.off => _Fill.glass,
    VoiceMicFace.talk ||
    VoiceMicFace.starting ||
    VoiceMicFace.listening ||
    VoiceMicFace.sending ||
    VoiceMicFace.sent ||
    VoiceMicFace.retry => _Fill.accent,
  };
}

/// The glyph for what a press will do.
enum _Glyph { mic, micOff, send, cancel, check, dots }

_Glyph _glyphFor(VoiceMicFace face) => switch (face) {
  VoiceMicFace.talk || VoiceMicFace.starting => _Glyph.mic,
  // ⚠️ The arrow only in the tap mode, where the next tap IS the send — the
  // fill no longer says so, because the mic is filled at rest too. In
  // hold-to-talk the arrow would be a lie: nothing is sent by pressing, it is
  // sent by letting go, and the thumb never leaves the button to press again.
  VoiceMicFace.listening => micHoldsToTalk ? _Glyph.mic : _Glyph.send,
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
  const VoiceMicCore({super.key, required this.face, required this.dead});

  /// The visible circle's diameter — and the voice capsule's height, so the
  /// circle closes the capsule's right end. See `voice_status_pill.dart`.
  static const double diameter = 52;

  final VoiceMicFace face;

  /// Drawn as a button that cannot be pressed: frosted, not filled.
  final bool dead;

  static const Duration _morph = Duration(milliseconds: 300);

  @override
  Widget build(BuildContext context) {
    final motion = !MediaQuery.disableAnimationsOf(context);
    final fill = _fillFor(face, dead: dead);
    final ink = _inkFor(fill);
    final glyph = _glyphFor(face);
    return FloatingGlass(
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 240),
        curve: Curves.easeOutCubic,
        width: diameter,
        height: diameter,
        decoration: _decoration(fill),
        child: Stack(
          alignment: Alignment.center,
          clipBehavior: Clip.none,
          children: [
            AnimatedOpacity(
              duration: const Duration(milliseconds: 200),
              opacity: _spins(face) ? 1 : 0,
              child: _BusyArc(
                color: fill == _Fill.accent
                    ? Colors.white.withValues(alpha: 0.9)
                    : AppPalette.accentOnSurface,
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

  Color _inkFor(_Fill fill) => switch (fill) {
    _Fill.accent => Colors.white,
    // White on the dark theme's bright amber is 2:1; dark ink there, white on
    // the light theme's deep one.
    _Fill.warn => AppTheme.pick(Colors.white, const Color(0xFF241800)),
    _Fill.glass =>
      face == VoiceMicFace.off
          ? AppPalette.textFaint
          : face == VoiceMicFace.busy
          ? AppPalette.accentOnSurface
          : AppPalette.textPrimary,
  };

  /// ⚠️ **Two different shadows for two different jobs, and the frosted one
  /// is not optional.** Filled, the button glows in its own colour. Frosted, it
  /// casts a plain drop shadow instead: it floats over streaming output rather
  /// than over a surface, and without one its edge disappears against every
  /// dark line it happens to sit on.
  BoxDecoration _decoration(_Fill fill) {
    if (fill == _Fill.glass) {
      return BoxDecoration(
        shape: BoxShape.circle,
        color: floatingButtonFill,
        border: Border.all(color: floatingButtonRim),
        // ⚠️ Kept light: a box shadow paints under the WHOLE circle, and the
        // fill is not opaque — a heavy one showed through as a dark disc.
        boxShadow: floatingButtonShadow,
      );
    }
    final tint = fill == _Fill.warn ? AppPalette.warn : AppPalette.accent;
    return BoxDecoration(
      shape: BoxShape.circle,
      gradient: LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color.lerp(tint, Colors.white, 0.18)!, tint],
      ),
      border: Border.all(color: Colors.white.withValues(alpha: 0.28)),
      boxShadow: [
        BoxShadow(color: tint.withValues(alpha: 0.4), blurRadius: 12),
        // The lift, under the glow. The glow does not separate the circle from
        // the text behind it: it is the same brightness as the accent the
        // terminal itself uses.
        BoxShadow(
          color: Colors.black.withValues(alpha: 0.35),
          blurRadius: 10,
          offset: const Offset(0, 3),
        ),
      ],
    );
  }

  static Widget _glyph(
    _Glyph glyph,
    Color ink, {
    required bool bob,
    required bool motion,
  }) {
    Icon icon(IconData data) => Icon(data, size: 25, color: ink);
    return switch (glyph) {
      _Glyph.mic => icon(LucideIcons.mic300),
      _Glyph.micOff => icon(LucideIcons.micOff300),
      _Glyph.send => _Bob(active: bob, child: icon(LucideIcons.arrowUp300)),
      _Glyph.cancel => icon(LucideIcons.x300),
      _Glyph.check => icon(LucideIcons.check300),
      _Glyph.dots => _Dots(color: ink, animate: motion),
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
        size: const Size.square(44),
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
        // ON the rim rather than as a stain on the fill.
        border: Border.all(color: const Color(0xFF141414), width: 2),
      ),
    ),
  );
}
