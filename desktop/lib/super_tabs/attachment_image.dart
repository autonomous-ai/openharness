import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'attachment_upload.dart';
import 'attachment_viewer.dart';
import 'file_links.dart';
import 'message_more_menu.dart';
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
    if (!mounted) return;
    // Another file, Swarm or account now: this answer is not for what is
    // shown. The ask is over all the same, and the one shown now is asked for.
    if (!identical(ref, _ref)) {
      _asking = false;
      if (_url == null && !_failed) _ask(stale: false);
      return;
    }
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
          onTap: () =>
              superTabOpenImages(context, [SuperTabImageItem(ref: _ref)], 0),
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

/// Opens [images] at [index] over the whole window.
void superTabOpenImages(
  BuildContext context,
  List<SuperTabImageItem> images,
  int index,
) => unawaited(
  showGeneralDialog<void>(
    context: context,
    barrierColor: Colors.transparent,
    pageBuilder: (context, _, _) => SuperTabImageViewer(
      images: images,
      index: index,
      onClose: () => Navigator.pop(context),
    ),
  ),
);

/// One picture the viewer pages through: the file, and who posted it, when
/// and where, as the chat names them.
@immutable
class SuperTabImageItem {
  const SuperTabImageItem({
    required this.ref,
    this.sender,
    this.avatar,
    this.postedAt,
    this.place,
    this.onShowInChat,
  });

  final SuperTabFileRef ref;

  /// The sender's name and face, as their row shows them.
  final String? sender;
  final Widget? avatar;
  final DateTime? postedAt;

  /// Where it was posted: "# openharness".
  final String? place;

  /// Goes to its message in the chat; More offers it.
  final VoidCallback? onShowInChat;

  SuperTabAttachment get file => ref.file;
}

/// How long ago a picture was posted, in words: "just now", "5 minutes ago",
/// "14 days ago".
String superTabPostedAgo(Duration age) {
  String ago(int count, String unit) =>
      '$count $unit${count == 1 ? '' : 's'} ago';
  if (age.inMinutes < 1) return 'just now';
  if (age.inHours < 1) return ago(age.inMinutes, 'minute');
  if (age.inDays < 1) return ago(age.inHours, 'hour');
  return ago(age.inDays, 'day');
}

/// A chat's pictures as Slack shows them (Huy, 11-04): over a see-through
/// dark veil, the sender, when and where at the top left, the picture in the
/// middle with previous and next (and the Left and Right keys) through
/// [images], rotate and zoom at the bottom left, Download, Open in browser
/// and More at the bottom right. Esc, ×, or a click on the veil calls
/// [onClose]. Each picture is drawn from its link at hand, else a fresh one.
class SuperTabImageViewer extends StatefulWidget {
  const SuperTabImageViewer({
    super.key,
    required this.images,
    required this.index,
    required this.onClose,
  }) : assert(images.length > 0);

  final List<SuperTabImageItem> images;
  final int index;
  final VoidCallback onClose;

  static const zoomMin = 1.0, zoomMax = 4.0, zoomStep = .25;

  @override
  State<SuperTabImageViewer> createState() => _SuperTabImageViewerState();
}

class _SuperTabImageViewerState extends State<SuperTabImageViewer> {
  late int _index = widget.index.clamp(0, widget.images.length - 1);
  final _zoom = TransformationController();
  int _turns = 0;
  Size _viewport = Size.zero;

  /// The shown picture's link; null while one is asked for, or when none
  /// came ([_failed]).
  Uri? _url;
  bool _failed = false;

  SuperTabImageItem get _item => widget.images[_index];
  double get _scale => _zoom.value.getMaxScaleOnAxis();

  @override
  void initState() {
    super.initState();
    _zoom.addListener(_zoomed);
    _load();
  }

  @override
  void dispose() {
    _zoom
      ..removeListener(_zoomed)
      ..dispose();
    super.dispose();
  }

  void _zoomed() => setState(() {});

