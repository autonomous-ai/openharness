import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../finder/finder_file_kind.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// The largest file read into the chat's text viewer; a bigger one opens in
/// the browser. Specs and logs sit well under it, and the backend takes 10 MB.
const kAttachmentTextMaxBytes = 2 * 1024 * 1024;

/// Reads a file off the attachments host, when a person asks for it.
@visibleForTesting
Future<Uint8List> Function(Uri url, {int? maxBytes}) attachmentFetcher =
    fetchAttachment;

/// A picture off the attachments host, drawn where the chat shows it; tests
/// hand it bytes instead.
@visibleForTesting
ImageProvider Function(Uri url) attachmentImage = _networkImage;

ImageProvider _networkImage(Uri url) => NetworkImage(url.toString());

/// The picture at [url] through [attachmentImage].
ImageProvider attachmentPicture(Uri url) => attachmentImage(url);

/// The file at [url] through [attachmentFetcher], for the text viewer
/// (`attachment_text_viewer.dart`), which a browser downloads apart.
Future<Uint8List> readAttachment(Uri url, {int? maxBytes}) =>
    attachmentFetcher(url, maxBytes: maxBytes);

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

/// A viewer's buttons: save the file, open it in the browser, or close.
class AttachmentViewerActions extends StatefulWidget {
  const AttachmentViewerActions({
    super.key,
    required this.file,
    required this.url,
  });

  final SuperTabAttachment file;
  final Uri url;

  @override
  State<AttachmentViewerActions> createState() =>
      _AttachmentViewerActionsState();
}

class _AttachmentViewerActionsState extends State<AttachmentViewerActions> {
  bool _saving = false;
  String? _outcome;

  Future<void> _download() async {
    setState(() {
      _saving = true;
      _outcome = null;
    });
    String? outcome;
    try {
      if (await downloadAttachment(widget.file, widget.url)) outcome = 'Saved';
    } catch (_) {
      outcome = 'Couldn’t save this file.';
    }
    if (!mounted) return;
    setState(() {
      _saving = false;
      _outcome = outcome;
    });
  }

  @override
  Widget build(BuildContext context) => Row(
    children: [
      if (_outcome != null) Text(_outcome!, style: DesktopChrome.metadata()),
      const Spacer(),
      // A browser cannot write to a chosen path; Open in browser saves there.
      if (!kIsWeb)
        TextButton(
          onPressed: _saving ? null : _download,
          child: const Text('Download'),
        ),
      TextButton(
        onPressed: () => openInBrowser(widget.url),
        child: const Text('Open in browser'),
      ),
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Close'),
      ),
    ],
  );
}
