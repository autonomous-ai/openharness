import 'dart:async';
import 'dart:math' as math;

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/phone/voice_notice.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_conversation_page.dart' show SwarmRoundButton;
import 'swarm_voice_send.dart' show SwarmVoicePosted;
import 'voice_length.dart';

/// Where a chat's voice message is.
enum SwarmVoiceState {
  /// No take: the composer shows its mic.
  off,

  /// The microphone is asked for, or opening.
  starting,

  /// Recording.
  recording,

  /// Stopped and kept, with Send and X: by a tap, at [SwarmVoice.maxTake], or
  /// as the chat went out of sight.
  held,

  /// Its audio is on its way.
  sending,
}

/// A chat's voice messages, as Telegram's (Dee, 11-04: "just send the full
/// audio"). A tap on the mic records; the composer then shows
/// [SwarmVoiceRow]: X throws the take away, Send posts it as audio
/// ([post]), and its words come back from the backend for agents to read.
/// Nothing goes into the message box: the keyboard's own dictation is there
/// for typing by voice.
///
/// A take is never sent by itself. It stops and is kept, Send still there,
/// at [maxTake], and when the chat goes out of sight: covered by another
/// screen ([hide]), the phone locked or the app sent away. A system prompt or
/// Control Center only covers the app, and the take goes on. A long press on
/// the mic picks the language its words are heard in ([voiceLanguageStore]).
class SwarmVoice extends ChangeNotifier {
  SwarmVoice({required this.recorder, required this.post});

  /// The longest take; it stops there with Send ready.
  static const maxTake = Duration(minutes: 10);

  /// What a take that came back empty says.
  static const nothingRecorded = "Couldn't record anything · tap the mic again";

  /// What a send that failed without saying why says; the take is kept.
  static const notSent = 'Not sent · tap Send to try again';

  /// Makes the microphone on the first tap, which this owns and disposes: a
  /// recorder opens a platform channel, and a chat nobody talks in should not.
  final VoiceRecorder Function() recorder;

  /// Posts a take as a voice message, and answers whether it went and what
  /// to say about it. Not sent, the take is kept for another Send.
  final Future<SwarmVoicePosted> Function(VoiceTake take) post;

  VoiceRecorder? _recorder;
  SwarmVoiceState _state = SwarmVoiceState.off;
  VoiceTake? _take;
  String? _notice;
  bool _refused = false, _disposed = false;

  /// Bumped by everything that ends a take, so what an earlier one still
  /// awaits lands nowhere.
  int _turn = 0;
  Timer? _limit;
  Stopwatch? _clock;

  /// Stops a take as the app goes out of sight, from the first tap.
  AppLifecycleListener? _lifecycle;

  SwarmVoiceState get state => _state;

  /// What went wrong with the last take or send; null otherwise.
  String? get notice => _notice;

  /// The microphone was refused: the mic is off.
  bool get off => _refused;

  /// The take is under way or kept: the composer shows the voice row.
  bool get active => _state != SwarmVoiceState.off;

  /// Send can be tapped: a take is recording or kept.
  bool get canSend =>
      _state == SwarmVoiceState.recording || _state == SwarmVoiceState.held;

  /// How long the take has run, or the kept take's length.
  Duration get length => _take?.length ?? _clock?.elapsed ?? Duration.zero;

  /// How loud the microphone is, for the row's wave; silence from a recorder
  /// with no meter.
  ValueListenable<double> get level => switch (_recorder) {
    final VoiceLevelMeter meter => meter.level,
    _ => _silence,
  };
  static final ValueListenable<double> _silence = ValueNotifier(0);

  /// Starts a take; while one records, stops and keeps it; while the
  /// microphone opens, calls it off.
  void tap() {
    if (_disposed) return;
    switch (_state) {
      case SwarmVoiceState.off:
        unawaited(_start());
      case SwarmVoiceState.starting:
        discard();
      case SwarmVoiceState.recording:
        unawaited(_stop());
      case SwarmVoiceState.held || SwarmVoiceState.sending:
        break;
    }
  }

  /// Stops the take and keeps it, with Send and X: the chat went out of
  /// sight. A take still opening is called off.
  void hide() {
    if (_state == SwarmVoiceState.starting) discard();
    if (_state == SwarmVoiceState.recording) unawaited(_stop());
  }

  /// Throws the take away, recorded or kept, and sends nothing.
  void discard() {
    if (_disposed || _state == SwarmVoiceState.sending) return;
    final recording =
        _state == SwarmVoiceState.recording ||
        _state == SwarmVoiceState.starting;
    _end();
    if (recording) unawaited(_recorder?.cancel());
    _notice = null;
    _set(SwarmVoiceState.off);
  }

