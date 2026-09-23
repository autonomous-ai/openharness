import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/pulse.dart';

/// A take being recorded, drawn: a live dot, the microphone's level scrolling
/// past as bars, and how long the take has run.
///
/// ```
///   ●  ▂▃▅▇▅▃▂▁▃▆▇▅▃▁  0:07
/// ```
///
/// ⚠️ **The bars are the proof that the mic is hearing.** The ring this
/// replaced breathed at the same pace whether or not a word was reaching the
/// microphone, so a muted input looked exactly like a working one until the
/// take came back empty. These move with the voice, and stay flat without it.
///
/// ⚠️ **Sampled on a fixed step, not per buffer.** The platform delivers audio
/// in bursts of uneven size and spacing; drawn per buffer the bars would
/// stutter and skip. Each step takes the loudest buffer since the last one,
/// and a step that got none lets the last bar fall away instead of repeating
/// it — which is also how a real meter's needle behaves.
///
/// ⚠️ Under Reduce Motion the bars hold still, as every other long-running
/// motion in the app does (see [Pulse]); the dot and the clock still say the
/// take is running.
class VoiceTakeMeter extends StatefulWidget {
  const VoiceTakeMeter({super.key, required this.level, required this.elapsed});

  /// The microphone's loudness, 0…1 — `VoiceInputController.level`.
  final ValueListenable<double> level;

  /// How long the take has run — `VoiceInputController.takeLength`. Read, not
  /// counted here, so a page swiped to mid-take shows the take's time.
  final Duration Function() elapsed;

  static const int bars = 22;
  static const double barWidth = 3;
  static const double barGap = 2;
  static const double height = 28;
  static const double minBar = 3;

  /// One bar per step: 22 of them cover the last second and a half.
  static const Duration step = Duration(milliseconds: 70);

  static double get waveWidth => bars * barWidth + (bars - 1) * barGap;

  @override
  State<VoiceTakeMeter> createState() => _VoiceTakeMeterState();
}

class _VoiceTakeMeterState extends State<VoiceTakeMeter>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);

  /// Oldest first; the newest bar is drawn on the right, nearest the mic.
  ///
  /// ⚠️ Growable, though its length never changes: each step drops the oldest
  /// bar and adds the newest, and `List.filled` is fixed-length by default —
  /// the first `removeAt` threw, every frame, and left the bars and the clock
  /// frozen.
  final List<double> _history = List<double>.filled(
    VoiceTakeMeter.bars,
    0,
    growable: true,
  );
  final _Repaint _repaint = _Repaint();

  /// The loudest buffer since the last step, and whether one arrived at all.
  double _loudest = 0;
  bool _heard = false;

  Duration _lastStep = Duration.zero;
  String _clock = '';
  bool _motion = true;

  /// What this meter was given over its life, for the one line it logs when it
  /// goes: flat bars are either no buffers reaching it or buffers that were
  /// all silence, and this says which.
  int _buffers = 0;
  double _peak = 0;
  int _steps = 0;

  @override
  void initState() {
    super.initState();
    widget.level.addListener(_onLevel);
    _clock = _format(widget.elapsed());
    _ticker.start();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _motion = !MediaQuery.disableAnimationsOf(context);
  }

  @override
  void didUpdateWidget(VoiceTakeMeter old) {
    super.didUpdateWidget(old);
    if (old.level != widget.level) {
      old.level.removeListener(_onLevel);
      widget.level.addListener(_onLevel);
    }
  }

  @override
  void dispose() {
    // Levels only, never audio or words.
    appLog.info(
      'voice',
      'meter: $_clock buffers=$_buffers peak=${_peak.toStringAsFixed(2)} '
          'steps=$_steps motion=$_motion',
    );
    widget.level.removeListener(_onLevel);
    _ticker.dispose();
    _repaint.dispose();
    super.dispose();
  }

  void _onLevel() {
    final level = widget.level.value;
    _loudest = math.max(_loudest, level);
    _heard = true;
    _buffers++;
    _peak = math.max(_peak, level);
  }

  void _tick(Duration now) {
    if (_motion && now - _lastStep >= VoiceTakeMeter.step) {
      _lastStep = now;
      final next = _heard ? _loudest : _history.last * 0.6;
      _history
        ..removeAt(0)
        ..add(next);
      _loudest = 0;
      _heard = false;
      _steps++;
      _repaint.ping();
    }
    // Rebuilt once a second, not every frame: the bars repaint on their own.
    final clock = _format(widget.elapsed());
    if (clock != _clock) setState(() => _clock = clock);
  }

  static String _format(Duration length) {
    final seconds = length.inSeconds;
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox.square(
          dimension: 16,
          child: Center(
            child: PulseDot(color: AppPalette.accentOnSurface, size: 7),
          ),
        ),
        const SizedBox(width: 8),
        // Its own layer: the bars repaint every step, and the capsule and the
        // glass under the mic beside them should not repaint with them.
        RepaintBoundary(
          child: CustomPaint(
            size: Size(VoiceTakeMeter.waveWidth, VoiceTakeMeter.height),
            painter: _WavePainter(
              history: _history,
              color: AppPalette.textPrimary,
              repaint: _repaint,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Text(
          _clock,
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w500,
            color: AppPalette.textSecondary,
            // The digits change every second; proportional ones would make the
            // capsule twitch in width as they did.
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ],
    );
  }
}

class _Repaint extends ChangeNotifier {
  void ping() => notifyListeners();
}

class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.history,
    required this.color,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final List<double> history;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final count = history.length;
    final paint = Paint();
    const width = VoiceTakeMeter.barWidth;
    for (var i = 0; i < count; i++) {
      final level = history[i].clamp(0.0, 1.0);
      final height =
          VoiceTakeMeter.minBar + level * (size.height - VoiceTakeMeter.minBar);
      // Older bars fade: the newest sound is the one nearest the mic.
      final age = count == 1 ? 1.0 : i / (count - 1);
      paint.color = color.withValues(alpha: color.a * (0.35 + 0.65 * age));
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(
            i * (width + VoiceTakeMeter.barGap),
            (size.height - height) / 2,
            width,
            height,
          ),
          const Radius.circular(width / 2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) =>
      old.color != color || !identical(old.history, history);
}
