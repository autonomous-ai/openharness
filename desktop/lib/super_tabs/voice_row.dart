import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'voice_length.dart';
import 'voice_take.dart';

/// Where macOS lets a person give Harness the microphone.
final superTabMicrophoneSettings = Uri.parse(
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
);

/// Opens [superTabMicrophoneSettings]; a test puts its own here.
@visibleForTesting
Future<bool> Function(Uri url) superTabOpenSettings = launchUrl;

/// What the composer says when the microphone was refused: on macOS with a
/// way to System Settings, in a browser where to allow it (no page can open
/// a browser's settings).
const superTabMicRefusedMac = "Harness can't use the microphone";
const superTabMicRefusedWeb =
    "This site can't use the microphone · allow it in your browser's site settings";

/// The composer's row while a voice message is under way (Dee, 11-04; the
/// phone's SwarmVoiceRow):
///
///     [X]  ● 0:14  ıllıllıııllıı.ılı           [↑]
///
/// X throws the take away; the red dot and the time run while it records,
/// and the wave follows the microphone. A kept take shows its length with
/// the dot and the wave at rest. Send posts it, spinning until it has gone.
class SuperTabVoiceRow extends StatelessWidget {
  const SuperTabVoiceRow({
    super.key,
    required this.take,
    this.discardKey = const ValueKey('super-voice-discard'),
    this.sendKey = const ValueKey('super-voice-send'),
  });

  final SuperTabVoiceTake take;
  final Key discardKey, sendKey;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: take,
      builder: (context, _) {
        final sending = take.state == SuperTabVoiceState.sending;
        final recording = take.state == SuperTabVoiceState.recording;
        return Row(
          children: [
            AppIconButton(
              key: discardKey,
              icon: AppIcons.close,
              tooltip: 'Discard voice message',
              onPressed: sending ? null : take.discard,
            ),
            const SizedBox(width: grid.AppDesktop.controlGap),
            Container(
              key: const ValueKey('super-voice-dot'),
              width: grid.AppDesktop.controlGap,
              height: grid.AppDesktop.controlGap,
              decoration: BoxDecoration(
                color: recording
                    ? grid.AppPalette.dangerFill
                    : DesktopChrome.hint,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: grid.AppDesktop.controlGap),
            _TakeClock(take: take),
            const SizedBox(width: grid.AppDesktop.controlGap),
            Expanded(
              child: _VoiceWave(
                key: const ValueKey('super-voice-wave'),
                level: recording ? take.level : null,
              ),
            ),
            const SizedBox(width: grid.AppDesktop.controlGap),
            AppIconButton(
              key: sendKey,
              icon: AppIcons.arrowUp,
              tooltip: 'Send voice message',
              color: DesktopChrome.accent,
              spinning: sending,
              onPressed: take.canSend ? take.send : null,
            ),
          ],
        );
      },
    );
  }
}

/// The one line under a composer about its voice message: a refused
/// microphone, with the way to allow it, or what the last take came to.
/// Nothing when there is nothing to say.
class SuperTabVoiceNotice extends StatelessWidget {
  const SuperTabVoiceNotice({
    super.key,
    required this.take,
    required this.conversationId,
    this.root,
    this.web = kIsWeb,
    this.padding = EdgeInsets.zero,
  });

  final SuperTabVoiceTake take;
  final String conversationId;
  final String? root;
  final bool web;

  /// Around the line when there is one; nothing takes room when there is not.
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: take,
      builder: (context, _) {
        final here = take.conversationId == conversationId && take.root == root;
        final style = DesktopChrome.metadata(color: DesktopChrome.muted);
        if (here && take.denied) {
          return Padding(
            key: const ValueKey('super-voice-refused'),
            padding: padding,
            child: web
                ? Text(superTabMicRefusedWeb, style: style)
                : Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text('$superTabMicRefusedMac · ', style: style),
                      InkWell(
                        key: const ValueKey('super-voice-settings'),
                        onTap: () => unawaited(
                          superTabOpenSettings(superTabMicrophoneSettings),
                        ),
                        child: Text(
                          'Open System Settings',
                          style: DesktopChrome.metadata(
                            color: DesktopChrome.accent,
                          ),
                        ),
                      ),
                    ],
                  ),
          );
        }
        final notice = take.notice;
        if (here && notice != null) {
          return Padding(
            key: const ValueKey('super-voice-notice'),
            padding: padding,
            child: Text(notice, style: style),
          );
        }
        return const SizedBox.shrink();
      },
    );
  }
}

