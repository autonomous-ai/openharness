import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

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
import 'attachment_viewer.dart';
import 'file_links.dart';
import 'model.dart';

/// A text file from the chat, read only: Markdown rendered with its source a
/// click away, anything else in Finder's editor. Fetched when this opens.
/// [ref] gives Download and Open in browser a fresh link once [url] ends.
class AttachmentTextViewer extends StatefulWidget {
  const AttachmentTextViewer({
    super.key,
    required this.file,
    required this.url,
    this.ref,
  });

  final SuperTabAttachment file;
  final Uri url;
  final SuperTabFileRef? ref;

  @override
  State<AttachmentTextViewer> createState() => _AttachmentTextViewerState();
}

class _AttachmentTextViewerState extends State<AttachmentTextViewer> {
  late final Future<Uint8List> _bytes = readAttachment(
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
                AttachmentViewerActions(
                  file: widget.file,
                  url: widget.url,
                  ref: widget.ref,
                ),
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
