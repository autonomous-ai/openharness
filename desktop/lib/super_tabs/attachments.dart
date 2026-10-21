import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../clipboard/copied_files.dart';
import '../clipboard/native_clipboard.dart';
import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/harness_attachments.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// The backend's limits (backend/src/superTabs/attachments.ts): a message
/// carries up to four PNG, JPEG or WebP images of up to 5 MB each.
const kSuperTabImagesPerMessage = 4;
const kSuperTabImageMaxBytes = 5 * 1024 * 1024;

/// The bytes travel in parts this size, each one small request through the
/// machine relay (`ATTACHMENT_PART_BYTES` on the backend).
const kSuperTabImagePartBytes = 256 * 1024;

/// The image type [bytes] really are, read from their header, or null for
/// anything a Swarm does not take (a GIF, a PDF, a renamed file).
String? superTabImageMime(Uint8List bytes) {
  bool starts(List<int> prefix, [int at = 0]) =>
      bytes.length >= at + prefix.length &&
      [for (var i = 0; i < prefix.length; i++) bytes[at + i] == prefix[i]]
          .every((same) => same);
  if (starts(const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
    return 'image/png';
  }
  if (starts(const [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (starts('RIFF'.codeUnits) && starts('WEBP'.codeUnits, 8)) {
    return 'image/webp';
  }
  return null;
}

/// The images waiting in one conversation's composer. They stay in memory
/// only: a saved pending send names their uploaded IDs, never their bytes.
class SuperTabImages extends HarnessAttachments {
  SuperTabImages({this.onDiscard});

  /// Told the backend ID of an upload nobody will send: removed, replaced,
  /// or refused. The backend keeps at most 24 unsent images a person, so each
  /// is deleted at once rather than left to expire.
  final void Function(String id)? onDiscard;

  final _uploads = <HarnessAttachment, ({String id, bool complete})>{};

  /// The backend ID of [file] once all its parts are uploaded.
  String? uploadedId(HarnessAttachment file) =>
      _uploads[file]?.complete == true ? _uploads[file]!.id : null;

  /// The backend ID of [file] once its upload started, finished or not: an
  /// interrupted upload resumes there.
  String? startedId(HarnessAttachment file) => _uploads[file]?.id;
  void markStarted(HarnessAttachment file, String id) =>
      _uploads[file] = (id: id, complete: false);
  void markUploaded(HarnessAttachment file, String id) =>
      _uploads[file] = (id: id, complete: true);

  /// The backend no longer has [file]'s upload; the next send starts over.
  void forget(HarnessAttachment file) => _uploads.remove(file);

  /// The backend refused these uploads; the next send uploads again.
  void forgetUploads() {
    for (final file in [..._uploads.keys]) {
      _discard(file);
    }
  }

  /// [file] went out with a message: its upload is the message's now.
  void sent(HarnessAttachment file) {
    _uploads.remove(file);
    super.remove(file);
  }

  void _discard(HarnessAttachment file) {
    final upload = _uploads.remove(file);
    if (upload != null) onDiscard?.call(upload.id);
  }

  /// Takes PNG, JPEG and WebP images up to 5 MB, four in all, and says what it
  /// left out.
  @override
  String? add(
    Iterable<HarnessAttachment> files, {
    Iterable<String> oversized = const [],
  }) {
    final notImages = <String>[], tooLarge = [...oversized];
    final taken = <HarnessAttachment>[];
    var overCount = 0;
    for (final file in files) {
      if (file.bytes.isEmpty) continue;
      if (superTabImageMime(file.bytes) == null) {
        notImages.add(file.name);
      } else if (file.bytes.length > kSuperTabImageMaxBytes) {
        tooLarge.add(file.name);
      } else if (this.files.length + taken.length >=
              kSuperTabImagesPerMessage &&
          !this.files.any((kept) => kept.name == file.name)) {
        overCount++;
      } else {
        taken.add(file);
      }
    }
    for (final file in this.files) {
      if (taken.any((next) => next.name == file.name)) _discard(file);
    }
    super.add(taken);
    return [
      if (notImages.length == 1)
        '${notImages.single} is not a PNG, JPEG or WebP image.'
      else if (notImages.isNotEmpty)
        '${notImages.length} files are not PNG, JPEG or WebP images.',
      if (tooLarge.length == 1)
        '${tooLarge.single} is over 5 MB.'
      else if (tooLarge.isNotEmpty)
        '${tooLarge.length} images are over 5 MB.',
      if (overCount > 0) 'A message can carry up to 4 images.',
    ].join(' ').nullIfEmpty;
  }

  @override
  void remove(HarnessAttachment file) {
    _discard(file);
    super.remove(file);
  }

  @override
  void clear() {
    forgetUploads();
    super.clear();
  }
}

/// What ⌘V in the Swarm composer takes from files copied in a file manager:
/// only the images among them. Any other copied file pastes as before, its name
/// as text, rather than being refused.
Future<CopiedFiles> superTabCopiedImages() async {
  final copied = await readCopiedFiles(
    await NativeClipboard.readFilePaths(),
    maxBytes: kSuperTabImageMaxBytes,
  );
  return (
    files: [
      for (final file in copied.files)
        if (superTabImageMime(file.bytes) != null) file,
    ],
    tooLarge: [
      for (final name in copied.tooLarge)
        if (RegExp(r'\.(png|jpe?g|webp)$', caseSensitive: false).hasMatch(name))
          name,
    ],
  );
}

extension on String {
  String? get nullIfEmpty => isEmpty ? null : this;
}

/// A message's images as small thumbnails; a click shows one larger.
class SuperTabMessageImages extends StatelessWidget {
  const SuperTabMessageImages({
    super.key,
    required this.attachments,
    required this.load,
  });

  final List<SuperTabAttachment> attachments;
  final Future<Uint8List> Function(SuperTabAttachment attachment) load;

  static const thumbnail = 120.0;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final attachment in attachments)
          _Thumbnail(attachment: attachment, load: load),
      ],
    ),
  );
}

