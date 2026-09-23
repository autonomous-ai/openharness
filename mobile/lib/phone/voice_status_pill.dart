import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/pulse.dart';

import 'voice_input_controller.dart';
import 'voice_mic_action.dart';
import 'voice_mic_face.dart';
import 'voice_mic_mode.dart';
import 'voice_take_meter.dart';

/// The body of the voice capsule: what the mic is doing, and the `×` that calls
/// it off.
///
/// ```
///   ( ×  ●  ▂▃▅▇▅▃▂▁▃▆  0:07  (↑) )    listening
///   ( ×  Transcribing…        (•••) )
///   ( ×  ⓘ Didn't catch that. Tap (🎤) )
///   (      the mic to try again.      )
/// ```
///
/// ⚠️ **It sits BEHIND the mic, and the mic closes its right end.** The column
/// stacks the mic over this body's last [micClearance] points, so the two read
/// as one control that changes shape — growing out from behind the button to
/// say what it is doing, and tucking back behind it when there is nothing to
/// say. The `×` is at the far end, away from the thumb that works the mic.
///
/// The `×` is the way out of every step: while the mic is opening, recording
/// or transcribing it throws the take away, with words held from a failed send
/// it drops them, and with a notice up it dismisses it.
///
/// ⚠️ **Nothing at rest.** The body exists only while there is something to
/// read; one that stayed would sit over the terminal's newest lines.
///
/// ⚠️ **Tucking in and out is PAINTED, never laid out.** The body takes its
/// full size on the first frame and only its drawing grows from behind the
/// mic — see [_CapsuleReveal]. Laid out, the `×` would spend the first frames
/// of every take with no width to be pressed in; changes of content once it is
/// out are laid out ([AnimatedSize]), since by then the `×` is already there.
class VoiceStatusPill extends StatefulWidget {
  const VoiceStatusPill({
    super.key,
    required this.voice,
    this.slipped,
    this.micClearance = 0,
  });

  final VoiceInputController voice;

  /// Whether a hold has been dragged off the mic, as the mic reports it —
  /// [VoiceMicMode.holdToTalk] only. The thumb covers the button's own `×`
  /// face, so this body is what says letting go will now cancel. Null where
  /// nothing reports it.
  final ValueListenable<bool>? slipped;

  /// How much of the body's right end the mic sits over. Zero for a body that
  /// stands on its own.
  final double micClearance;

  /// The body's least height: the mic's circle, so the circle closes its end.
  static const double height = VoiceMicCore.diameter;

  @override
  State<VoiceStatusPill> createState() => _VoiceStatusPillState();
}

/// What the body is saying, one of a handful of shapes.
enum _Kind {
  starting,
  listening,
  transcribing,
  sending,
  retry,
  notice,
  cancelling,
}

@immutable
class _Status {
  const _Status(
    this.kind,
    this.label, {
    required this.cancellable,
    this.lingers = false,
  });

  final _Kind kind;

  /// The words — shown, or given to the screen reader where the body draws
  /// something else (the take meter).
  final String label;

  /// Whether the `×` is offered. Not while sending — a send already on its way
  /// cannot be recalled — nor with a hold slid off, where letting go is itself
  /// the cancel.
  final bool cancellable;

  /// A notice that clears itself after [VoiceInputController.noticeLinger],
  /// and so draws the time it has left.
  final bool lingers;
}

