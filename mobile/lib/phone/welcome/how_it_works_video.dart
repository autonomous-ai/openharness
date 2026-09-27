import 'dart:async';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import '../tty.dart';
import '../tty_controls.dart';

/// The recording of the app — a harness at work, one asking and answered by voice, a new one
/// started — played from the set-up page ("See how it works"), for someone not at their computer.
/// In place of an interactive demo: 30 seconds, bundled, so it plays offline.
const kHowItWorksVideo = 'assets/video/how_it_works.mp4';

class HowItWorksVideoPage extends StatefulWidget {
  const HowItWorksVideoPage({super.key, this.controller});

  /// Stands in for the player in tests. Null plays [kHowItWorksVideo].
  final VideoPlayerController? controller;

  @override
  State<HowItWorksVideoPage> createState() => _HowItWorksVideoPageState();
}

class _HowItWorksVideoPageState extends State<HowItWorksVideoPage> {
  late final VideoPlayerController _video =
      widget.controller ?? VideoPlayerController.asset(kHowItWorksVideo);
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  Future<void> _start() async {
    try {
      await _video.initialize();
    } catch (_) {
      return;
    }
    if (!mounted) return;
    setState(() => _ready = true);
    await _video.play();
  }

  @override
  void dispose() {
    if (widget.controller == null) unawaited(_video.dispose());
    super.dispose();
  }

  /// A tap pauses, plays, or — at the end — plays it again.
  void _toggle() {
    final value = _video.value;
    if (value.isPlaying) {
      unawaited(_video.pause());
    } else {
      if (value.position >= value.duration) {
        unawaited(_video.seekTo(Duration.zero));
      }
      unawaited(_video.play());
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: Center(
                child: !_ready
                    ? const SizedBox.shrink()
                    : GestureDetector(
                        onTap: _toggle,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(14),
                          child: AspectRatio(
                            aspectRatio: _video.value.aspectRatio,
                            child: VideoPlayer(_video),
                          ),
                        ),
                      ),
              ),
            ),
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
  }
}