/// The take's time beside the red dot: it runs, a second at a time, only
/// while the take records.
class _TakeClock extends StatefulWidget {
  const _TakeClock({required this.take});

  final SuperTabVoiceTake take;

  @override
  State<_TakeClock> createState() => _TakeClockState();
}

class _TakeClockState extends State<_TakeClock> {
  Timer? _tick;

  @override
  Widget build(BuildContext context) {
    final recording = widget.take.state == SuperTabVoiceState.recording;
    if (recording && _tick == null) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!recording) {
      _tick?.cancel();
      _tick = null;
    }
    return Text(
      superTabVoiceLength(widget.take.length),
      key: const ValueKey('super-voice-time'),
      style: DesktopChrome.control().copyWith(
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }
}

/// The row's wave: the microphone's [level] scrolling in from the right, one
/// bar 2 wide every 4. At rest (no [level]) the bars lie flat. Under Reduce
/// Motion nothing scrolls. Painted behind a [RepaintBoundary], so the
/// composer is not rebuilt at every frame.
class _VoiceWave extends StatefulWidget {
  const _VoiceWave({super.key, required this.level});

  final ValueListenable<double>? level;

  static const double bar = 2, pitch = 4, low = 2;

  /// How often a new bar comes in on the right.
  static const step = Duration(milliseconds: 70);

  /// The most bars kept: enough for any composer's width.
  static const keep = 240;

  @override
  State<_VoiceWave> createState() => _VoiceWaveState();
}

class _VoiceWaveState extends State<_VoiceWave>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  final List<double> _history = [];
  final ValueNotifier<int> _moved = ValueNotifier(0);
  Duration _last = Duration.zero;
  double _shown = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(_VoiceWave old) {
    super.didUpdateWidget(old);
    if (widget.level == null && old.level != null) {
      _history.clear();
      _moved.value++;
    }
    _sync();
  }

  void _sync() {
    final run =
        widget.level != null && !MediaQuery.disableAnimationsOf(context);
    if (run && !_ticker.isActive) {
      _last = Duration.zero;
      unawaited(_ticker.start());
    } else if (!run && _ticker.isActive) {
      _ticker.stop();
    }
  }

  void _tick(Duration elapsed) {
    if (elapsed - _last < _VoiceWave.step) return;
    _last = elapsed;
    final target = (widget.level?.value ?? 0).clamp(0.0, 1.0);
    _shown += (target - _shown) * 0.6;
    // A breath in silence: never a frozen line while listening.
    final breath = 0.06 + 0.05 * math.sin(elapsed.inMilliseconds / 180.0).abs();
    _history.add(math.max(_shown, breath));
    if (_history.length > _VoiceWave.keep) _history.removeAt(0);
    _moved.value++;
  }

  @override
  void dispose() {
    _ticker.dispose();
    _moved.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: SizedBox(
      height: grid.AppControl.heightFieldScaled,
      child: CustomPaint(
        size: Size.infinite,
        painter: _WavePainter(
          history: _history,
          moved: _moved,
          color: DesktopChrome.muted,
          still: MediaQuery.disableAnimationsOf(context) ? widget.level : null,
        ),
      ),
    ),
  );
}

class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.history,
    required Listenable moved,
    required this.color,
    required this.still,
  }) : super(repaint: still == null ? moved : Listenable.merge([moved, still]));

  final List<double> history;
  final Color color;

  /// Under Reduce Motion: the level the one still shape follows.
  final ValueListenable<double>? still;

  @override
  void paint(Canvas canvas, Size size) {
    final count = (size.width / _VoiceWave.pitch).floor();
    if (count <= 0) return;
    final paint = Paint()..color = color;
    final mid = size.height / 2;
    final high = size.height * .6;
    for (var i = 0; i < count; i++) {
      final double amount;
      if (still case final still?) {
        final shape = 0.35 + 0.65 * math.sin(math.pi * (i + 0.5) / count);
        amount = (0.08 + 0.92 * still.value.clamp(0.0, 1.0)) * shape;
      } else {
        final at = history.length - count + i;
        amount = at < 0 ? 0 : history[at];
      }
      final h = _VoiceWave.low + (high - _VoiceWave.low) * amount;
      final x = size.width - (count - i) * _VoiceWave.pitch;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, mid - h / 2, _VoiceWave.bar, h),
          const Radius.circular(_VoiceWave.bar / 2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) =>
      old.color != color || old.still != still || old.history != history;
}