  /// Posts the take, stopping it first while it records.
  void send() {
    if (!canSend) return;
    unawaited(_send());
  }

  Future<void> _start() async {
    final turn = ++_turn;
    _notice = null;
    _set(SwarmVoiceState.starting);
    _watchApp();
    final mic = _recorder ??= recorder();
    if (!await mic.allowed()) {
      if (turn != _turn) return;
      _refused = true;
      _notice = VoiceNotice.unavailable;
      _set(SwarmVoiceState.off);
      return;
    }
    _refused = false;
    if (turn != _turn) return;
    try {
      await mic.start();
    } on Exception {
      if (turn != _turn) return;
      _notice = VoiceNotice.couldNotStart;
      _set(SwarmVoiceState.off);
      return;
    }
    // Called off while the microphone opened.
    if (turn != _turn) {
      unawaited(mic.cancel());
      return;
    }
    _take = null;
    _clock = clock.stopwatch()..start();
    _limit = Timer(maxTake, () => unawaited(_stop()));
    _set(SwarmVoiceState.recording);
  }

  /// Ends the recording and keeps it; true once there is a take to send.
  Future<bool> _stop() async {
    if (_state != SwarmVoiceState.recording) return _take != null;
    final turn = _turn;
    _limit?.cancel();
    _clock?.stop();
    // Held while the recorder finishes: no second stop, X or Send meanwhile.
    _set(SwarmVoiceState.held);
    final take = await _recorder!.stop();
    if (turn != _turn || _disposed) return false;
    if (take == null) {
      _end();
      _notice = nothingRecorded;
      _set(SwarmVoiceState.off);
      return false;
    }
    _take = take;
    notifyListeners();
    return true;
  }

  Future<void> _send() async {
    if (!await _stop()) return;
    final take = _take!, turn = _turn;
    _notice = null;
    _set(SwarmVoiceState.sending);
    SwarmVoicePosted posted;
    try {
      posted = await post(take);
    } on Object {
      // Whatever failed, the take stays with Send and X: a row left on
      // sending would hold it out of reach.
      posted = (sent: false, notice: notSent);
    }
    if (turn != _turn || _disposed) return;
    final (:sent, :notice) = posted;
    _notice = notice;
    if (!sent) {
      _set(SwarmVoiceState.held);
      return;
    }
    _end();
    _set(SwarmVoiceState.off);
  }

  void _end() {
    _turn++;
    _limit?.cancel();
    _limit = null;
    _clock = null;
    _take = null;
  }

  void _watchApp() => _lifecycle ??= AppLifecycleListener(
    onStateChange: (state) {
      if (state == AppLifecycleState.hidden ||
          state == AppLifecycleState.paused ||
          state == AppLifecycleState.detached) {
        hide();
      }
    },
  );

  void _set(SwarmVoiceState state) {
    if (_disposed) return;
    _state = state;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    final recording =
        _state == SwarmVoiceState.recording ||
        _state == SwarmVoiceState.starting;
    _end();
    _lifecycle?.dispose();
    final mic = _recorder;
    if (mic != null) {
      unawaited(() async {
        if (recording) await mic.cancel();
        await mic.dispose();
      }());
    }
    super.dispose();
  }
}

/// The composer's mic: a 36pt circle in a 44pt target, like the card's other
/// round buttons. A tap starts a voice message; a long press picks the
/// language its words are heard in, from the terminal's list. While a take is
/// under way the composer shows [SwarmVoiceRow] in its place.
class SwarmVoiceMic extends StatelessWidget {
  const SwarmVoiceMic({super.key, required this.voice});

  final SwarmVoice voice;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final off = voice.off;
    void talk() {
      HapticFeedback.lightImpact();
      voice.tap();
    }

