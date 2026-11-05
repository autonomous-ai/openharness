import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../finder/finder_file_kind.dart';
import '../measurement/speed_marks.dart';
import '../widgets/desktop_chrome.dart';
import 'attachment_upload.dart' show kSuperTabFormAttachmentMaxBytes;
import 'file_links.dart';
import 'image_cache.dart';
import 'model.dart';

/// The largest file read into the chat's text viewer; a bigger one opens in
/// the browser. Specs and logs sit well under it, though a message's file may
/// weigh up to 256 MB.
const kAttachmentTextMaxBytes = 2 * 1024 * 1024;

/// Reads a file off the attachments host, when a person asks for it.
@visibleForTesting
Future<Uint8List> Function(Uri url, {int? maxBytes}) attachmentFetcher =
    fetchAttachment;

/// A picture off the attachments host, drawn where the chat shows it; tests
/// hand it bytes instead.
@visibleForTesting
ImageProvider Function(AttachmentImage picture) attachmentImage = _asItIs;

ImageProvider _asItIs(AttachmentImage picture) => picture;

/// File [fileId]'s picture, read from [url] unless this computer already has
/// it, through [attachmentImage]: no more than [side] points each way, or the
/// original without one.
ImageProvider attachmentPicture(
  Uri url, {
  required String fileId,
  double? side,
}) => attachmentImage(AttachmentImage(url, fileId: fileId, side: side));

/// The file at [url] through [attachmentFetcher], for the text viewer
/// (`attachment_text_viewer.dart`), which a browser downloads apart.
Future<Uint8List> readAttachment(Uri url, {int? maxBytes}) =>
    attachmentFetcher(url, maxBytes: maxBytes);

/// A picture shown in place, read through [attachmentFetcher] and timed: its
/// bytes and milliseconds (or its failure) go to the speed marks
/// (`measurement/speed_marks.dart`), never its address.
Future<Uint8List> readPicture(Uri url) async {
  final clock = Stopwatch()..start();
  try {
    final bytes = await readAttachment(
      url,
      maxBytes: kSuperTabFormAttachmentMaxBytes,
    );
    speedMarks.image(ms: clock.elapsedMilliseconds, bytes: bytes.length);
    return bytes;
  } catch (_) {
    speedMarks.image(ms: clock.elapsedMilliseconds);
    rethrow;
  }
}

/// A file past the text viewer's limit; it opens in the browser instead.
class AttachmentTooLarge implements Exception {
  const AttachmentTooLarge();
}

/// The file at [url], or [AttachmentTooLarge] once it passes [maxBytes]:
/// read as it arrives, so a file larger than it says is cut off, not read
/// whole. A redirect is refused, since it could lead off the attachments
/// host.
Future<Uint8List> fetchAttachment(Uri url, {int? maxBytes}) async {
  final dio = Dio();
  try {
    final answer = await dio.getUri<ResponseBody>(
      url,
      options: Options(
        responseType: ResponseType.stream,
        followRedirects: false,
        validateStatus: (status) => status == 200,
      ),
    );
    final body = answer.data!;
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in body.stream) {
      bytes.add(chunk);
      if (maxBytes != null && bytes.length > maxBytes) {
        throw const AttachmentTooLarge();
      }
    }
    return bytes.takeBytes();
  } finally {
    // Hangs up a body read only in part, rather than leaving it open.
    dio.close(force: true);
  }
}

/// Whether [file] opens in the text viewer: text by its name, as Finder tells
/// it, and small enough to read in place. Never in a browser, whose fetch
/// follows redirects and loads a body whole before the page sees it; there
/// the file opens in a new tab.
bool opensAsText(SuperTabAttachment file) =>
    !kIsWeb &&
    file.size <= kAttachmentTextMaxBytes &&
    switch (finderFileKind(file.name)) {
      FinderFileKind.text || FinderFileKind.markdown => true,
      _ => false,
    };

/// Asks where to save [file], then fetches it from [url] into that place.
/// False when the person cancelled.
Future<bool> downloadAttachment(SuperTabAttachment file, Uri url) async {
  final where = await getSaveLocation(suggestedName: file.name);
  if (where == null) return false;
  await File(where.path).writeAsBytes(await attachmentFetcher(url));
  return true;
}

/// A viewer's buttons: save the file, open it in the browser, or close. A
/// viewer may stay open longer than [url] lasts: with [ref], each button asks
/// for a link that opens now first.
class AttachmentViewerActions extends StatefulWidget {
  const AttachmentViewerActions({
    super.key,
    required this.file,
    required this.url,
    this.ref,
    this.close = true,
    this.more,
    this.ink,
    this.fill,
  });

  final SuperTabAttachment file;
  final Uri url;
  final SuperTabFileRef? ref;

  /// Whether Close is offered; the picture viewer closes by its own ×.
  final bool close;

  /// After the buttons: the picture viewer's More.
  final Widget? more;

  /// The buttons' and the outcome's ink, on the picture viewer's veil.
  final Color? ink;

  /// The buttons' fill there, the same in both appearances.
  final Color? fill;

  @override
  State<AttachmentViewerActions> createState() =>
      _AttachmentViewerActionsState();
}

class _AttachmentViewerActionsState extends State<AttachmentViewerActions> {
  bool _saving = false;
  String? _outcome;

  /// A link that opens now, or null with the reason shown.
  Future<Uri?> _link() async {
    final ref = widget.ref;
    if (ref == null) return widget.url;
    try {
      return await ref.link();
    } on SuperTabFileUnavailable catch (problem) {
      if (mounted) setState(() => _outcome = problem.message);
      return null;
    }
  }

