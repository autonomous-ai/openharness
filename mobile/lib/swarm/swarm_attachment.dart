import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'model.dart';
import 'swarm_attachment_store.dart';
import 'swarm_style.dart';

/// A message's file: a picture on Harness's file storage shows in place
/// ([_Preview]); every other file, and a picture that cannot be shown, is
/// [chip].
class SwarmAttachment extends StatelessWidget {
  const SwarmAttachment({
    super.key,
    required this.file,
    required this.link,
    required this.chip,
    this.store,
  });

  final SuperTabAttachment file;

  /// [file]'s link, when it is on Harness's file storage — the only place a
  /// picture is fetched from, as the chip only opens a link from there.
  final Uri? link;
  final Widget chip;

  /// Where the picture is kept; the app's own ([swarmAttachments]) by default.
  final SwarmAttachmentStore? store;

  @override
  Widget build(BuildContext context) {
    final url = link;
    if (!file.isImage || url == null) return chip;
    return _Preview(
      file: file,
      url: url,
      chip: chip,
      store: store ?? swarmAttachments,
    );
  }
}

/// The widest a picture shows in a message.
const _previewWidth = 240.0;

/// A picture in its message: a skeleton in a fixed 4:3 box while it loads,
/// then the picture filling the same box, so the chat never moves under the
/// reader. The backend sends no picture's size, so the box cannot take its
/// shape; the whole picture is a tap away ([SwarmAttachmentViewer]).
class _Preview extends StatefulWidget {
  const _Preview({
    required this.file,
    required this.url,
    required this.chip,
    required this.store,
  });

  final SuperTabAttachment file;
  final Uri url;
  final Widget chip;
  final SwarmAttachmentStore store;

  @override
  State<_Preview> createState() => _PreviewState();
}

class _PreviewState extends State<_Preview> {
  late Future<File> _local = widget.store.file(widget.url);

  /// The picture could not be fetched or decoded: the chip, which still opens it.
  bool _failed = false;

  @override
  void didUpdateWidget(_Preview old) {
    super.didUpdateWidget(old);
    if (old.url == widget.url && identical(old.store, widget.store)) return;
    _local = widget.store.file(widget.url);
    _failed = false;
  }

  void _fail() {
    if (!mounted || _failed) return;
    setState(() => _failed = true);
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) return widget.chip;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = math.min(constraints.maxWidth, _previewWidth);
        final height = width * 3 / 4;
        final skeleton = Skeleton(width: width, height: height, radius: 10);
        return Padding(
          padding: const EdgeInsets.only(top: 8),
          child: FutureBuilder<File>(
            future: _local,
            builder: (context, local) {
              if (local.hasError) {
                // After this frame: the chip replaces the whole preview.
                WidgetsBinding.instance.addPostFrameCallback((_) => _fail());
                return skeleton;
              }
              final file = local.data;
              return Semantics(
                button: file != null,
                image: true,
                label: 'Picture: ${widget.file.name}',
                excludeSemantics: true,
                child: GestureDetector(
                  key: ValueKey('swarm-attachment-preview-${widget.file.id}'),
                  onTap: file == null ? null : () => _open(context, file),
                  child: SizedBox(
                    width: width,
                    height: height,
                    child: file == null
                        ? skeleton
                        : ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: Image(
                              // Decoded at the box's size, not the picture's.
                              image: ResizeImage(
                                FileImage(file),
                                width:
                                    (width *
                                            MediaQuery.devicePixelRatioOf(
                                              context,
                                            ))
                                        .round(),
                              ),
                              fit: BoxFit.cover,
                              gaplessPlayback: true,
                              frameBuilder: (_, image, frame, synchronous) =>
                                  frame == null && !synchronous
                                  ? skeleton
                                  : image,
                              errorBuilder: (_, _, _) {
                                WidgetsBinding.instance.addPostFrameCallback(
                                  (_) => _fail(),
                                );
                                return skeleton;
                              },
                            ),
                          ),
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }

  void _open(BuildContext context, File file) => unawaited(
    Navigator.of(context).push(
      phoneRoute(
        (_) => SwarmAttachmentViewer(
          name: widget.file.name,
          file: file,
          store: widget.store,
        ),
        listensForItself: true,
      ),
    ),
  );
}

/// A picture full screen, to pinch and zoom; its name and a close at the top.
///
/// It shows a file [store] keeps for one account, so it goes when that
/// changes ([SwarmAttachmentStore.turns]: another account, sign-out, Swarm
/// off, a Swarm leaving the list): blank at once, its decoded picture let go,
/// and closed.
class SwarmAttachmentViewer extends StatefulWidget {
  const SwarmAttachmentViewer({
    super.key,
    required this.name,
    required this.file,
    required this.store,
  });

  final String name;
  final File file;
  final SwarmAttachmentStore store;

  @override
  State<SwarmAttachmentViewer> createState() => _ViewerState();
}

class _ViewerState extends State<SwarmAttachmentViewer> {
  /// The store's turn the picture was opened in.
  late final int _turn;

  /// The decoded picture, as last drawn.
  ImageProvider? _picture;
  bool _gone = false;

  @override
  void initState() {
    super.initState();
    _turn = widget.store.turns.value;
    widget.store.turns.addListener(_turned);
  }

  @override
  void dispose() {
    widget.store.turns.removeListener(_turned);
    super.dispose();
  }

  void _turned() {
    if (_gone || widget.store.turns.value == _turn) return;
    setState(() => _gone = true);
    unawaited(_picture?.evict());
    final route = ModalRoute.of(context);
    if (route != null && route.isActive) {
      Navigator.of(context).removeRoute(route);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final screen = MediaQuery.sizeOf(context).width;
    final ratio = MediaQuery.devicePixelRatioOf(context);
    // Twice the screen, so a zoom stays sharp without holding the picture at
    // its full size.
    final picture = _picture = ResizeImage(
      FileImage(widget.file),
      width: (screen * ratio * 2).round(),
    );
    return Scaffold(
      key: const ValueKey('swarm-attachment-viewer'),
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          children: [
            SwarmTopBar(
              leading: SwarmIconButton(
                key: const ValueKey('swarm-attachment-close'),
                icon: LucideIcons.x300,
                label: 'Close',
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: _gone ? '' : widget.name,
            ),
            Expanded(
              child: _gone
                  ? const SizedBox.expand()
                  : InteractiveViewer(
                      maxScale: 4,
                      child: Center(
                        child: Image(image: picture, fit: BoxFit.contain),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
