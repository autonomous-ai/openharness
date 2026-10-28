import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_conversation.dart';
import 'swarm_file_picker.dart';
import 'swarm_message_row.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_style.dart';

/// The composer's + sheet: Photo library, Camera and Files, as Tony approved the mockup
/// (2026-10-28). Null is the person closing it.
Future<SwarmPickSource?> showSwarmAttachSheet(BuildContext context) =>
    showModalBottomSheet<SwarmPickSource>(
      context: context,
      backgroundColor: AppGlass.rowFill,
      barrierColor: Colors.black.withValues(alpha: .55),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => const _AttachSheet(),
    );

class _AttachSheet extends StatelessWidget {
  const _AttachSheet();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    Widget row(
      SwarmPickSource source,
      String key,
      IconData icon,
      String title,
      String detail,
    ) => Semantics(
      button: true,
      label: '$title. $detail',
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey(key),
        borderRadius: BorderRadius.circular(10),
        onTap: () => Navigator.of(context).pop(source),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Icon(icon, size: 24, color: AppPalette.textPrimary),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title, style: swarmChatText(17)),
                      Text(
                        detail,
                        style: swarmChatText(
                          13,
                          color: AppPalette.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 5,
                margin: const EdgeInsets.only(bottom: 8),
                decoration: BoxDecoration(
                  color: AppGlass.hair,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
            row(
              SwarmPickSource.library,
              'swarm-attach-library',
              LucideIcons.image,
              'Photo library',
              'Pick several at once',
            ),
            row(
              SwarmPickSource.camera,
              'swarm-attach-camera',
              LucideIcons.camera,
              'Camera',
              'Take a photo',
            ),
            row(
              SwarmPickSource.files,
              'swarm-attach-files',
              LucideIcons.file,
              'Files',
              'PDFs, logs, zips',
            ),
          ],
        ),
      ),
    );
  }
}

/// The phone refused [source], and only its Settings turns it back on: Not now, or Open
/// Settings. True for Open Settings.
Future<bool> showSwarmAccessOff(
  BuildContext context,
  SwarmPickSource source,
) async {
  final camera = source == SwarmPickSource.camera;
  final open = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      backgroundColor: AppGlass.rowFill,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: Text(
        camera ? 'Camera access is off' : 'Photos access is off',
        style: swarmChatText(17, weight: FontWeight.w600),
      ),
      content: Text(
        camera
            ? 'Allow Harness to use the camera in Settings to take a photo.'
            : 'Allow Harness to use your photos in Settings to attach them.',
        style: swarmChatText(15, color: AppPalette.textSecondary),
      ),
      actions: [
        SwarmButton(
          label: 'Not now',
          style: SwarmButtonStyle.link,
          onPressed: () => Navigator.of(context).pop(false),
        ),
        SwarmButton(
          label: 'Open Settings',
          style: SwarmButtonStyle.fill,
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ],
    ),
  );
  return open ?? false;
}

/// The files going with the next post, one chip each in a row that scrolls sideways: a picture's
/// thumbnail or a file's mark, its name, its size — or, going up, how much has gone — and ✕ to
/// take it off. Nothing while there are none.
class SwarmOutgoingChips extends StatelessWidget {
  const SwarmOutgoingChips({super.key, required this.conversation});

  final SwarmConversation conversation;

  @override
  Widget build(BuildContext context) {
    final files = conversation.files.files;
    if (files.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: 60,
      child: ListView.separated(
        key: const ValueKey('swarm-outgoing'),
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.only(bottom: 8),
        itemCount: files.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, i) => _Chip(
          file: files[i],
          progress: conversation.isUploading(files[i])
              ? conversation.uploadProgress(files[i]) ?? 0
              : null,
          onRemove: () => conversation.files.remove(files[i]),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.file,
    required this.progress,
    required this.onRemove,
  });

  final SwarmOutgoingFile file;

  /// How much has gone up, from 0 to 1, while it goes up; null otherwise.
  final double? progress;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final picture = swarmMimeForName(file.name).startsWith('image/');
    final mark = Icon(
      picture ? LucideIcons.image : LucideIcons.file,
      size: 20,
      color: AppPalette.textSecondary,
    );
    final going = progress;
    return Container(
      key: ValueKey('swarm-outgoing-${file.name}'),
      constraints: const BoxConstraints(maxWidth: 220),
      padding: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(
        color: swarmChatCard(tty),
        border: Border.all(color: swarmChatHair(tty)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: SizedBox.square(
              dimension: 36,
              child: picture
                  ? Image.memory(
                      file.bytes,
                      fit: BoxFit.cover,
                      // Decoded small: a thumbnail, not the photo.
                      cacheWidth: 108,
                      gaplessPlayback: true,
                      errorBuilder: (_, _, _) => Center(child: mark),
                    )
                  : Center(child: mark),
            ),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  file.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: swarmChatText(14),
                ),
                if (going == null)
                  Text(
                    swarmFileSize(file.bytes.length),
                    style: swarmChatText(13, color: AppPalette.textFaint),
                  )
                else
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SizedBox(
                        width: 56,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(2),
                          child: LinearProgressIndicator(
                            value: going,
                            minHeight: 4,
                            color: AppPalette.accent,
                            backgroundColor: swarmChatHair(tty),
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        '${(going * 100).round()}%',
                        style: swarmChatText(13, color: AppPalette.textFaint),
                      ),
                    ],
                  ),
              ],
            ),
          ),
          Semantics(
            button: true,
            label: 'Remove ${file.name}',
            excludeSemantics: true,
            child: GestureDetector(
              key: ValueKey('swarm-outgoing-remove-${file.name}'),
              behavior: HitTestBehavior.opaque,
              onTap: onRemove,
              child: SizedBox.square(
                dimension: 44,
                child: Icon(
                  LucideIcons.x,
                  size: 16,
                  color: AppPalette.textSecondary,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
