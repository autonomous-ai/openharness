import 'package:flutter/material.dart';

import '../clipboard/image_bytes.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/file_type_icon.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/harness_attachments.dart';
import 'desktop_chrome.dart';

/// One attached file: its mark, its name, and the × that takes it back out.
class NewHarnessAttachmentChip extends StatelessWidget {
  const NewHarnessAttachmentChip({
    super.key,
    required this.file,
    required this.onRemove,
  });

  final HarnessAttachment file;
  final VoidCallback? onRemove;

  /// A picture shows itself; anything else, the mark of its kind.
  Widget _mark() {
    final icon = Icon(
      fileTypeIcon(file.name),
      key: ValueKey('new-harness-attachment-icon:${file.name}'),
      size: 13,
      color: DesktopChrome.muted,
    );
    if (!looksLikeImage(file.bytes)) return icon;
    return ClipRRect(
      borderRadius: BorderRadius.circular(3),
      child: Image.memory(
        file.bytes,
        key: ValueKey('new-harness-attachment-preview:${file.name}'),
        width: _previewSize,
        height: _previewSize,
        // Decoded at the size it is drawn, not the screenshot's own.
        cacheWidth: _previewSize.toInt() * 3,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) => icon,
      ),
    );
  }

  static const _previewSize = 16.0;

  @override
  Widget build(BuildContext context) => Container(
    key: ValueKey('new-harness-attachment:${file.name}'),
    constraints: const BoxConstraints(maxWidth: 220),
    padding: const EdgeInsets.only(left: 10, right: 2),
    height: DesktopChrome.compactControlHeight,
    decoration: BoxDecoration(
      color: DesktopChrome.foreground.withValues(alpha: .055),
      borderRadius: BorderRadius.circular(20),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _mark(),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            file.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.control(),
          ),
        ),
        AppIconButton(
          icon: AppIcons.close,
          tooltip: 'Remove ${file.name}',
          size: AppIcons.closeSize,
          onPressed: onRemove,
        ),
      ],
    ),
  );
}
