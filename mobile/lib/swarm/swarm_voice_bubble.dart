import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:video_player/video_player.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_attachment_store.dart';
import 'swarm_file_links.dart';
import 'voice_length.dart';

/// What →A says for a voice message with no words.
const swarmVoiceNoWords = 'Not transcribed';
const swarmVoiceNoWordsLimit = "Not transcribed: today's voice limit was used";

/// A copy of [ref]'s file on the phone, kept in the account's file cache
/// (swarm_attachment_store.dart); null when none could be had. Replaced by
/// tests.
Future<File?> Function(BuildContext context, SwarmFileRef ref) swarmVoiceFile =
    _cachedCopy;

/// The player of a voice message's local copy. Replaced by tests.
VideoPlayerController Function(File file) swarmVoicePlayer =
    VideoPlayerController.file;

/// From the copy on the phone, never from the signed link: that link lasts
/// minutes, and a long clip played, paused and played again outlives it.
Future<File?> _cachedCopy(BuildContext context, SwarmFileRef ref) async {
  for (final stale in [false, true]) {
    if (!context.mounted) return null;
    final link = await swarmOpenableLink(context, ref, stale: stale);
    if (link == null) return null;
    try {
      return await swarmAttachments.file(link, key: 'voice:${ref.file.id}');
    } on Object {
      // The link may have run out in between: once more with a fresh one.
    }
  }
  return null;
}

/// A voice message (task #2584), on the phone as on Desktop:
///
///     ( ▶ )  ıllıllııılllıı.ılıı.ıll   1:21        →A
///
/// Play hears it, and the bars it has played fill in; the time counts what
/// was played, its length at rest. →A shows its [words] under it, the
/// message's text, and a second tap hides them. With no [fileRef] — a post
/// still on its way — nothing plays yet.
class SwarmVoiceBubble extends StatefulWidget {
  const SwarmVoiceBubble({
    super.key,
    required this.file,
    required this.voice,
    required this.words,
    this.fileRef,
  });

  final SuperTabAttachment file;
  final SuperTabVoice voice;
  final String words;
  final SwarmFileRef? fileRef;

  @override
  State<SwarmVoiceBubble> createState() => _SwarmVoiceBubbleState();
}

class _SwarmVoiceBubbleState extends State<SwarmVoiceBubble> {
  VideoPlayerController? _player;
  bool _opening = false, _words = false;
  String? _problem;

  bool get _playing => _player?.value.isPlaying ?? false;