    void chooseLanguage() => unawaited(showVoiceLanguagePicker(context));
    // The actions on the node itself: the button's own are left out with its
    // icon, and VoiceOver's double-tap-and-hold is the only way to the list.
    return Semantics(
      button: true,
      enabled: true,
      onTap: talk,
      onLongPress: chooseLanguage,
      label: off ? 'Voice input is off' : 'Record',
      onLongPressHint: 'Choose language',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('swarm-mic'),
        behavior: HitTestBehavior.opaque,
        onTap: talk,
        onLongPress: chooseLanguage,
        child: _VoiceRound(
          fill: tty.text.withValues(alpha: 0.08),
          child: Icon(
            off ? LucideIcons.micOff : LucideIcons.mic,
            size: 22,
            color: off ? AppPalette.textFaint : AppPalette.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// The card's toolbar while a voice message is under way (Dee, 11-04):
///
///     ( X )   ● 0:14   ıllıllıııllıı.ılı           ( ↑ )
///
/// X throws the take away; the red dot and the time run while it records,
/// and the wave follows [SwarmVoice.level]. A kept take shows its length with
/// the dot and the wave at rest. Send posts it, with a spinner until it has
/// gone, and nothing else takes a tap meanwhile.
///
/// Every label is one word: VoiceOver reads a label aloud, and a sentence
/// read into an open microphone lands in the take.
class SwarmVoiceRow extends StatelessWidget {
  const SwarmVoiceRow({super.key, required this.voice, this.canPost = true});

  final SwarmVoice voice;

  /// The composer could post now: New message has a chat picked and no post
  /// on its way.
  final bool canPost;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final fill = tty.text.withValues(alpha: 0.08);
    final sending = voice.state == SwarmVoiceState.sending;
    final recording = voice.state == SwarmVoiceState.recording;
    final canSend = canPost && voice.canSend;
    return Row(
      children: [
        _VoiceButton(
          key: const ValueKey('swarm-voice-cancel'),
          label: 'Discard',
          onTap: sending ? null : voice.discard,
          child: _VoiceRound(
            fill: fill,
            child: Icon(
              LucideIcons.x,
              size: 20,
              color: sending ? AppPalette.textFaint : AppPalette.textSecondary,
            ),
          ),
        ),
        const SizedBox(width: AppSpace.s),
        Container(
          key: const ValueKey('swarm-voice-dot'),
          width: AppSpace.s,
          height: AppSpace.s,
          decoration: BoxDecoration(
            color: recording ? tty.red : AppPalette.textFaint,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: AppSpace.s),
        _TakeClock(voice: voice),
        const SizedBox(width: AppSpace.s),
        Expanded(
          child: SwarmVoiceWave(
            key: const ValueKey('swarm-voice-wave'),
            level: recording ? voice.level : null,
            flat: !recording,
          ),
        ),
        const SizedBox(width: AppSpace.xs),
        SwarmRoundButton(
          key: const ValueKey('swarm-voice-send'),
          label: 'Send',
          face: 36,
          fill: canSend || sending ? AppPalette.accent : ttyRaised(tty),
          onTap: canSend
              ? () {
                  HapticFeedback.lightImpact();
                  voice.send();
                }
              : null,
          child: sending
              ? SizedBox.square(
                  dimension: AppIconSize.besideText,
                  child: CircularProgressIndicator(
                    key: const ValueKey('swarm-voice-sending'),
                    strokeWidth: 2,
                    color: AppInk.onFill,
                  ),
                )
              : Icon(
                  LucideIcons.arrowUp,
                  size: 20,
                  color: canSend ? AppInk.onFill : AppPalette.textFaint,
                ),
        ),
      ],
    );
  }
}

/// The take's time beside the red dot: it runs, a second at a time, only
/// while the take records.
class _TakeClock extends StatefulWidget {
  const _TakeClock({required this.voice});

  final SwarmVoice voice;

  @override
  State<_TakeClock> createState() => _TakeClockState();
}

class _TakeClockState extends State<_TakeClock> {
  Timer? _tick;

  @override
  Widget build(BuildContext context) {
    final recording = widget.voice.state == SwarmVoiceState.recording;
    if (recording && _tick == null) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!recording) {
      _tick?.cancel();
      _tick = null;
    }
    return Text(
      swarmVoiceLength(widget.voice.length),
      key: const ValueKey('swarm-voice-time'),
      style: AppType.caption(color: AppPalette.textPrimary)
          .copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
    );
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }
}

/// A 44pt target with [child] on a 36pt circle of [fill].
class _VoiceRound extends StatelessWidget {
  const _VoiceRound({required this.fill, required this.child});

  final Color fill;
  final Widget child;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 44,
    child: Center(
      child: SizedBox.square(
        dimension: 36,
        child: DecoratedBox(
          decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
          child: Center(child: child),
        ),
      ),
    ),
  );
}

/// One of [SwarmVoiceRow]'s round buttons, with a light tap felt.
class _VoiceButton extends StatelessWidget {
  const _VoiceButton({
    super.key,
    required this.label,
    required this.onTap,
    required this.child,
  });

  final String label;

  /// Null while the row's Send is under way: no tap.
  final VoidCallback? onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final onTap = this.onTap;
    void tap() {
      HapticFeedback.lightImpact();
      onTap?.call();
    }

    return Semantics(
      button: true,
      enabled: onTap != null,
      label: label,
      onTap: onTap == null ? null : tap,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap == null ? null : tap,
        child: child,
      ),
    );
  }
}