class _VoiceStatusPillState extends State<VoiceStatusPill>
    with SingleTickerProviderStateMixin {
  /// Fast out, long settle: the body reaches most of its size quickly and eases
  /// into the rest, so it reads as springing out rather than being dragged.
  static const Curve _morph = Cubic(0.3, 0.9, 0.25, 1);
  static const Duration _spreadDuration = Duration(milliseconds: 340);

  static final List<BoxShadow> _shadow = [
    // It floats over streaming output, like the mic, and needs the same lift
    // to keep its edge over a bright line.
    BoxShadow(
      color: Colors.black.withValues(alpha: 0.35),
      blurRadius: 10,
      offset: const Offset(0, 2),
    ),
  ];

  /// 0 tucked behind the mic, 1 all the way out.
  late final AnimationController _reveal = AnimationController(
    vsync: this,
    duration: _spreadDuration,
  )..addStatusListener(_onRevealStatus);

  late final Animation<double> _spread = CurvedAnimation(
    parent: _reveal,
    curve: _morph,
    reverseCurve: Curves.easeInCubic,
  );

  /// Visible early on the way out, and gone only at the very end of the way
  /// back — by then the body is behind the mic anyway.
  late final Animation<double> _fade = CurvedAnimation(
    parent: _reveal,
    curve: const Interval(0, 0.35),
  );

  /// What the voice says right now.
  _Status? _status;

  /// What is drawn: [_status], held while the body tucks away after it has
  /// gone null, so it leaves with what it said rather than blank.
  _Status? _shown;

  String? _lastNotice;

  /// Counts the notices that have landed. Replays the nudge and restarts the
  /// countdown when a new one arrives on top of whatever was showing.
  int _noticeRun = 0;

  bool _motion = true;

  @override
  void initState() {
    super.initState();
    _subscribe(widget);
    _status = _read();
    _shown = _status;
    // Already out when it mounts mid-take — a page swiped to while talking —
    // rather than springing out as though it had just begun.
    _reveal.value = _status == null ? 0 : 1;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _motion = !MediaQuery.disableAnimationsOf(context);
  }

  @override
  void didUpdateWidget(VoiceStatusPill old) {
    super.didUpdateWidget(old);
    if (old.voice != widget.voice || old.slipped != widget.slipped) {
      _unsubscribe(old);
      _subscribe(widget);
      _apply(_read());
    }
  }

  @override
  void dispose() {
    _unsubscribe(widget);
    _reveal.dispose();
    super.dispose();
  }

  void _subscribe(VoiceStatusPill pill) {
    pill.voice.addListener(_sync);
    pill.slipped?.addListener(_sync);
  }

  void _unsubscribe(VoiceStatusPill pill) {
    pill.voice.removeListener(_sync);
    pill.slipped?.removeListener(_sync);
  }

  void _sync() {
    if (!mounted) return;
    setState(() => _apply(_read()));
  }

  /// Shows [next], or tucks the body away behind the mic when there is nothing
  /// to say.
  void _apply(_Status? next) {
    _status = next;
    if (next != null) {
      _shown = next;
      if (_motion) {
        _reveal.forward();
      } else {
        _reveal.value = 1;
      }
      return;
    }
    // Nothing out to tuck away, or no motion to tuck it with: gone at once.
    // [_shown] is cleared FIRST, so the dismissal this causes has nothing left
    // for [_onRevealStatus] to do — this can run inside `didUpdateWidget`,
    // where a `setState` would be one too many.
    if (!_motion || _reveal.value == 0) {
      _shown = null;
      _reveal.value = 0;
      return;
    }
    _reveal.reverse();
  }

  void _onRevealStatus(AnimationStatus status) {
    if (status != AnimationStatus.dismissed ||
        _status != null ||
        _shown == null ||
        !mounted) {
      return;
    }
    setState(() => _shown = null);
  }

  /// What the voice is doing, in the order the old single-line pill read it:
  /// a notice over everything, then what the mic is doing, then words held
  /// from a send that did not land.
  _Status? _read() {
    final voice = widget.voice;
    final notice = voice.notice;
    if (notice != _lastNotice) {
      _lastNotice = notice;
      if (notice != null) _noticeRun++;
    }
    final cancellable = !voice.isSending;
    if (notice != null) {
      return _Status(
        _Kind.notice,
        notice,
        cancellable: cancellable,
        // ⚠️ Not the refused microphone's: that one stays until it is
        // dismissed (see `VoiceInputController._restartNoticeTimer`), and a
        // countdown under it would promise it goes away.
        lingers: voice.status != VoiceInputStatus.unavailable,
      );
    }
    if (voice.status == VoiceInputStatus.listening &&
        (widget.slipped?.value ?? false)) {
      return const _Status(
        _Kind.cancelling,
        'Release to cancel',
        cancellable: false,
      );
    }
    final activity = voiceActivityLabel(voice);
    final kind = voice.isSending
        ? _Kind.sending
        : switch (voice.status) {
            VoiceInputStatus.starting => _Kind.starting,
            VoiceInputStatus.listening => _Kind.listening,
            VoiceInputStatus.transcribing => _Kind.transcribing,
            VoiceInputStatus.idle || VoiceInputStatus.unavailable => null,
          };
    if (kind != null && activity != null) {
      return _Status(kind, activity, cancellable: cancellable);
    }
    if (voice.transcript.isNotEmpty) {
      return _Status(
        _Kind.retry,
        'Tap ↑ to send again',
        cancellable: cancellable,
      );
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final shown = _shown;
    if (shown == null) return const SizedBox.shrink();
    final warn = shown.kind == _Kind.notice || shown.kind == _Kind.cancelling;
    return IgnorePointer(
      // Tucking away: what is still drawn is what WAS, and a `×` pressed on it
      // would clear a state that no longer exists.
      ignoring: _status == null,
      child: _Nudge(
        run: _noticeRun,
        enabled: _motion,
        child: FadeTransition(
          opacity: _fade,
          child: _CapsuleReveal(
            reveal: _spread,
            tucked: widget.micClearance > 0
                ? widget.micClearance
                : VoiceStatusPill.height,
            fill: shown.kind == _Kind.cancelling
                ? Color.alphaBlend(
                    AppPalette.warn.withValues(alpha: 0.16),
                    AppGlass.surfaceFill,
                  )
                : AppGlass.surfaceFill,
            rim: warn ? AppPalette.warn.withValues(alpha: 0.42) : AppGlass.lift,
            shadows: _shadow,
            child: AnimatedSize(
              duration: _motion ? _spreadDuration : Duration.zero,
              curve: _morph,
              alignment: Alignment.centerLeft,
              child: _body(shown),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(_Status shown) {
    // The room the mic covers, and a gap before it.
    final trailing = widget.micClearance + 12;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: VoiceStatusPill.height),
      child: Stack(
        alignment: AlignmentDirectional.centerStart,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (shown.cancellable)
                _CancelButton(onTap: widget.voice.clear)
              else
                const SizedBox(width: 18),
              Flexible(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: AnimatedSwitcher(
                    duration: _motion
                        ? const Duration(milliseconds: 240)
                        : Duration.zero,
                    reverseDuration: _motion
                        ? const Duration(milliseconds: 100)
                        : Duration.zero,
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeIn,
                    layoutBuilder: _layoutMiddle,
                    transitionBuilder: _enterMiddle,
                    child: KeyedSubtree(
                      key: ValueKey<Object>((
                        shown.kind,
                        shown.kind == _Kind.notice ? _noticeRun : 0,
                      )),
                      child: _middle(shown),
                    ),
                  ),
                ),
              ),
              SizedBox(width: trailing),
            ],
          ),
          if (shown.lingers && _motion)
            Positioned(
              left: 24,
              right: trailing,
              bottom: 5,
              child: _Countdown(run: _noticeRun),
            ),
        ],
      ),
    );
  }

  Widget _middle(_Status shown) {
    final style = TextStyle(
      fontSize: 13,
      height: 17 / 13,
      fontWeight: FontWeight.w500,
      color: AppPalette.textPrimary,
    );
    switch (shown.kind) {
      case _Kind.listening:
        // ⚠️ Words, not the meter, in hold-to-talk: the thumb is on the button
        // and the line to its left is the only thing that says what letting go
        // will do — and how to get out without sending.
        if (micHoldsToTalk) {
          return _lead(
            PulseDot(color: AppPalette.accentOnSurface, size: 7),
            _label(shown.label, style),
          );
        }
        return Semantics(
          label: shown.label,
          excludeSemantics: true,
          child: VoiceTakeMeter(
            level: widget.voice.level,
            elapsed: () => widget.voice.takeLength,
          ),
        );
      case _Kind.transcribing:
      case _Kind.sending:
        // Breathes rather than shimmers: the app's one "still working" rhythm,
        // and the reason the skeletons do not sweep either (see [Pulse]).
        return Pulse(
          duration: const Duration(milliseconds: 900),
          child: _label(shown.label, style),
          builder: (context, t, child) =>
              Opacity(opacity: 0.55 + 0.45 * t, child: child),
        );
      case _Kind.retry:
        return _lead(_Dot(color: AppPalette.warn), _label(shown.label, style));
      case _Kind.notice:
        return _lead(
          Icon(LucideIcons.circleAlert300, size: 16, color: AppPalette.warn),
          _label(shown.label, style),
        );
      case _Kind.cancelling:
        return _lead(
          Icon(LucideIcons.circleAlert300, size: 16, color: AppPalette.warn),
          _label(shown.label, style.copyWith(color: AppPalette.warn)),
        );
      case _Kind.starting:
        return _label(shown.label, style);
    }
  }

  /// Up to three lines, and it wraps: the notices are whole sentences, and cut
  /// to one line they lost the half that said what to do.
  static Widget _label(String text, TextStyle style) =>
      Text(text, maxLines: 3, overflow: TextOverflow.ellipsis, style: style);

  static Widget _lead(Widget mark, Widget label) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      SizedBox.square(dimension: 16, child: Center(child: mark)),
      const SizedBox(width: 8),
      Flexible(child: label),
    ],
  );

  /// ⚠️ **Only the incoming middle sizes the body.** The outgoing one is laid
  /// out beside it but positioned, so it neither holds the body at the larger
  /// of the two sizes while it fades nor stops [AnimatedSize] from heading
  /// straight for the new one.
  ///
  /// ⚠️ **Every child is a keyed [Positioned], the incoming one too** — with no
  /// offsets it is not positioned at all, and sizes the stack. What matters is
  /// that the widget around a child does not change type when it goes from
  /// incoming to outgoing: wrapped only on the way out, it was rebuilt from
  /// scratch there, and the take meter fading out restarted with flat bars.
  static Widget _layoutMiddle(Widget? current, List<Widget> previous) => Stack(
    alignment: AlignmentDirectional.centerStart,
    children: [
      for (final child in previous)
        Positioned(key: child.key, left: 0, child: child),
      if (current != null) Positioned(key: current.key, child: current),
    ],
  );

  static Widget _enterMiddle(Widget child, Animation<double> animation) =>
      FadeTransition(
        opacity: animation,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.2),
            end: Offset.zero,
          ).animate(animation),
          child: child,
        ),
      );
}