class _Thumbnail extends StatefulWidget {
  const _Thumbnail({required this.attachment, required this.load});

  final SuperTabAttachment attachment;
  final Future<Uint8List> Function(SuperTabAttachment attachment) load;

  @override
  State<_Thumbnail> createState() => _ThumbnailState();
}

class _ThumbnailState extends State<_Thumbnail> {
  late Future<Uint8List> _bytes = widget.load(widget.attachment);

  void _retry() => setState(() => _bytes = widget.load(widget.attachment));

  Future<void> _open(Uint8List bytes) => showAppDialog<void>(
    context: context,
    builder: (context) => Dialog(
      backgroundColor: DesktopChrome.surface,
      insetPadding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    widget.attachment.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(medium: true),
                  ),
                ),
                AppIconButton(
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          Flexible(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: InteractiveViewer(
                child: Image.memory(
                  bytes,
                  key: ValueKey(
                    'super-message-image-full:${widget.attachment.id}',
                  ),
                  fit: BoxFit.contain,
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final attachment = widget.attachment;
    const size = SuperTabMessageImages.thumbnail;
    return FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (context, snapshot) {
        final bytes = snapshot.data;
        final Widget child;
        if (bytes != null) {
          child = Image.memory(
            bytes,
            key: ValueKey('super-message-image:${attachment.id}'),
            width: size,
            height: size,
            // Decoded at the size it is drawn, not the screenshot's own.
            cacheWidth: (size * 3).toInt(),
            fit: BoxFit.cover,
            gaplessPlayback: true,
            errorBuilder: (_, _, _) => _placeholder('Image unavailable'),
          );
        } else if (snapshot.hasError) {
          child = _placeholder('Could not load ${attachment.name}');
        } else {
          child = const Center(
            child: SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          );
        }
        return Tooltip(
          message: snapshot.hasError
              ? 'Could not load ${attachment.name}. Click to try again.'
              : attachment.name,
          child: Semantics(
            button: true,
            label: 'Image ${attachment.name}',
            child: InkWell(
              key: ValueKey('super-message-attachment:${attachment.id}'),
              borderRadius: BorderRadius.circular(8),
              onTap: bytes != null
                  ? () => _open(bytes)
                  : snapshot.hasError
                  ? _retry
                  : null,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  width: size,
                  height: size,
                  color: DesktopChrome.foreground.withValues(alpha: .055),
                  child: child,
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _placeholder(String label) => Center(
    child: Padding(
      padding: const EdgeInsets.all(8),
      child: Text(
        label,
        textAlign: TextAlign.center,
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
        style: DesktopChrome.metadata(),
      ),
    ),
  );
}
