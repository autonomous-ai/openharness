import 'dart:io';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'swarm_file_picker.dart';
import 'swarm_message_row.dart'
    show swarmChatCard, swarmChatHair, swarmFileSize;
import 'swarm_outgoing_files.dart';
import 'swarm_style.dart';

/// The composer's + sheet: Photo library, Camera and Files, as Tony approved the mockup
/// (2026-10-28). Null is the person closing it.
Future<SwarmPickSource?> showSwarmAttachSheet(BuildContext context) =>
    showModalBottomSheet<SwarmPickSource>(
      context: context,
      backgroundColor: AppGlass.rowFill,
      shape: AppControl.sheetShape,
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
        borderRadius: BorderRadius.circular(AppControl.radius),
        onTap: () => Navigator.of(context).pop(source),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minTouchTarget),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.m,
              vertical: AppSpace.s,
            ),
            child: Row(
              children: [
                Icon(
                  icon,
                  size: AppIconSize.standalone,
                  color: AppPalette.textPrimary,
                ),
                const SizedBox(width: AppSpace.l),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: AppType.body(color: AppPalette.textPrimary),
                      ),
                      Text(
                        detail,
                        style: AppType.caption(color: AppPalette.textSecondary),
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
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          AppSpace.l,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The grabber: a capsule as wide as the two largest steps.
            Center(
              child: Container(
                width: AppSpace.xl + AppSpace.m,
                height: AppSpace.xs,
                margin: const EdgeInsets.only(bottom: AppSpace.s),
                decoration: ShapeDecoration(
                  color: AppGlass.hair,
                  shape: const StadiumBorder(),
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
    // The theme's dialog: its fill and Desktop's dialog radius.
    builder: (context) => AlertDialog(
      title: Text(
        camera ? 'Camera access is off' : 'Photos access is off',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Text(
        camera
            ? 'Allow Harness to use the camera in Settings to take a photo.'
            : 'Allow Harness to use your photos in Settings to attach them.',
        style: AppType.body(color: AppPalette.textSecondary),
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
  const SwarmOutgoingChips({super.key, required this.box});

  /// The chat's composer, or a thread's reply box.
  final SwarmFilesBox box;

  @override
  Widget build(BuildContext context) {
    final files = box.files.files;
    if (files.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: _chipHeight + AppSpace.s,
      child: ListView.separated(
        key: const ValueKey('swarm-outgoing'),
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.only(bottom: AppSpace.s),
        itemCount: files.length,
        separatorBuilder: (_, _) => const SizedBox(width: AppSpace.s),
        itemBuilder: (context, i) => _Chip(
          file: files[i],
          progress: box.isUploading(files[i])
              ? box.uploadProgress(files[i]) ?? 0
              : null,
          onRemove: () => box.files.remove(files[i]),
        ),
      ),
    );
  }
}

/// A chip's thumbnail: the 44-point target less a step, so the chip with its inset is a target and
/// a step tall.
const _thumbnail = minTouchTarget - AppSpace.s;
const _chipHeight = _thumbnail + 2 * AppSpace.s;

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
      size: AppIconSize.besideText,
      color: AppPalette.textSecondary,
    );
    final going = progress;
    return Container(
      key: ValueKey('swarm-outgoing-${file.name}'),
      // A long name gives way first: a chip takes at most most of the row.
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * .6,
        minHeight: _chipHeight,
      ),
      padding: const EdgeInsets.only(left: AppSpace.s),
      decoration: BoxDecoration(
        color: swarmChatCard(tty),
        border: Border.all(color: swarmChatHair(tty)),
        borderRadius: BorderRadius.circular(AppControl.radius),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(AppCard.insetRadius),
            child: SizedBox.square(
              dimension: _thumbnail,
              child: switch ((picture, file.bytes, file.path)) {
                // Decoded small: a thumbnail, not the photo — three pixels a
                // point, a phone's sharpest. A large picture is decoded from
                // its file, never read whole into memory to show.
                (true, final bytes?, _) => Image.memory(
                  bytes,
                  fit: BoxFit.cover,
                  cacheWidth: (_thumbnail * 3).round(),
                  gaplessPlayback: true,
                  errorBuilder: (_, _, _) => Center(child: mark),
                ),
                (true, null, final path?) => Image.file(
                  File(path),
                  fit: BoxFit.cover,
                  cacheWidth: (_thumbnail * 3).round(),
                  gaplessPlayback: true,
                  errorBuilder: (_, _, _) => Center(child: mark),
                ),
                _ => Center(child: mark),
              },
            ),
          ),
          const SizedBox(width: AppSpace.s),
          Flexible(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  file.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.caption(color: AppPalette.textPrimary),
                ),
                if (going == null)
                  Text(
                    swarmFileSize(file.size),
                    style: AppType.caption(
                      color: AppPalette.textFaint,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  )
                else
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SizedBox(
                        width: minTouchTarget,
                        child: ClipPath(
                          clipper: const ShapeBorderClipper(
                            shape: StadiumBorder(),
                          ),
                          child: LinearProgressIndicator(
                            value: going,
                            minHeight: AppSpace.xs,
                            color: AppPalette.accent,
                            backgroundColor: swarmChatHair(tty),
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpace.s),
                      Text(
                        '${(going * 100).round()}%',
                        style: AppType.caption(
                          color: AppPalette.textFaint,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
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
                dimension: minTouchTarget,
                child: Icon(
                  LucideIcons.x,
                  size: AppIconSize.besideText,
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