  void _load() {
    final ref = _item.ref;
    _url = ref.current;
    _failed = false;
    if (_url != null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final url = await superTabOpenableLink(context, ref);
      // Another picture is shown by now: this answer is not for it.
      if (!mounted || !identical(ref, _item.ref)) return;
      setState(() {
        _url = url;
        _failed = url == null;
      });
    });
  }

  /// Shows the picture at [to], unturned at 100%; past either end, nothing.
  void _go(int to) {
    if (to < 0 || to >= widget.images.length || to == _index) return;
    setState(() {
      _index = to;
      _turns = 0;
      _zoom.value = Matrix4.identity();
      _load();
    });
  }

  /// Zooms to [scale] about the middle of the picture's area.
  void _setZoom(double scale) {
    final s = scale.clamp(
      SuperTabImageViewer.zoomMin,
      SuperTabImageViewer.zoomMax,
    );
    final middle = _viewport.center(Offset.zero);
    _zoom.value = Matrix4.diagonal3Values(s, s, 1)
      ..setTranslationRaw(middle.dx * (1 - s), middle.dy * (1 - s), 0);
  }

  /// The next step of [SuperTabImageViewer.zoomStep] up or down from now.
  void _step(int direction) {
    const step = SuperTabImageViewer.zoomStep;
    final at = _scale / step;
    // A pinch may leave it between steps: the next whole step that way.
    final steps = direction > 0
        ? (at + 1e-6).floor() + 1
        : (at - 1e-6).ceil() - 1;
    _setZoom(steps * step);
  }

  KeyEventResult _key(FocusNode _, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      if (event is KeyDownEvent) widget.onClose();
    } else if (key == LogicalKeyboardKey.arrowLeft) {
      _go(_index - 1);
    } else if (key == LogicalKeyboardKey.arrowRight) {
      _go(_index + 1);
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  Widget _button(
    String name,
    IconData icon,
    String tooltip,
    VoidCallback? onPressed, {
    double size = AppIcons.inlineSize,
  }) => AppIconButton(
    key: ValueKey('super-image-$name'),
    icon: icon,
    tooltip: tooltip,
    size: size,
    color: grid.AppDesktop.mediaInkMuted,
    hoverColor: grid.AppDesktop.mediaInk,
    hoverFill: grid.AppDesktop.mediaControlHover,
    onPressed: onPressed,
  );

  /// Previous or next, in a round well at the picture's side; nothing past
  /// either end.
  Widget _arrow(bool next) {
    final to = _index + (next ? 1 : -1);
    final shown = to >= 0 && to < widget.images.length;
    return SizedBox(
      width: _side,
      child: !shown
          ? null
          : Center(
              child: DecoratedBox(
                decoration: const BoxDecoration(
                  color: grid.AppDesktop.mediaControl,
                  shape: BoxShape.circle,
                ),
                child: _button(
                  next ? 'next' : 'previous',
                  next ? AppIcons.chevronRight : AppIcons.chevronLeft,
                  next ? 'Next' : 'Previous',
                  () => _go(to),
                  size: grid.AppDesktop.iconSize + 4,
                ),
              ),
            ),
    );
  }

  static const _side = 72.0;
  static const _ink = grid.AppDesktop.mediaInk;

  Widget _header() {
    final item = _item;
    final posted = item.postedAt;
    final when = [
      if (posted != null)
        superTabPostedAgo(DateTime.now().difference(posted.toLocal())),
      if (item.place case final place?) 'in $place',
    ].join(' ');
    return Row(
      children: [
        if (item.avatar case final avatar?) ...[
          avatar,
          const SizedBox(width: grid.AppDesktop.controlGap + 4),
        ],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (item.sender case final sender?)
                Text(
                  sender,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.control(color: _ink, medium: true),
                ),
              Text(
                [if (when.isNotEmpty) when, item.file.name].join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(
                  color: grid.AppDesktop.mediaInkMuted,
                ),
              ),
            ],
          ),
        ),
        _button('close', AppIcons.close, 'Close', widget.onClose),
      ],
    );
  }

  Widget _picture() {
    final file = _item.file;
    final url = _url;
    if (url == null) {
      return _failed
          ? Text(
              'This image can’t be shown here.',
              style: DesktopChrome.metadata(
                color: grid.AppDesktop.mediaInkMuted,
              ),
            )
          : const CircularProgressIndicator(color: _ink);
    }
    return RotatedBox(
      quarterTurns: _turns,
      child: Image(
        key: ValueKey('super-attachment-image:${file.id}'),
        image: attachmentPicture(url),
        fit: BoxFit.contain,
        loadingBuilder: (_, child, progress) => progress == null
            ? child
            : const CircularProgressIndicator(color: _ink),
        errorBuilder: (_, _, _) => Text(
          'This image can’t be shown here.',
          style: DesktopChrome.metadata(color: grid.AppDesktop.mediaInkMuted),
        ),
      ),
    );
  }

  Widget _controls() {
    final scale = _scale.clamp(
      SuperTabImageViewer.zoomMin,
      SuperTabImageViewer.zoomMax,
    );
    final item = _item;
    final url = _url;
    return Row(
      children: [
        _button(
          'rotate',
          AppIcons.rotateCw,
          'Rotate',
          () => setState(() => _turns = (_turns + 1) % 4),
        ),
        const SizedBox(width: grid.AppDesktop.groupGap),
        _button(
          'zoom-out',
          AppIcons.minus,
          'Zoom out',
          scale <= SuperTabImageViewer.zoomMin ? null : () => _step(-1),
        ),
        SizedBox(
          width: 160,
          child: SliderTheme(
            data: SliderTheme.of(context).copyWith(
              activeTrackColor: _ink,
              inactiveTrackColor: grid.AppDesktop.mediaControlHover,
              thumbColor: _ink,
              overlayColor: grid.AppDesktop.mediaControl,
            ),
            child: Slider(
              key: const ValueKey('super-image-zoom'),
              value: scale,
              min: SuperTabImageViewer.zoomMin,
              max: SuperTabImageViewer.zoomMax,
              divisions:
                  ((SuperTabImageViewer.zoomMax - SuperTabImageViewer.zoomMin) /
                          SuperTabImageViewer.zoomStep)
                      .round(),
              semanticFormatterCallback: (value) => '${(value * 100).round()}%',
              onChanged: _setZoom,
            ),
          ),
        ),
        _button(
          'zoom-in',
          AppIcons.plus,
          'Zoom in',
          scale >= SuperTabImageViewer.zoomMax ? null : () => _step(1),
        ),
        const SizedBox(width: grid.AppDesktop.controlGap),
        SizedBox(
          width: 44,
          child: Text(
            '${(scale * 100).round()}%',
            style: DesktopChrome.metadata(color: grid.AppDesktop.mediaInkMuted),
          ),
        ),
        Expanded(
          child: url == null
              ? const SizedBox.shrink()
              : AttachmentViewerActions(
                  key: ValueKey('super-image-actions:${item.file.id}'),
                  file: item.file,
                  url: url,
                  ref: item.ref,
                  close: false,
                  ink: _ink,
                  more: switch (item.onShowInChat) {
                    final show? => SuperTabMessageMoreMenu(
                      color: grid.AppDesktop.mediaInkMuted,
                      hoverColor: _ink,
                      hoverFill: grid.AppDesktop.mediaControlHover,
                      actions: [
                        (
                          label: 'Show in chat',
                          icon: AppIcons.messageSquare,
                          onPressed: () {
                            widget.onClose();
                            show();
                          },
                        ),
                      ],
                    ),
                    null => null,
                  },
                ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return FocusScope(
      autofocus: true,
      onKeyEvent: _key,
      child: Material(
        key: const ValueKey('super-attachment-viewer'),
        color: grid.AppDesktop.mediaVeil,
        child: GestureDetector(
          // A click on the veil closes it; the picture and the controls keep
          // their own.
          key: const ValueKey('super-image-veil'),
          behavior: HitTestBehavior.opaque,
          onTap: widget.onClose,
          child: Padding(
            padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
            child: Column(
              children: [
                _header(),
                const SizedBox(height: grid.AppDesktop.groupGap),
                Expanded(
                  child: Row(
                    children: [
                      _arrow(false),
                      Expanded(
                        child: LayoutBuilder(
                          builder: (context, constraints) {
                            _viewport = constraints.biggest;
                            return InteractiveViewer(
                              transformationController: _zoom,
                              minScale: SuperTabImageViewer.zoomMin,
                              maxScale: SuperTabImageViewer.zoomMax,
                              child: Center(
                                child: GestureDetector(
                                  onTap: () {},
                                  child: _picture(),
                                ),
                              ),
                            );
                          },
                        ),
                      ),
                      _arrow(true),
                    ],
                  ),
                ),
                const SizedBox(height: grid.AppDesktop.groupGap),
                _controls(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