  Future<void> _toggle() async {
    HapticFeedback.lightImpact();
    final player = _player;
    if (player != null) {
      if (player.value.isPlaying) {
        await player.pause();
      } else {
        if (player.value.isCompleted) await player.seekTo(Duration.zero);
        await player.play();
      }
      return;
    }
    final ref = widget.fileRef;
    if (ref == null || _opening) return;
    setState(() {
      _opening = true;
      _problem = null;
    });
    final copy = await swarmVoiceFile(context, ref);
    if (!mounted) return;
    if (copy == null) {
      setState(() {
        _opening = false;
        _problem = "Couldn't load it · tap to try again";
      });
      return;
    }
    final made = swarmVoicePlayer(copy);
    try {
      await made.initialize();
      if (!mounted) {
        unawaited(made.dispose());
        return;
      }
      made.addListener(_changed);
      _player = made;
      await made.play();
    } on Object {
      unawaited(made.dispose());
      if (mounted) _problem = "Couldn't play it · tap to try again";
    }
    if (mounted) setState(() => _opening = false);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    final player = _player;
    if (player != null) {
      player.removeListener(_changed);
      unawaited(player.dispose());
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final value = _player?.value;
    final length = widget.voice.length;
    final position = value?.position ?? Duration.zero;
    final played = length.inMilliseconds == 0 || value == null
        ? 0.0
        : (position.inMilliseconds / length.inMilliseconds).clamp(0.0, 1.0);
    final playing = _playing;
    final shown = value != null && (playing || position > Duration.zero)
        ? position
        : length;
    final words = widget.words.trim();
    return Padding(
      key: ValueKey('swarm-voice-bubble-${widget.file.id}'),
      padding: const EdgeInsets.only(top: AppSpace.s),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.xs,
              AppSpace.s,
              AppSpace.xs,
            ),
            decoration: BoxDecoration(
              color: tty.text.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(AppSpace.xl),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  button: true,
                  label: playing ? 'Pause' : 'Play',
                  excludeSemantics: true,
                  child: GestureDetector(
                    key: ValueKey(
                      playing ? 'swarm-voice-pause' : 'swarm-voice-play',
                    ),
                    behavior: HitTestBehavior.opaque,
                    onTap: () => unawaited(_toggle()),
                    child: SizedBox.square(
                      dimension: 44,
                      child: Center(
                        child: SizedBox.square(
                          dimension: 36,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: widget.fileRef == null
                                  ? AppPalette.textFaint
                                  : AppPalette.accent,
                              shape: BoxShape.circle,
                            ),
                            child: Center(
                              child: _opening
                                  ? SizedBox.square(
                                      dimension: AppIconSize.besideText - 4,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: AppInk.onFill,
                                      ),
                                    )
                                  : Icon(
                                      playing
                                          ? LucideIcons.pause
                                          : LucideIcons.play,
                                      size: AppIconSize.besideText,
                                      color: AppInk.onFill,
                                    ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: AppSpace.s),
                // As wide as the column leaves it: a phone's narrow message
                // column draws fewer bars.
                Flexible(
                  child: SwarmVoiceBars(
                    key: const ValueKey('swarm-voice-bars'),
                    waveform: widget.voice.waveform,
                    played: played,
                    playedColor: AppPalette.accent,
                    restColor: AppPalette.textFaint,
                  ),
                ),
                const SizedBox(width: AppSpace.s),
                Text(
                  swarmVoiceLength(shown),
                  style: AppType.caption(color: AppPalette.textSecondary)
                      .copyWith(
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                ),
                const SizedBox(width: AppSpace.s),
                Semantics(
                  button: true,
                  label: _words ? 'Hide words' : 'Show words',
                  excludeSemantics: true,
                  child: GestureDetector(
                    key: const ValueKey('swarm-voice-words-toggle'),
                    behavior: HitTestBehavior.opaque,
                    onTap: () => setState(() => _words = !_words),
                    child: SizedBox(
                      height: 44,
                      child: Center(
                        child: Text(
                          '→A',
                          style: AppType.label(
                            color: _words
                                ? AppPalette.accent
                                : AppPalette.textSecondary,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (_words)
            Padding(
              padding: const EdgeInsets.only(
                top: AppSpace.s,
                left: AppSpace.xs,
              ),
              child: Text(
                words.isNotEmpty
                    ? words
                    : widget.voice.overLimit
                    ? swarmVoiceNoWordsLimit
                    : swarmVoiceNoWords,
                style: words.isNotEmpty
                    ? AppType.body(color: AppPalette.textPrimary)
                    : AppType.caption(color: AppPalette.textSecondary),
              ),
            ),
          if (_problem case final problem?)
            Padding(
              padding: const EdgeInsets.only(
                top: AppSpace.xs,
                left: AppSpace.xs,
              ),
              child: Text(problem, style: AppType.caption(color: tty.yellow)),
            ),
        ],
      ),
    );
  }
}

/// A voice message's waveform: one bar for each of its [waveform] values,
/// or, where that is wider than the room it has, as many as fit, each the
/// loudest of the values it stands for. The [played] part is in
/// [playedColor], the rest in [restColor].
class SwarmVoiceBars extends StatelessWidget {
  const SwarmVoiceBars({
    super.key,
    required this.waveform,
    required this.played,
    required this.playedColor,
    required this.restColor,
  });

  final List<int> waveform;

  /// How much of it was played, 0 to 1.
  final double played;
  final Color playedColor, restColor;

  static const double bar = 2, gap = 2, low = 3, high = 24;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, room) {
      final fit = ((room.maxWidth + gap) / (bar + gap)).floor();
      final bars = _fitted(math.max(1, math.min(waveform.length, fit)));
      return SizedBox(
        width: bars.length * (bar + gap) - gap,
        height: high,
        child: CustomPaint(
          painter: _BarsPainter(bars, played, playedColor, restColor),
        ),
      );
    },
  );

  List<int> _fitted(int count) {
    if (count >= waveform.length) return waveform;
    return [
      for (var i = 0; i < count; i++)
        waveform
            .sublist(
              i * waveform.length ~/ count,
              math.max(
                i * waveform.length ~/ count + 1,
                (i + 1) * waveform.length ~/ count,
              ),
            )
            .reduce(math.max),
    ];
  }
}

class _BarsPainter extends CustomPainter {
  _BarsPainter(this.waveform, this.played, this.playedColor, this.restColor);

  final List<int> waveform;
  final double played;
  final Color playedColor, restColor;

  @override
  void paint(Canvas canvas, Size size) {
    const bar = SwarmVoiceBars.bar, step = bar + SwarmVoiceBars.gap;
    final paint = Paint()..strokeCap = StrokeCap.round;
    for (var i = 0; i < waveform.length; i++) {
      final level = waveform[i] / SuperTabVoice.barMax;
      final height =
          SwarmVoiceBars.low +
          (SwarmVoiceBars.high - SwarmVoiceBars.low) * level;
      paint.color = (i + 0.5) / waveform.length <= played
          ? playedColor
          : restColor;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(i * step, (size.height - height) / 2, bar, height),
          const Radius.circular(bar / 2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) =>
      old.played != played ||
      old.waveform != waveform ||
      old.playedColor != playedColor ||
      old.restColor != restColor;
}
