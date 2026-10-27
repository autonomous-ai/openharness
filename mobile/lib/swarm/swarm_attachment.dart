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
                                width: (width *
                                        MediaQuery.devicePixelRatioOf(context))
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
        (_) => SwarmAttachmentViewer(name: widget.file.name, file: file),
        listensForItself: true,
      ),
    ),
  );
}

/// A picture full screen, to pinch and zoom; its name and a close at the top.
class SwarmAttachmentViewer extends StatelessWidget {
  const SwarmAttachmentViewer({
    super.key,
    required this.name,
    required this.file,
  });

  final String name;
  final File file;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final screen = MediaQuery.sizeOf(context).width;
    final ratio = MediaQuery.devicePixelRatioOf(context);
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
              title: name,
            ),
            Expanded(
              child: InteractiveViewer(
                maxScale: 4,
                child: Center(
                  child: Image(
                    // Twice the screen, so a zoom stays sharp without holding
                    // the picture at its full size.
                    image: ResizeImage(
                      FileImage(file),
                      width: (screen * ratio * 2).round(),
                    ),
                    fit: BoxFit.contain,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
