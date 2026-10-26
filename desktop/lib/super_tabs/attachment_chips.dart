import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/file_type_icon.dart';
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/update_notice.dart' show formatDownloadSize;
import 'attachment_upload.dart';
import 'attachment_viewer.dart';
import 'model.dart';

/// The files a message carries, one chip each. The chat never loads a file by
/// itself: a chip only names it, and a click opens it — an image or a text
/// file in a viewer that fetches it then, anything else in the browser.
class SuperTabAttachmentChips extends StatelessWidget {
  const SuperTabAttachmentChips(this.attachments, {super.key});

  final List<SuperTabAttachment> attachments;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 6,
    runSpacing: 6,
    children: [for (final file in attachments) _AttachmentChip(file: file)],
  );
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({required this.file});

  final SuperTabAttachment file;

  Future<void> _open(BuildContext context) async {
    final url = attachmentLink(file.url);
    if (url == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(
          content: Text(
            'This file isn’t on Harness’s file storage, so it wasn’t opened.',
          ),
        ),
      );
      return;
    }
    if (file.isImage) {
      await showAppDialog<void>(
        context: context,
        builder: (_) => _ImageViewer(file: file, url: url),
      );
    } else if (opensAsText(file)) {
      await showAppDialog<void>(
        context: context,
        builder: (_) => AttachmentTextViewer(file: file, url: url),
      );
    } else {
      await openInBrowser(url);
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = formatDownloadSize(file.size);
    return Material(
      color: DesktopChrome.foreground.withValues(alpha: .055),
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        key: ValueKey('super-attachment:${file.id}'),
        borderRadius: BorderRadius.circular(20),
        onTap: () => _open(context),
        child: Container(
          constraints: const BoxConstraints(maxWidth: 280),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          // A phone's chip is a finger tall.
          height: fingerHeight(
            DesktopChrome.compactControlHeight,
            enabled: workspaceIsCompact(context),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                fileTypeIcon(file.name),
                size: 13,
                color: DesktopChrome.muted,
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  file.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.control(),
                ),
              ),
              if (size.isNotEmpty) ...[
                const SizedBox(width: 6),
                Text(size, style: DesktopChrome.metadata()),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The picture, fetched when this opens.
class _ImageViewer extends StatelessWidget {
  const _ImageViewer({required this.file, required this.url});

  final SuperTabAttachment file;
  final Uri url;

  @override
  Widget build(BuildContext context) => Dialog(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            file.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.control(medium: true),
          ),
          const SizedBox(height: 12),
          Flexible(
            child: InteractiveViewer(
              child: Image.network(
                url.toString(),
                key: ValueKey('super-attachment-image:${file.id}'),
                fit: BoxFit.contain,
                loadingBuilder: (_, child, progress) => progress == null
                    ? child
                    : const Center(child: CircularProgressIndicator()),
                errorBuilder: (_, _, _) => Center(
                  child: Text(
                    'This image can’t be shown here.',
                    style: DesktopChrome.metadata(),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          AttachmentViewerActions(file: file, url: url),
        ],
      ),
    ),
  );
}
