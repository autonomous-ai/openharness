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
  late Future<File> _local;

  /// The store's turn [_local] was asked in ([SwarmAttachmentStore.turns]):
  /// the file is for whoever the store kept files for then, and opens full
  /// screen only while that holds.
  late int _turn;

  /// The picture could not be fetched or decoded: the chip, which still opens it.
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    widget.store.turns.addListener(_turned);
    _ask();
  }

  @override
  void didUpdateWidget(_Preview old) {
    super.didUpdateWidget(old);
    if (old.url == widget.url && identical(old.store, widget.store)) return;
    old.store.turns.removeListener(_turned);
    widget.store.turns.addListener(_turned);
    _ask();
  }

  @override
  void dispose() {
    widget.store.turns.removeListener(_turned);
    super.dispose();
  }

  void _ask() {
    _turn = widget.store.turns.value;
    _local = widget.store.file(widget.url);
    _failed = false;
  }

  /// The files kept changed hands: the picture is asked for again, for
  /// whoever they are kept for now.
  void _turned() {
    if (widget.store.turns.value != _turn) setState(_ask);
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
              // Only the file this future answered: while a new one is asked
              // (after a turn), the last one is another holder's.
              final file = local.connectionState == ConnectionState.done
                  ? local.data
                  : null;
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

  /// Opens [file] full screen, bound to the turn it was asked in, as of the
  /// tap: the viewer is built a frame later, after a change could come.
  void _open(BuildContext context, File file) {
    final turn = _turn;
    if (turn != widget.store.turns.value) return;
    final name = widget.file.name;
    final store = widget.store;
    unawaited(
      Navigator.of(context).push(
        phoneRoute(
          (_) => SwarmAttachmentViewer(
            name: name,
            file: file,
            store: store,
            turn: turn,
          ),
          listensForItself: true,
        ),
      ),
    );
  }
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
    required this.turn,
  });

  final String name;
  final File file;
  final SwarmAttachmentStore store;

  /// The store's turn [file] was asked in: shown only while it holds, so a
  /// change between the tap and the first frame shows nothing either.
  final int turn;

  @override
  State<SwarmAttachmentViewer> createState() => _ViewerState();
}

class _ViewerState extends State<SwarmAttachmentViewer> {
  /// The decoded picture, as last drawn.
  ImageProvider? _picture;
  bool _gone = false;

  @override
  void initState() {
    super.initState();
    widget.store.turns.addListener(_turned);
    if (widget.store.turns.value != widget.turn) {
      _gone = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _close());
    }
  }

  @override
  void dispose() {
    widget.store.turns.removeListener(_turned);
    super.dispose();
  }

  void _turned() {
    if (_gone || widget.store.turns.value == widget.turn) return;
    setState(() => _gone = true);
    unawaited(_picture?.evict());
    _close();
  }

  void _close() {
    if (!mounted) return;
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