/// The `×`: at the far end of the capsule, away from the thumb on the mic.
class _CancelButton extends StatelessWidget {
  const _CancelButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: 'Cancel',
    child: GestureDetector(
      key: const ValueKey('voice-cancel'),
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: SizedBox(
        width: 44,
        height: VoiceStatusPill.height,
        child: Icon(
          LucideIcons.x300,
          size: 18,
          color: AppPalette.textSecondary,
        ),
      ),
    ),
  );
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 8,
    height: 8,
    decoration: BoxDecoration(shape: BoxShape.circle, color: color),
  );
}

/// A small sideways shake when a notice lands: something went wrong, and it
/// should be noticed without being loud.
///
/// ⚠️ **Driven by [run] climbing, never by a key.** A key would rebuild the
/// whole capsule beneath it and cut short the resize and the cross-fade it is
/// in the middle of. The tween heads for the new count instead, and the shake
/// is drawn from how far it still has to go.
class _Nudge extends StatelessWidget {
  const _Nudge({required this.run, required this.enabled, required this.child});

  final int run;
  final bool enabled;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!enabled) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(end: run.toDouble()),
      duration: const Duration(milliseconds: 340),
      child: child,
      builder: (context, value, child) {
        final t = 1 - (run - value).clamp(0.0, 1.0);
        final dx = t >= 1 ? 0.0 : 3 * math.sin(t * math.pi * 3) * (1 - t);
        return Transform.translate(offset: Offset(dx, 0), child: child);
      },
    );
  }
}

