import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/file_type_icon.dart';
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/update_notice.dart' show formatDownloadSize;
import 'attachment_image.dart';
import 'attachment_upload.dart';
// A browser leaves the text viewer, and the Finder editor under it, out of main.dart.js.
import 'attachment_text_viewer.dart'
    if (dart.library.js_interop) '../web/parts/attachment_text_viewer.dart';
import 'attachment_viewer.dart';
import 'model.dart';

/// The files a message carries, as Slack shows them: each picture on the
/// attachments host in place (`attachment_image.dart`, on a computer), every
/// other file one chip. A chip only names its file, and a click opens it — a text file in a
/// viewer that fetches it then, anything else in the browser.
class SuperTabAttachments extends StatelessWidget {
  const SuperTabAttachments(this.attachments, {super.key});

  final List<SuperTabAttachment> attachments;

  @override
  Widget build(BuildContext context) {
    final pictures = <(SuperTabAttachment, Uri)>[];
    final chips = <SuperTabAttachment>[];
    for (final file in attachments) {
      // A browser's fetch follows a redirect off the attachments host, so
      // there a picture stays a chip that opens in a new tab. A picture over
      // the form's limit is a chip too: every reader would fetch and decode
      // it whole to draw it in place.
      final url =
          file.isImage &&
              file.size <= kSuperTabFormAttachmentMaxBytes &&
              !kIsWeb
          ? attachmentLink(file.url)
          : null;
      url == null ? chips.add(file) : pictures.add((file, url));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: grid.AppDesktop.controlGap,
      children: [
        for (final (file, url) in pictures)
          SuperTabInlineImage(file: file, url: url),
        if (chips.isNotEmpty)
          Wrap(
            spacing: grid.AppDesktop.menuInset,
            runSpacing: grid.AppDesktop.menuInset,
            children: [for (final file in chips) _AttachmentChip(file: file)],
          ),
      ],
    );
  }
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
    if (opensAsText(file)) {
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
                const SizedBox(width: grid.AppDesktop.menuInset),
                Text('·', style: DesktopChrome.metadata()),
                const SizedBox(width: grid.AppDesktop.menuInset),
                Text(size, style: DesktopChrome.metadata()),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
