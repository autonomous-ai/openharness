import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'attachment_viewer.dart';
import 'model.dart';

/// A picture in a message, as Slack shows one: at most [maxSide] each way
/// with its shape kept, and a click opens it full screen. [url] is the
/// message's own link on the attachments host, which only members are given.
class SuperTabInlineImage extends StatelessWidget {
  const SuperTabInlineImage({super.key, required this.file, required this.url});

  static const maxSide = 360.0;

  final SuperTabAttachment file;
  final Uri url;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final radius = BorderRadius.circular(DesktopChrome.controlRadius);
    return Semantics(
      button: true,
      image: true,
      label: '${file.name}, open full screen',
      child: Material(
        color: Colors.transparent,
        borderRadius: radius,
        child: InkWell(
          key: ValueKey('super-attachment-inline:${file.id}'),
          borderRadius: radius,
          mouseCursor: SystemMouseCursors.click,
          onTap: () => showAppDialog<void>(
            context: context,
            builder: (_) => SuperTabImageViewer(file: file, url: url),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: maxSide,
              maxHeight: maxSide,
            ),
            child: ClipRRect(
              borderRadius: radius,
              child: ExcludeSemantics(
                child: Image(
                  image: attachmentPicture(url),
                  fit: BoxFit.contain,
                  frameBuilder: (_, child, frame, synchronous) =>
                      frame == null && !synchronous ? _loading() : child,
                  errorBuilder: (_, _, _) => _broken(file),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Still, not pulsing: a picture's shape is unknown until it arrives.
  static Widget _loading() => SizedBox(
    width: maxSide * 2 / 3,
    height: maxSide / 2,
    child: ColoredBox(color: DesktopChrome.field),
  );

  static Widget _broken(SuperTabAttachment file) => Container(
    color: DesktopChrome.field,
    padding: const EdgeInsets.all(grid.AppDesktop.controlGap),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          AppIcons.fileImage,
          size: grid.AppDesktop.iconSize,
          color: DesktopChrome.muted,
        ),
        const SizedBox(width: grid.AppDesktop.controlGap),
        Flexible(
          child: Text(
            '${file.name} can’t be shown here.',
            style: DesktopChrome.metadata(),
          ),
        ),
      ],
    ),
  );
}

/// A message's picture over the whole window, fetched when it opens, with
/// Download, Open in browser and Close.
class SuperTabImageViewer extends StatelessWidget {
  const SuperTabImageViewer({super.key, required this.file, required this.url});

  final SuperTabAttachment file;
  final Uri url;

  @override
  Widget build(BuildContext context) => Dialog.fullscreen(
    key: ValueKey('super-attachment-viewer:${file.id}'),
    backgroundColor: DesktopChrome.surface,
    child: Padding(
      padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            file.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.control(medium: true),
          ),
          const SizedBox(height: grid.AppDesktop.groupGap),
          Expanded(
            child: InteractiveViewer(
              child: Image(
                key: ValueKey('super-attachment-image:${file.id}'),
                image: attachmentPicture(url),
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
          const SizedBox(height: grid.AppDesktop.groupGap),
          AttachmentViewerActions(file: file, url: url),
        ],
      ),
    ),
  );
}