/// A hairline along the bottom of a notice, running out as the notice's time
/// on screen does.
class _Countdown extends StatelessWidget {
  const _Countdown({required this.run});

  /// Which notice it counts for; a new one starts it again from full.
  final int run;

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
    key: ValueKey(run),
    tween: Tween<double>(begin: 1, end: 0),
    duration: VoiceInputController.noticeLinger,
    builder: (context, left, _) => Align(
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: left,
        child: Container(
          height: 2,
          decoration: BoxDecoration(
            color: AppPalette.warn.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(1),
          ),
        ),
      ),
    ),
  );
}

/// Draws the capsule — its fill, rim and shadow — and clips what is inside it
/// to the capsule's shape, with the capsule growing out from the RIGHT edge as
/// [reveal] runs from 0 to 1.
///
/// ⚠️ **Paint only: layout and hit testing see the full size throughout.**
/// That is the point of it — see [VoiceStatusPill].
class _CapsuleReveal extends SingleChildRenderObjectWidget {
  const _CapsuleReveal({
    required this.reveal,
    required this.tucked,
    required this.fill,
    required this.rim,
    required this.shadows,
    super.child,
  });

  final Animation<double> reveal;

  /// The drawn width at `reveal == 0`: what the mic covers.
  final double tucked;

  final Color fill;
  final Color rim;
  final List<BoxShadow> shadows;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderCapsuleReveal(reveal, tucked, fill, rim, shadows);

