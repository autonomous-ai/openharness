import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/harness_attachments.dart';

import 'tty.dart';
import 'tty_controls.dart' show TtySize;

/// Opens the system's document picker for any number of files — Files on iOS, the Storage Access
/// Framework on Android. Empty is the person backing out. Replaced in tests, where there is no
/// picker to open.
@visibleForTesting
Future<List<XFile>> Function() pickAttachmentFiles = () => openFiles();

/// The New form's 📎: what the person picks, read into [attachments]. Null when everything picked
/// was taken (or nothing was), else the one line to show — the desktop's words for a file over the
/// limit, which is refused before it is read.
Future<String?> addPickedAttachments(HarnessAttachments attachments) async {
  final List<XFile> picked;
  try {
    picked = await pickAttachmentFiles();
  } on PlatformException {
    return 'Could not open the picker.';
  }
  if (picked.isEmpty) return null;
  final files = <HarnessAttachment>[];
  final oversized = <String>[];
  String? unreadable;
  for (final file in picked) {
    final name = file.name.isEmpty ? 'file' : file.name;
    try {
      if (await file.length() > HarnessAttachments.maxBytes) {
        oversized.add(name);
        continue;
      }
    } catch (_) {
      // No size to read is no reason to refuse yet: the read below says whether it is there.
    }
    try {
      files.add(HarnessAttachment(name, await file.readAsBytes()));
    } catch (_) {
      unreadable ??= name;
    }
  }
  final tooLarge = attachments.add(files, oversized: oversized);
  return tooLarge ?? (unreadable == null ? null : 'Could not read $unreadable');
}

/// The 📎 inside the task field, beside its mic.
class AttachmentButton extends StatelessWidget {
  const AttachmentButton({super.key, required this.onTap});

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: 'Attach files',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('new-agent-attach'),
        behavior: HitTestBehavior.opaque,
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap!();
              },
        child: SizedBox(
          width: 44,
          height: 44,
          child: Center(
            child: Icon(
              LucideIcons.paperclip300,
              size: 18,
              color: onTap == null ? tty.dim : tty.text,
            ),
          ),
        ),
      ),
    );
  }
}

/// The files the harness will be handed, one line each under the task: the name, and × to take
/// it back off. Nothing while there are none.
class AttachmentList extends StatelessWidget {
  const AttachmentList({
    super.key,
    required this.attachments,
    required this.enabled,
  });

  final HarnessAttachments attachments;

  /// False while the form is starting: the files are the ones on their way.
  final bool enabled;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: attachments,
    builder: (context, _) {
      final tty = Tty.of(context);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final file in attachments.files)
            Row(
              key: ValueKey('attachment-${file.name}'),
              children: [
                Icon(LucideIcons.paperclip300, size: 14, color: tty.faint),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    file.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: tty.style(color: tty.dim, size: TtySize.meta),
                  ),
                ),
                Semantics(
                  button: true,
                  label: 'Remove ${file.name}',
                  excludeSemantics: true,
                  child: GestureDetector(
                    key: ValueKey('attachment-remove-${file.name}'),
                    behavior: HitTestBehavior.opaque,
                    onTap: enabled ? () => attachments.remove(file) : null,
                    child: SizedBox(
                      width: 44,
                      height: 36,
                      child: Center(
                        child: Icon(
                          LucideIcons.x300,
                          size: 14,
                          color: enabled ? tty.faint : tty.dim,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
        ],
      );
    },
  );
}
