import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:path/path.dart' as p;
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_links.dart';

import 'phone_navigation.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Opens [path] — a picture or video an agent printed, already downloaded to this phone — full
/// screen over the page [context] is on. Back, or Android's back button, returns to it.
///
/// A picture's page cannot be dragged away from the left edge: the horizontal drag belongs to the
/// zoomed picture's pan, the reason the agent pager gives up the gesture too (see `phoneRoute`).
/// A video has nothing competing for it, so it keeps the edge swipe every other page has.
Future<void> openMediaPreview(BuildContext context, String path) =>
    Navigator.of(context).push(
      phoneRoute(
        (_) => MediaPreviewPage(path: path),
        swipeToGoBack: isVideoPath(path),
      ),
    );

/// The most a picture is decoded to along either side, in pixels. A preview can be up to 512 MB
/// (`remoteMediaMaxBytes`), and a picture that large decoded at full size is gigabytes of pixels —
/// enough for the OS to end the app. 4096 still leaves a phone screen room to zoom in a few times
/// before the picture softens.
const _maxDecodedSide = 4096;

/// What a program printed and the phone downloaded, shown in the app: a picture to pinch and pan,
/// or a video that a tap plays and pauses. Back and Share above it, and nothing else.
///
/// ⚠️ **In the app, never handed to another one.** `url_launcher` opens `file:` URLs on desktop
/// platforms only: iOS refuses them, and Android has no FileProvider here to pass one through, so
/// the terminal's media links used to end in "Could not open this preview" every time. Share is
/// how the file leaves — Save Image, Save to Files and AirDrop on iOS, the chooser on Android.
class MediaPreviewPage extends StatefulWidget {
  const MediaPreviewPage({
    super.key,
    required this.path,
    this.share,
    this.controller,
  });

  /// The downloaded copy on this phone, not the path on the agent's machine.
  final String path;

  /// Stands in for the share sheet in tests. Null opens the platform's.
  final Future<void> Function(ShareParams params)? share;

  /// Stands in for the video player in tests. Null plays [path]. Unused for a picture.
  final VideoPlayerController? controller;

  @override
  State<MediaPreviewPage> createState() => _MediaPreviewPageState();
}

class _MediaPreviewPageState extends State<MediaPreviewPage> {
  late final bool _isVideo = isVideoPath(widget.path);

  /// Bounded by [_maxDecodedSide] on the way in, keeping its shape, and never enlarged.
  late final ImageProvider _image = ResizeImage(
    FileImage(File(widget.path)),
    width: _maxDecodedSide,
    height: _maxDecodedSide,
    policy: ResizeImagePolicy.fit,
    allowUpscaling: false,
  );

  VideoPlayerController? _video;
  bool _videoReady = false;
  bool _videoFailed = false;

  /// Whether a share sheet asked for is still up. A second tap while it opens would ask for a
  /// second sheet: iOS refuses to present one over the other, and Android stacks two choosers.
  bool _sharing = false;

  @override
  void initState() {
    super.initState();
    if (_isVideo) {
      final video =
          widget.controller ?? VideoPlayerController.file(File(widget.path));
      _video = video..addListener(_onVideo);
      unawaited(_start(video));
    }
  }

  Future<void> _start(VideoPlayerController video) async {
    try {
      await video.initialize();
      if (!mounted) return;
      setState(() => _videoReady = true);
      await video.play();
    } catch (_) {
      // A format this phone cannot play (mkv and avi on iOS, say), or a file that is not a video
      // at all: said on the page, with Share still there to send the file somewhere that can.
      if (mounted) setState(() => _videoFailed = true);
    }
  }

  /// A player can also fail AFTER it has started — a file that turns out to be cut short — and
  /// says so only in its value.
  void _onVideo() {
    if (_videoFailed || !mounted || _video?.value.hasError != true) return;
    setState(() => _videoFailed = true);
  }

  @override
  void dispose() {
    _video?.removeListener(_onVideo);
    if (widget.controller == null) unawaited(_video?.dispose());
    // Out of the app's shared image cache as the page goes: every download has a path of its own
    // (`RemoteMediaDownloader`), so nothing will ask for these pixels again, and up to 64 MB of
    // them would otherwise sit there until the cache filled up.
    if (!_isVideo) unawaited(_image.evict());
    super.dispose();
  }

