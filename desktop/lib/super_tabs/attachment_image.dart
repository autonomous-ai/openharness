import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'attachment_upload.dart';
import 'attachment_viewer.dart';
import 'file_links.dart';
import 'model.dart';

/// A picture in a message, as Slack shows one: at most [maxSide] each way
/// with its shape kept, and a click opens it full screen. Drawn from the
/// message's own short-lived link while it lasts, else from a fresh one
/// (backend fileLinks.ts); a signed link that fails to load is asked for once
/// more, and a second failure says the picture can't be shown.
class SuperTabInlineImage extends StatefulWidget {
  const SuperTabInlineImage({super.key, required this.file});

  static const maxSide = 360.0;

  final SuperTabFileRef file;

  @override
  State<SuperTabInlineImage> createState() => _SuperTabInlineImageState();
}

class _SuperTabInlineImageState extends State<SuperTabInlineImage> {
  late SuperTabFileRef _ref = widget.file;

  /// The link drawn from; null while one is asked for, or when none came.
  Uri? _url;
  bool _asking = false, _retried = false, _failed = false;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void didUpdateWidget(SuperTabInlineImage old) {
    super.didUpdateWidget(old);
    final was = old.file.file, now = widget.file.file;
    if (was.id == now.id &&
        was.url == now.url &&
        old.file.fresh == widget.file.fresh) {
      return;
    }
    _ref = widget.file;
    _retried = _failed = false;
    _start();
  }

  void _start() {
    _url = _ref.current;
    // Asked after this frame: the view's fresh-link source is read then.
    if (_url == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _ask(stale: false));
    }
  }

  Future<void> _ask({required bool stale}) async {
    if (!mounted || _asking) return;
    final ref = _ref;
    setState(() => _asking = true);
    final url = await superTabOpenableLink(context, ref, stale: stale);
    // Gone, or another file now: this answer is not for what is shown.
    if (!mounted || !identical(ref, _ref)) return;
    setState(() {
      _asking = false;
      _url = url;
      _failed = url == null;
    });
  }

  /// The picture did not load. A short-lived link may have ended under it:
  /// asked for once more. An older server's permanent link is not.
  void _broke() {
    final signed = _url?.host == kSuperTabFilesHost;
    if (_retried || !signed || _failed) {
      if (!_failed) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) setState(() => _failed = true);
        });
      }
      return;
    }
    _retried = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      setState(() => _url = null);
      _ask(stale: true);
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final file = _ref.file;
    final url = _url;
    // No link at all: nothing to open either. A link that failed to draw
    // stays a click away, as the full-screen viewer may still read it.
    if (url == null) return _failed ? _broken(file) : _loading();
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
            builder: (_) =>
                SuperTabImageViewer(file: file, url: url, ref: _ref),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: SuperTabInlineImage.maxSide,
              maxHeight: SuperTabInlineImage.maxSide,
            ),
            child: ClipRRect(
              borderRadius: radius,
              child: ExcludeSemantics(
                child: Image(
                  image: attachmentPicture(url),
                  fit: BoxFit.contain,
                  frameBuilder: (_, child, frame, synchronous) =>
                      frame == null && !synchronous ? _loading() : child,
                  errorBuilder: (_, _, _) {
                    if (_failed) return _broken(file);
                    _broke();
                    return _loading();
                  },
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
    width: SuperTabInlineImage.maxSide * 2 / 3,
    height: SuperTabInlineImage.maxSide / 2,
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
/// Download, Open in browser and Close. [ref] gives those two a fresh link
/// once [url] is about to end.
class SuperTabImageViewer extends StatelessWidget {
  const SuperTabImageViewer({
    super.key,
    required this.file,
    required this.url,
    this.ref,
  });

  final SuperTabAttachment file;
  final Uri url;
  final SuperTabFileRef? ref;

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
          AttachmentViewerActions(file: file, url: url, ref: ref),
        ],
      ),
    ),
  );
}
