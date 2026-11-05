import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:video_player/video_player.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import 'attachment_viewer.dart';
import 'file_links.dart';
import 'model.dart';
import 'voice_length.dart';

/// The most a voice file is read into its local copy: the server takes a
/// clip of at most 10:05 of 16 kHz mono WAV, 19.4 MB. A larger one opens as
/// a file chip's does.
const kSuperTabVoiceMaxBytes = 20 * 1024 * 1024;

/// Makes the player for a voice message, from a local copy of its file (a
/// `file:` [source]), or in a browser, which has no files, from its link.
@visibleForTesting
VideoPlayerController Function(Uri source) superTabVoicePlayer = _player;

VideoPlayerController _player(Uri source) => source.isScheme('file')
    ? VideoPlayerController.file(File.fromUri(source))
    : VideoPlayerController.networkUrl(source);

/// video_player has no Linux implementation; there Play opens the file in the
/// system's player, as its chip would.
bool get _playsHere => kIsWeb || defaultTargetPlatform != TargetPlatform.linux;

/// A voice message as Telegram draws one: `( ▶ ) ıllıllııılll 1:21 →A`. Play
/// plays a copy of the file read once to this computer, never the signed
/// link, which stops opening within minutes; →A shows the [words] under it.
class SuperTabVoiceBubble extends StatefulWidget {
  const SuperTabVoiceBubble({
    super.key,
    required this.file,
    required this.words,
  });

  /// A file whose [SuperTabAttachment.voice] is set.
  final SuperTabFileRef file;

  /// The message's text: the clip's words, when it was transcribed.
  final String words;

  @override
  State<SuperTabVoiceBubble> createState() => _SuperTabVoiceBubbleState();
}

class _SuperTabVoiceBubbleState extends State<SuperTabVoiceBubble> {
  VideoPlayerController? _playing;

  /// Where the local copy is; removed with the bubble.
  Directory? _copy;

  bool _loading = false, _showWords = false;

  /// The last read failed: the next one asks for a fresh link first.
  bool _stale = false;

  SuperTabVoice get _voice => widget.file.file.voice!;

