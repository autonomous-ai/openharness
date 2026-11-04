import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';

import 'package:harness_mobile/logging/app_log.dart';

import 'swarm_attachment_store.dart';
import 'swarm_style.dart';

/// The system's share sheet; tests stand in for it.
@visibleForTesting
Future<void> Function(ShareParams params) swarmShareSheet = (params) async {
  await SharePlus.instance.share(params);
};

/// Said when a file could not be handed on (the desktop's words for a
/// Download that failed).
const swarmFileNotSaved = 'Couldn’t save this file.';

/// A chat file viewer's Download (the desktop's): the file the phone keeps
/// handed to the system's share sheet under its own name — Save to Files,
/// Save Image and AirDrop on iOS, the chooser on Android — as an app on a
/// phone has no folder of its own to save into. Off until [file] is there;
/// one sheet at a time.
class SwarmDownloadButton extends StatefulWidget {
  const SwarmDownloadButton({
    super.key,
    required this.name,
    required this.file,
    required this.store,
  });

  /// The file's name in its message: what it is saved as.
  final String name;

  /// The copy [store] keeps; null while it is on its way, or when it could
  /// not be had.
  final File? file;
  final SwarmAttachmentStore store;

  @override
  State<SwarmDownloadButton> createState() => _SwarmDownloadButtonState();
}

class _SwarmDownloadButtonState extends State<SwarmDownloadButton> {
  /// A sheet asked for is still up: iOS refuses a second over it, and Android
  /// stacks two choosers.
  bool _sharing = false;

  Future<void> _download(Rect? origin) async {
    final kept = widget.file;
    if (kept == null || _sharing) return;
    setState(() => _sharing = true);
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await widget.store.named(
        kept,
        widget.name,
        (copy) => swarmShareSheet(
          ShareParams(files: [XFile(copy.path)], sharePositionOrigin: origin),
        ),
      );
    } catch (error) {
      // Its kind only: the error's path carries the file's name.
      appLog.failure(
        'swarm',
        'A Swarm file could not be shared: ${error.runtimeType}',
      );
      messenger?.showSnackBar(const SnackBar(content: Text(swarmFileNotSaved)));
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  /// The button's own rectangle on screen: the sheet's anchor on an iPad,
  /// where it is a popover.
  Rect? _origin() {
    final box = context.findRenderObject() as RenderBox?;
    return box == null || !box.attached
        ? null
        : box.localToGlobal(Offset.zero) & box.size;
  }

  @override
  Widget build(BuildContext context) => SwarmIconButton(
    key: const ValueKey('swarm-file-download'),
    icon: LucideIcons.download300,
    label: 'Download',
    onPressed: widget.file == null || _sharing
        ? null
        : () => unawaited(_download(_origin())),
  );
}