  Future<void> _download() async {
    setState(() {
      _saving = true;
      _outcome = null;
    });
    String? outcome;
    try {
      final url = await _link();
      if (url == null || !mounted) {
        if (mounted) setState(() => _saving = false);
        return;
      }
      if (await downloadAttachment(widget.file, url)) outcome = 'Saved';
    } catch (_) {
      outcome = 'Couldn’t save this file.';
    }
    if (!mounted) return;
    setState(() {
      _saving = false;
      _outcome = outcome;
    });
  }

  Future<void> _openInBrowser() async {
    final url = await _link();
    if (url != null && mounted) await openInBrowser(url);
  }

  @override
  Widget build(BuildContext context) {
    final ink = widget.ink;
    final style = ink == null
        ? null
        : TextButton.styleFrom(
            foregroundColor: ink,
            backgroundColor: widget.fill,
            side: BorderSide.none,
          );
    return Row(
      children: [
        if (_outcome != null)
          Flexible(
            child: Text(
              _outcome!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(color: ink),
            ),
          ),
        const Spacer(),
        // A browser cannot write to a chosen path; Open in browser saves there.
        if (!kIsWeb)
          TextButton(
            style: style,
            onPressed: _saving ? null : _download,
            child: const Text('Download'),
          ),
        TextButton(
          style: style,
          onPressed: _openInBrowser,
          child: const Text('Open in browser'),
        ),
        if (widget.close)
          TextButton(
            style: style,
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ?widget.more,
      ],
    );
  }
}

/// File [fileId]'s picture, read at [url] through [attachmentFetcher] like any
/// chat file: a redirect is refused, so nothing from another host is fetched
/// or drawn (`NetworkImage` follows one). It is the file's, whatever link it
/// came by: Flutter holds it by [fileId], and the disk keeps its bytes
/// ([superTabImageCache]), so a fresh short-lived link to a file already seen
/// downloads nothing. With [side], it is decoded no larger than [side] points
/// each way at the screen's pixel ratio, as the chat shows it; without, whole,
/// as the full-screen viewer does.
///
/// Built only with a link that opens now, the message's own or a fresh one the
/// server granted, so the cache serves only a file this reader may read.
@immutable
class AttachmentImage extends ImageProvider<AttachmentPictureKey> {
  const AttachmentImage(this.url, {required this.fileId, this.side});

  final Uri url;
  final String fileId;
  final double? side;

  @override
  Future<AttachmentPictureKey> obtainKey(ImageConfiguration configuration) {
    final side = this.side;
    final ratio = configuration.devicePixelRatio ?? 1;
    return SynchronousFuture(
      AttachmentPictureKey(fileId, side == null ? null : (side * ratio).ceil()),
    );
  }

  @override
  ImageStreamCompleter loadImage(
    AttachmentPictureKey key,
    ImageDecoderCallback decode,
  ) => MultiFrameImageStreamCompleter(
    codec: _load(key, decode),
    scale: 1,
    debugLabel: 'attachment ${key.fileId}',
  );

  Future<ui.Codec> _load(
    AttachmentPictureKey key,
    ImageDecoderCallback decode,
  ) async {
    final cache = superTabImageCache;
    final began = cache.generation;
    try {
      if (await cache.read(fileId) case final kept?) {
        try {
          return (await _decode(kept, key, decode)).codec;
        } catch (_) {
          // A write a crash cut short: read it again.
          await cache.drop(fileId);
        }
      }
      // Only a real download is timed (readPicture): a picture this computer
      // already had costs no fetch.
      final bytes = await readPicture(url);
      final (:codec, :shape) = await _decode(bytes, key, decode);
      if (shape != null) {
        unawaited(cache.keep(fileId, bytes, shape, generation: began));
      }
      return codec;
    } catch (_) {
      // Held by the file's id, a failure would answer every later link to
      // it, the fresh one asked for because this one ended included.
      PaintingBinding.instance.imageCache.evict(key);
      rethrow;
    }
  }

  /// [bytes] decoded no larger than [key]'s pixels, and the picture's own
  /// width and height.
  static Future<({ui.Codec codec, Size? shape})> _decode(
    Uint8List bytes,
    AttachmentPictureKey key,
    ImageDecoderCallback decode,
  ) async {
    Size? shape;
    final codec = await decode(
      await ui.ImmutableBuffer.fromUint8List(bytes),
      getTargetSize: (width, height) {
        shape = Size(width.toDouble(), height.toDouble());
        final pixels = key.pixels;
        if (pixels == null || math.max(width, height) <= pixels) {
          return const ui.TargetImageSize();
        }
        return width >= height
            ? ui.TargetImageSize(width: pixels)
            : ui.TargetImageSize(height: pixels);
      },
    );
    return (codec: codec, shape: shape);
  }

  @override
  bool operator ==(Object other) =>
      other is AttachmentImage &&
      other.fileId == fileId &&
      other.side == side &&
      other.url == url;

  @override
  int get hashCode => Object.hash(fileId, side, url);
}

/// Signing out, or a session that ends: the chat's pictures are the
/// account's, and none outlives it, on disk or decoded in memory.
Future<void> superTabForgetPictures() {
  PaintingBinding.instance.imageCache
    ..clear()
    ..clearLiveImages();
  return superTabImageCache.clear();
}

/// What Flutter holds a chat picture by: its file, and the pixels it was
/// decoded at (null: the original). Never its link, which changes.
@immutable
class AttachmentPictureKey {
  const AttachmentPictureKey(this.fileId, this.pixels);

  final String fileId;
  final int? pixels;

  @override
  bool operator ==(Object other) =>
      other is AttachmentPictureKey &&
      other.fileId == fileId &&
      other.pixels == pixels;

  @override
  int get hashCode => Object.hash(fileId, pixels);
}