  void _say(String text) =>
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(text)));

  void _changed() {
    final player = _playing;
    if (player == null || !mounted) return;
    // A browser plays from a link, which may have stopped opening by the next
    // play: a finished one is made again then, from a link that opens now.
    if (kIsWeb && player.value.isCompleted) {
      _playing = null;
      player.removeListener(_changed);
      unawaited(player.dispose());
    }
    setState(() {});
  }

  Future<void> _toggle() async {
    if (_playing case final player?) {
      // A finished clip plays again from its start.
      return player.value.isPlaying ? player.pause() : player.play();
    }
    if (_loading) return;
    final ref = widget.file;
    if (ref.refused) {
      _say('This file isn’t on Harness’s file storage, so it wasn’t opened.');
      return;
    }
    setState(() => _loading = true);
    try {
      final link = await superTabOpenableLink(
        context,
        ref,
        stale: _stale,
        onProblem: _say,
      );
      if (link == null || !mounted) return;
      if (!_playsHere) {
        await openInBrowser(link);
        return;
      }
      await _start(kIsWeb ? link : await _copyOf(link));
    } on AttachmentTooLarge {
      if (!mounted) return;
      if (await superTabOpenableLink(context, ref) case final link?) {
        await openInBrowser(link);
      }
    } catch (_) {
      _stale = true;
      if (mounted) _say('Couldn’t play the voice message. Try again.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// The file at [link] read to this computer, once for this bubble.
  Future<Uri> _copyOf(Uri link) async {
    final bytes = await readAttachment(link, maxBytes: kSuperTabVoiceMaxBytes);
    final dir = _copy ??= await Directory.systemTemp.createTemp(
      'harness-voice-',
    );
    final name = p.extension(widget.file.file.name);
    final copy = File(p.join(dir.path, 'voice${name.isEmpty ? '.wav' : name}'));
    await copy.writeAsBytes(bytes, flush: true);
    if (!mounted) _forget();
    return copy.uri;
  }

  Future<void> _start(Uri source) async {
    if (!mounted) return;
    final player = superTabVoicePlayer(source);
    try {
      await player.initialize();
    } catch (_) {
      unawaited(player.dispose());
      rethrow;
    }
    if (!mounted) {
      unawaited(player.dispose());
      return;
    }
    _playing = player..addListener(_changed);
    await player.play();
  }

  void _forget() {
    final dir = _copy;
    _copy = null;
    if (dir != null) {
      unawaited(dir.delete(recursive: true).then((_) {}, onError: (_) {}));
    }
  }

  @override
  void dispose() {
    final player = _playing;
    _playing = null;
    if (player != null) {
      player.removeListener(_changed);
      unawaited(player.dispose());
    }
    _forget();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final id = widget.file.file.id, voice = _voice;
    final value = _playing?.value;
    final playing = value?.isPlaying ?? false;
    final length = value != null && value.duration > Duration.zero
        ? value.duration
        : voice.length;
    // At rest the bubble says the clip's length; once begun, how far in.
    final position = value == null || value.isCompleted
        ? Duration.zero
        : value.position;
    final played = length > Duration.zero
        ? (position.inMilliseconds / length.inMilliseconds).clamp(0.0, 1.0)
        : 0.0;
    final finger = workspaceIsCompact(context);
    final bubble = Material(
      // The file chip's fill: the bubble is the chip of a voice file.
      color: DesktopChrome.foreground.withValues(alpha: .055),
      shape: const StadiumBorder(),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: grid.AppDesktop.menuInset,
          vertical: grid.AppDesktop.menuInset,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            fingerTarget(
              enabled: finger,
              _PlayButton(
                key: ValueKey('super-voice-play:$id'),
                playing: playing,
                onPressed: _loading ? null : () => unawaited(_toggle()),
              ),
            ),
            const SizedBox(width: grid.AppDesktop.controlGap),
            _Waveform(id: id, bars: voice.waveform, played: played),
            const SizedBox(width: grid.AppDesktop.controlGap),
            Text(
              superTabVoiceLength(position > Duration.zero ? position : length),
              style: DesktopChrome.metadata().copyWith(
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            const SizedBox(width: grid.AppDesktop.groupGap),
            fingerTarget(
              enabled: finger,
              Tooltip(
                message: _showWords ? 'Hide words' : 'Show words',
                child: TextButton(
                  key: ValueKey('super-voice-words-toggle:$id'),
                  onPressed: () => setState(() => _showWords = !_showWords),
                  style: TextButton.styleFrom(
                    minimumSize: const Size.square(
                      DesktopChrome.compactControlHeight,
                    ),
                    padding: const EdgeInsets.symmetric(
                      horizontal: grid.AppDesktop.menuInset,
                    ),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    visualDensity: VisualDensity.compact,
                  ),
                  child: Text(
                    '→A',
                    style: DesktopChrome.control(
                      color: _showWords
                          ? DesktopChrome.accent
                          : DesktopChrome.muted,
                      medium: true,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (!_showWords) return bubble;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: grid.AppDesktop.controlGap,
      children: [
        bubble,
        ConstrainedBox(
          // The width a message's text keeps (message_row.dart).
          constraints: const BoxConstraints(maxWidth: 960),
          // The chat's selection area makes the words selectable.
          child: voice.transcribed
              ? Text(
                  widget.words,
                  key: ValueKey('super-voice-words:$id'),
                  style: DesktopChrome.text(),
                )
              : Text(
                  voice.failure == 'limit'
                      ? 'Not transcribed: today’s voice limit was used'
                      : 'Not transcribed',
                  key: ValueKey('super-voice-words:$id'),
                  style: DesktopChrome.metadata(),
                ),
        ),
      ],
    );
  }
}

class _PlayButton extends StatelessWidget {
  const _PlayButton({super.key, required this.playing, this.onPressed});
  final bool playing;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: playing ? 'Pause' : 'Play',
    child: Material(
      color: DesktopChrome.accent,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onPressed,
        child: SizedBox.square(
          dimension: DesktopChrome.compactControlHeight,
          child: Icon(
            playing ? AppIcons.pause : AppIcons.play,
            size: AppIcons.metadataSize,
            color: DesktopChrome.onSelection,
          ),
        ),
      ),
    ),
  );
}

/// The clip's loudness, one bar per slice: the [played] fraction in the
/// accent, the rest muted.
class _Waveform extends StatelessWidget {
  const _Waveform({required this.id, required this.bars, required this.played});
  final String id;
  final List<int> bars;
  final double played;

  /// A bar, and the gap after it, are each a list row's gap wide; the
  /// tallest is an icon's height, the quietest a dot.
  static const _bar = grid.AppDesktop.listRowGap;
  static const _height = AppIcons.controlSize;

  @override
  Widget build(BuildContext context) {
    final filled = (played * bars.length).floor();
    return SizedBox(
      height: _height,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        spacing: _bar,
        children: [
          for (final (i, bar) in bars.indexed)
            SizedBox(
              width: _bar,
              height: _bar + (_height - _bar) * bar / SuperTabVoice.barMax,
              child: DecoratedBox(
                key: ValueKey('super-voice-bar:$id:$i'),
                decoration: BoxDecoration(
                  color: i < filled
                      ? DesktopChrome.accent
                      : DesktopChrome.muted,
                  borderRadius: BorderRadius.circular(_bar / 2),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
