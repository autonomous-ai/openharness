import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:re_editor/re_editor.dart';

import '../core/open_in_browser.dart';
import '../finder/finder_file_kind.dart';
import '../finder/finder_language.dart';
import '../finder/finder_text_format.dart';
import '../finder/widgets/finder_code_editor.dart';
import '../finder/widgets/finder_markdown_view.dart';
import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/empty_state.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// The largest file read into the chat's text viewer; a bigger one opens in
/// the browser. Specs and logs sit well under it, and the backend takes 10 MB.
const kAttachmentTextMaxBytes = 2 * 1024 * 1024;

/// Reads a file off the attachments host, when a person asks for it.
@visibleForTesting
Future<Uint8List> Function(Uri url, {int? maxBytes}) attachmentFetcher =
    fetchAttachment;

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

/// A text file from the chat, read only: Markdown rendered with its source a
/// click away, anything else in Finder's editor. Fetched when this opens.
class AttachmentTextViewer extends StatefulWidget {
  const AttachmentTextViewer({
    super.key,
    required this.file,
    required this.url,
  });

  final SuperTabAttachment file;
  final Uri url;

  @override
  State<AttachmentTextViewer> createState() => _AttachmentTextViewerState();
}

class _AttachmentTextViewerState extends State<AttachmentTextViewer> {
  late final Future<Uint8List> _bytes = attachmentFetcher(
    widget.url,
    maxBytes: kAttachmentTextMaxBytes,
  );

  @override
  void initState() {
    super.initState();
    // Larger than its size said: read it in the browser, as a large file is.
    _bytes.then<void>(
      (_) {},
      onError: (Object error) {
        if (error is! AttachmentTooLarge || !mounted) return;
        Navigator.pop(context);
        openInBrowser(widget.url);
      },
    );
  }

  CodeLineEditingController? _text;
  bool _source = false;

  bool get _markdown =>
      finderFileKind(widget.file.name) == FinderFileKind.markdown;

  @override
  void dispose() {
    _text?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    return Dialog(
      child: SizedBox(
        width: math.min(960, screen.width * .9),
        height: screen.height * .85,
        child: FutureBuilder(
          future: _bytes,
          builder: (context, read) => Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        widget.file.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.control(medium: true),
                      ),
                    ),
                    if (_markdown && _textOf(read) != null)
                      AppIconButton(
                        icon: _source ? AppIcons.eye : AppIcons.code,
                        tooltip: _source ? 'Show preview' : 'Show source',
                        onPressed: () => setState(() => _source = !_source),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                Expanded(child: _body(read)),
                const SizedBox(height: 12),
                AttachmentViewerActions(file: widget.file, url: widget.url),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The file's text once it has arrived and reads as text; null otherwise.
  CodeLineEditingController? _textOf(AsyncSnapshot<Uint8List> read) {
    final bytes = read.data;
    if (bytes == null || !looksLikeText(bytes)) {
      return null;
    }
    return _text ??= () {
      final text = utf8.decode(bytes, allowMalformed: true);
      return CodeLineEditingController.fromText(text, detectTextFormat(text));
    }();
  }

  Widget _body(AsyncSnapshot<Uint8List> read) {
    if (read.hasError) {
      return const EmptyState(
        icon: AppIcons.circleAlert,
        title: 'Can’t open this file',
        message: 'It couldn’t be downloaded. Try again in the browser.',
        compact: true,
      );
    }
    if (read.connectionState != ConnectionState.done) {
      return const SkeletonList(rows: 12);
    }
    final text = _textOf(read);
    if (text == null) {
      return const EmptyState(
        icon: AppIcons.file,
        title: 'No preview',
        message: 'This file isn’t text that can be shown here.',
        compact: true,
      );
    }
    if (_markdown && !_source) return FinderMarkdownView(text.text);
    return FinderCodeEditor(
      controller: text,
      language: finderLanguageOf(widget.file.name),
      readOnly: true,
      onSave: () {},
    );
  }
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