  @override
  void updateRenderObject(
    BuildContext context,
    _RenderCapsuleReveal renderObject,
  ) {
    renderObject
      ..reveal = reveal
      ..tucked = tucked
      ..fill = fill
      ..rim = rim
      ..shadows = shadows;
  }
}

class _RenderCapsuleReveal extends RenderProxyBox {
  _RenderCapsuleReveal(
    this._reveal,
    this._tucked,
    this._fill,
    this._rim,
    this._shadows,
  );

  Animation<double> _reveal;
  set reveal(Animation<double> value) {
    if (identical(value, _reveal)) return;
    if (attached) _reveal.removeListener(markNeedsPaint);
    _reveal = value;
    if (attached) _reveal.addListener(markNeedsPaint);
    markNeedsPaint();
  }

  double _tucked;
  set tucked(double value) {
    if (value == _tucked) return;
    _tucked = value;
    markNeedsPaint();
  }

  Color _fill;
  set fill(Color value) {
    if (value == _fill) return;
    _fill = value;
    markNeedsPaint();
  }

  Color _rim;
  set rim(Color value) {
    if (value == _rim) return;
    _rim = value;
    markNeedsPaint();
  }

  List<BoxShadow> _shadows;
  set shadows(List<BoxShadow> value) {
    if (listEquals(value, _shadows)) return;
    _shadows = value;
    markNeedsPaint();
  }

  final LayerHandle<ClipRRectLayer> _clip = LayerHandle<ClipRRectLayer>();

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    _reveal.addListener(markNeedsPaint);
  }

  @override
  void detach() {
    _reveal.removeListener(markNeedsPaint);
    super.detach();
  }

  @override
  void dispose() {
    _clip.layer = null;
    super.dispose();
  }

  /// The capsule as drawn right now, in local coordinates.
  RRect _capsule() {
    final full = size.width;
    final from = math.min(_tucked, full);
    final width = from + (full - from) * _reveal.value.clamp(0.0, 1.0);
    return RRect.fromLTRBR(
      full - width,
      0,
      full,
      size.height,
      const Radius.circular(VoiceStatusPill.height / 2),
    );
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    if (child == null) return;
    final capsule = _capsule();
    final drawn = capsule.shift(offset);
    final canvas = context.canvas;
    for (final shadow in _shadows) {
      canvas.drawRRect(
        drawn.shift(shadow.offset).inflate(shadow.spreadRadius),
        shadow.toPaint(),
      );
    }
    canvas.drawRRect(drawn, Paint()..color = _fill);
    _clip.layer = context.pushClipRRect(
      needsCompositing,
      offset,
      capsule.outerRect,
      capsule,
      super.paint,
      oldLayer: _clip.layer,
    );
    // The rim over the content, so nothing inside draws across the edge.
    context.canvas.drawRRect(
      drawn.deflate(0.5),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = _rim,
    );
  }
}
