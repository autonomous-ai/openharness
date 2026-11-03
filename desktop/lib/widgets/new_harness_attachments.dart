import 'dart:async';
import 'dart:io';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/harness_attachments.dart';
import 'desktop_chrome.dart';
import 'new_harness_attachment_chip.dart';

/// Reads picked or dropped files into attachments, and returns what to tell the
/// person about any left out. The files are added even when the box that asked
/// is gone by now: they were picked for [attachments], and only the message about
/// them needs a place to show.
Future<String?> _attach(
  HarnessAttachments attachments,
  Iterable<XFile> files,
) async => attachments.add(await attachmentsOf(attachments, files));

/// [files] as [attachments] holds them, weighed before any is read: one over
/// its [HarnessAttachments.readUpTo] stays on disk and is read as it is sent,
/// and one over its [HarnessAttachments.limitBytes] is never read at all, as
/// [HarnessAttachments.add] refuses it by its size.
@visibleForTesting
Future<List<HarnessAttachment>> attachmentsOf(
  HarnessAttachments attachments,
  Iterable<XFile> files,
) async {
  final weighed = <HarnessAttachment>[];
  for (final file in files) {
    final size = await file.length();
    weighed.add(
      size > attachments.readUpTo
          ? HarnessAttachment.onDisk(file.name, file, size)
          : HarnessAttachment(file.name, await file.readAsBytes()),
    );
  }
  return weighed;
}

/// Attaches the dropped files and hands [onFolders] the dropped folders'
/// paths, which hold nothing to read.
Future<String?> _attachOrPaste(
  HarnessAttachments attachments,
  Iterable<DropItem> items,
  ValueChanged<List<String>> onFolders,
) async {
  final files = <XFile>[], folders = <String>[];
  for (final item in items) {
    // macOS says which items are folders; Linux and Windows give paths alone.
    final folder =
        item is DropItemDirectory ||
        (item.path.isNotEmpty && await FileSystemEntity.isDirectory(item.path));
    folder ? folders.add(item.path) : files.add(item);
  }
  if (folders.isNotEmpty) onFolders(folders);
  return files.isEmpty ? null : _attach(attachments, files);
}

/// Says what an attach left out, when it left anything.
void reportAttachProblem(BuildContext context, String? problem) {
  if (problem == null) return;
  ScaffoldMessenger.maybeOf(context)
      ?.showSnackBar(SnackBar(content: Text(problem)));
}

/// 📎 beside New Harness: opens the system's file chooser.
class NewHarnessAttachButton extends StatelessWidget {
  const NewHarnessAttachButton({
    super.key,
    required this.attachments,
    required this.enabled,
  });

  final HarnessAttachments attachments;
  final bool enabled;

  @override
  Widget build(BuildContext context) => AppIconButton(
    key: const ValueKey('new-harness-attach'),
    icon: AppIcons.paperclip,
    tooltip: 'Attach files',
    size: 16,
    onPressed: !enabled
        ? null
        : () => attachments.reading(() async {
            final files = await openFiles();
            if (files.isEmpty) return;
            final problem = await _attach(attachments, files);
            if (context.mounted) reportAttachProblem(context, problem);
          }),
  );
}

/// The attached files, each a chip its × takes back out.
class NewHarnessAttachmentChips extends StatelessWidget {
  const NewHarnessAttachmentChips({
    super.key,
    required this.attachments,
    required this.enabled,
    this.isUploading,
    this.progressOf,
  });

  final HarnessAttachments attachments;
  final bool enabled;

  /// Whether a file is on its way somewhere, when files go up as they are sent.
  final bool Function(HarnessAttachment file)? isUploading;

  /// How much of a file has gone up, from 0 to 1, or null while unknown.
  final double? Function(HarnessAttachment file)? progressOf;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: attachments,
    builder: (context, _) => Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final file in attachments.files)
          NewHarnessAttachmentChip(
            file: file,
            uploading: isUploading?.call(file) ?? false,
            progress: progressOf?.call(file),
            onRemove: enabled ? () => attachments.remove(file) : null,
          ),
      ],
    ),
  );
}

/// Files dropped anywhere on [child] are attached; while a drag is over it,
/// it says so.
class NewHarnessDropZone extends StatefulWidget {
  const NewHarnessDropZone({
    super.key,
    required this.attachments,
    required this.enabled,
    required this.child,
    this.onFolders,
  });

  final HarnessAttachments attachments;
  final bool enabled;
  final Widget child;

  /// Told the paths of dropped folders, which are then not attached. Without
  /// it every dropped item is read as a file.
  final ValueChanged<List<String>>? onFolders;

  @override
  State<NewHarnessDropZone> createState() => _NewHarnessDropZoneState();
}

class _NewHarnessDropZoneState extends State<NewHarnessDropZone> {
  bool _hovering = false;

  void _hover(bool value) {
    if (mounted && _hovering != value) setState(() => _hovering = value);
  }

  @override
  Widget build(BuildContext context) => DropTarget(
    key: const ValueKey('new-harness-drop'),
    enable: widget.enabled,
    onDragEntered: (_) => _hover(true),
    onDragExited: (_) => _hover(false),
    onDragDone: (details) {
      _hover(false);
      final onFolders = widget.onFolders;
      // The box the files were dropped on, held until they are read.
      final attachments = widget.attachments;
      unawaited(
        attachments.reading(() async {
          final problem = onFolders == null
              ? await _attach(attachments, details.files)
              : await _attachOrPaste(attachments, details.files, onFolders);
          if (context.mounted) reportAttachProblem(context, problem);
        }),
      );
    },
    child: Stack(
      children: [
        widget.child,
        if (_hovering)
          Positioned.fill(
            child: IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: DesktopChrome.accent.withValues(alpha: .1),
                  border: Border.all(color: DesktopChrome.accent, width: 1.5),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Center(
                  child: Text(
                    'Drop files to attach',
                    style: DesktopChrome.control(
                      color: DesktopChrome.accent,
                      medium: true,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    ),
  );
}
