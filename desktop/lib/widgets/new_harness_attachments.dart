import 'dart:async';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/harness_attachments.dart';
import 'desktop_chrome.dart';
import 'new_harness_attachment_chip.dart';

/// Reads picked or dropped files into attachments, and says what was left out.
Future<void> _attach(
  BuildContext context,
  HarnessAttachments attachments,
  Iterable<XFile> files,
) async {
  final read = [
    for (final file in files)
      HarnessAttachment(file.name, await file.readAsBytes()),
  ];
  if (context.mounted) reportAttachProblem(context, attachments.add(read));
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
        : () async {
            final files = await openFiles();
            if (files.isEmpty || !context.mounted) return;
            await _attach(context, attachments, files);
          },
  );
}

/// The attached files, each a chip its × takes back out.
class NewHarnessAttachmentChips extends StatelessWidget {
  const NewHarnessAttachmentChips({
    super.key,
    required this.attachments,
    required this.enabled,
  });

  final HarnessAttachments attachments;
  final bool enabled;

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
  });

  final HarnessAttachments attachments;
  final bool enabled;
  final Widget child;

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
      unawaited(_attach(context, widget.attachments, details.files));
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