/// The voice row's wave: a history of the microphone's [level] scrolling in
/// from the right, one bar 2 wide every 2, 3 to 24 tall. A breath of motion
/// even in silence, so a listening take never looks frozen; [flat] draws the
/// bars at rest while the microphone opens or the words are on their way.
///
/// Painted, not built: the history moves in a [CustomPainter] behind a
/// [RepaintBoundary], so the composer around it is not rebuilt at every
/// frame. Under Reduce Motion nothing scrolls: the bars hold one shape that
/// rises and falls with the level alone.
class SwarmVoiceWave extends StatefulWidget {
  const SwarmVoiceWave({super.key, required this.level, this.flat = false});

  final ValueListenable<double>? level;
  final bool flat;

  static const double bar = 2;
  static const double gap = 2;
  static const double low = 3;
  static const double high = 24;

  /// How often a new bar comes in on the right.
  static const Duration step = Duration(milliseconds: 70);

  /// The most bars kept: enough for any phone's width.
  static const int _keep = 160;

  @override
  State<SwarmVoiceWave> createState() => _SwarmVoiceWaveState();
}

class _SwarmVoiceWaveState extends State<SwarmVoiceWave>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);

  /// Each bar's height, 0 to 1, oldest first.
  final List<double> _history = [];

  /// Bumped as the history moves: what repaints the painter.
  final ValueNotifier<int> _moved = ValueNotifier(0);
  Duration _last = Duration.zero;
  double _shown = 0;
  bool _motion = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _motion = !MediaQuery.disableAnimationsOf(context);
    _sync();
  }

  @override
  void didUpdateWidget(SwarmVoiceWave old) {
    super.didUpdateWidget(old);
    if (widget.flat && !old.flat) {
      _history.clear();
      _moved.value++;
    }
    _sync();
  }

  void _sync() {
    final run = _motion && !widget.flat;
    if (run && !_ticker.isActive) {
      _last = Duration.zero;
      unawaited(_ticker.start());
    } else if (!run && _ticker.isActive) {
      _ticker.stop();
    }
  }

  void _tick(Duration elapsed) {
    if (elapsed - _last < SwarmVoiceWave.step) return;
    _last = elapsed;
    final target = (widget.level?.value ?? 0).clamp(0.0, 1.0);
    _shown += (target - _shown) * 0.6;
    // A breath in silence: never a flat, frozen line while listening.
    final breath = 0.06 + 0.05 * math.sin(elapsed.inMilliseconds / 180.0).abs();
    _history.add(math.max(_shown, breath).clamp(0.0, 1.0));
    if (_history.length > SwarmVoiceWave._keep) _history.removeAt(0);
    _moved.value++;
  }

  @override
  void dispose() {
    _ticker.dispose();
    _moved.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final level = widget.level;
    return RepaintBoundary(
      child: SizedBox(
        height: 44,
        child: CustomPaint(
          painter: _WavePainter(
            history: _history,
            moved: _moved,
            color: AppPalette.textPrimary,
            flat: widget.flat,
            still: !_motion && level != null ? level : null,
          ),
          size: Size.infinite,
        ),
      ),
    );
  }
}

class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.history,
    required this.moved,
    required this.color,
    required this.flat,
    required this.still,
  }) : super(repaint: still == null ? moved : Listenable.merge([moved, still]));

  final List<double> history;
  final Listenable moved;
  final Color color;
  final bool flat;

  /// Under Reduce Motion: the level the one still shape follows.
  final ValueListenable<double>? still;

  @override
  void paint(Canvas canvas, Size size) {
    const pitch = SwarmVoiceWave.bar + SwarmVoiceWave.gap;
    final count = (size.width / pitch).floor();
    if (count <= 0) return;
    final paint = Paint()..color = color;
    final mid = size.height / 2;
    double heightOf(int i) {
      if (flat) return 0;
      if (still case final still?) {
        // One shape, taller toward the middle, scaled by the level.
        final shape = 0.35 + 0.65 * math.sin(math.pi * (i + 0.5) / count);
        return (0.08 + 0.92 * still.value.clamp(0.0, 1.0)) * shape;
      }
      // Newest on the right.
      final back = count - 1 - i;
      final at = history.length - 1 - back;
      return at < 0 ? 0 : history[at];
    }

    for (var i = 0; i < count; i++) {
      final amount = heightOf(i);
      final h =
          SwarmVoiceWave.low +
          (SwarmVoiceWave.high - SwarmVoiceWave.low) * amount;
      final x = size.width - (count - i) * pitch + SwarmVoiceWave.gap;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, mid - h / 2, SwarmVoiceWave.bar, h),
          const Radius.circular(SwarmVoiceWave.bar / 2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) =>
      old.flat != flat || old.color != color || old.still != still;
}

/// Where [SwarmVoice]'s take with the phone's recognizer is.