  /// A tap pauses, plays, or — at the end — plays it again.
  void _toggle() {
    final video = _video;
    if (video == null || !_videoReady || _videoFailed) return;
    final value = video.value;
    if (value.isPlaying) {
      unawaited(video.pause());
    } else {
      if (value.position >= value.duration) {
        unawaited(video.seekTo(Duration.zero));
      }
      unawaited(video.play());
    }
  }

  /// The share sheet with the file, anchored to [origin] — the Share button — for an iPad, where
  /// it is a popover.
  Future<void> _share(Rect? origin) async {
    if (_sharing) return;
    _sharing = true;
    try {
      await (widget.share ?? _platformShare)(
        ShareParams(files: [XFile(widget.path)], sharePositionOrigin: origin),
      );
    } catch (_) {
      // No share sheet came up: the preview is still here, and Share can be pressed again.
    } finally {
      _sharing = false;
    }
  }

  static Future<void> _platformShare(ShareParams params) async {
    await SharePlus.instance.share(params);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      // Nothing here is typed into. The terminal's keyboard can still be on its way down as this
      // page slides in, and keeping clear of it would make the picture jump as it falls.
      resizeToAvoidBottomInset: false,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                TtyBackButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                const Spacer(),
                _ShareButton(onShare: (origin) => unawaited(_share(origin))),
              ],
            ),
            Expanded(child: _isVideo ? _videoView(tty) : _imageView(tty)),
          ],
        ),
      ),
    );
  }

  /// The picture, fitted to the screen, pinched and panned from there.
  ///
  /// The zoom wraps the decoded picture only — [Image.frameBuilder] is not called for the error —
  /// so a picture that cannot be decoded is a still sentence, not one that can be pinched.
  Widget _imageView(Tty tty) => Image(
    image: _image,
    fit: BoxFit.contain,
    semanticLabel: p.basename(widget.path),
    frameBuilder: (context, child, frame, synchronous) => InteractiveViewer(
      // Never smaller than fitted: there is nothing to see in a picture shrunk below the screen.
      minScale: 1,
      // Far enough to read a screenshot's small print.
      maxScale: 6,
      child: child,
    ),
    errorBuilder: (context, error, stack) => _failure(tty),
  );

  Widget _videoView(Tty tty) {
    final video = _video!;
    if (_videoFailed) return _failure(tty);
    // Opening it is a moment on a file already on the phone: nothing is drawn meanwhile.
    if (!_videoReady) return const SizedBox.shrink();
    return Semantics(
      label: p.basename(widget.path),
      child: GestureDetector(
        key: const ValueKey('media-preview-video'),
        // The whole page under the bar takes the tap, not only the video's own box: a landscape
        // video on a phone held upright leaves most of the screen above and below it.
        behavior: HitTestBehavior.opaque,
        onTap: _toggle,
        child: Center(
          child: AspectRatio(
            aspectRatio: video.value.aspectRatio,
            child: VideoPlayer(video),
          ),
        ),
      ),
    );
  }

  /// The opener's own words for a preview that will not open.
  Widget _failure(Tty tty) => Center(
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
      child: Text(
        'Could not open this preview.',
        textAlign: TextAlign.center,
        style: tty.style(color: tty.faint, size: TtySize.row),
      ),
    ),
  );
}

/// Share, the back chevron's box mirrored: the same touch target, the glyph on the right gutter.
class _ShareButton extends StatelessWidget {
  const _ShareButton({required this.onShare});

  /// Called with the button's own rectangle on screen, the share sheet's anchor on an iPad.
  final void Function(Rect? origin) onShare;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'Share',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('media-preview-share'),
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          final box = context.findRenderObject() as RenderBox?;
          onShare(
            box == null || !box.attached
                ? null
                : box.localToGlobal(Offset.zero) & box.size,
          );
        },
        child: SizedBox(
          width: 52,
          height: 44,
          child: Padding(
            padding: const EdgeInsets.only(right: Tty.origin - 2),
            child: Align(
              alignment: Alignment.centerRight,
              child: Icon(LucideIcons.share300, size: 21, color: tty.text),
            ),
          ),
        ),
      ),
    );
  }
}
