import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'model.dart';
import 'swarm_attachment.dart' show swarmKeptFile;
import 'swarm_attachment_store.dart';
import 'swarm_file_download.dart';
import 'swarm_file_kind.dart';
import 'swarm_file_links.dart';
import 'swarm_message_text.dart';
import 'swarm_style.dart';

/// A text file from a chat, read only, full screen (the desktop's
/// `AttachmentTextViewer`): Markdown rendered with its source a tap away,
/// anything else as it is written, in the terminal's face. Fetched into
/// [store] when this opens, by [url], and with [fileRef] by a fresh link once
/// that one ends. Close and Download at the top; Open in browser
/// ([openInBrowser]) when it cannot be shown. A file larger than its message
/// said opens in the browser instead, as a large one does.
///
/// It shows a file [store] keeps for one account, so it goes when that
/// changes ([SwarmAttachmentStore.turns]), as the picture viewer does: blank
/// at once, its text let go, and closed.
class SwarmFileViewer extends StatefulWidget {
  const SwarmFileViewer({
    super.key,
    required this.file,
    required this.url,
    required this.store,
    required this.turn,
    required this.openInBrowser,
    this.fileRef,
  });

  final SuperTabAttachment file;
  final Uri url;
  final SwarmFileRef? fileRef;
  final SwarmAttachmentStore store;

  /// The store's turn as the file was opened: shown only while it holds.
  final int turn;

  /// How the chat opens a file in the browser.
  final Future<bool> Function(Uri url) openInBrowser;

  @override
  State<SwarmFileViewer> createState() => _SwarmFileViewerState();
}

class _SwarmFileViewerState extends State<SwarmFileViewer> {
  /// The copy [SwarmFileViewer.store] keeps, once fetched.
  File? _kept;

  /// The file's text in lines, once read and found to be text.
  List<String>? _lines;

  /// A Markdown file's text whole, to render.
  String? _text;

  bool _failed = false;
  bool _notText = false;
  bool _source = false;
  bool _gone = false;

  /// A link for the browser is being asked for: another tap waits for it.
  bool _browsing = false;

  bool get _markdown =>
      swarmFileKind(widget.file.name) == SwarmFileKind.markdown;

  @override
  void initState() {
    super.initState();
    widget.store.turns.addListener(_turned);
    if (widget.store.turns.value != widget.turn) {
      _gone = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _close());
    } else {
      unawaited(_read());
    }
  }

  @override
  void dispose() {
    widget.store.turns.removeListener(_turned);
    super.dispose();
  }

  void _turned() {
    if (_gone || widget.store.turns.value == widget.turn) return;
    setState(() {
      _gone = true;
      _kept = null;
      _lines = null;
      _text = null;
    });
    _close();
  }

  void _close() {
    if (!mounted) return;
    final route = ModalRoute.of(context);
    if (route != null && route.isActive) {
      Navigator.of(context).removeRoute(route);
    }
  }

  Future<void> _read() async {
    try {
      final kept = await swarmKeptFile(
        widget.store,
        widget.file,
        at: widget.url,
        ref: widget.fileRef,
      );
      // Larger than its message said: read in the browser, as a large file is.
      if (await kept.length() > swarmTextMaxBytes) {
        if (!mounted || _gone) return;
        if (!await _openInBrowser(close: true) && mounted && !_gone) {
          setState(() => _failed = true);
        }
        return;
      }
      final bytes = await kept.readAsBytes();
      if (!mounted || _gone) return;
      final text = swarmLooksLikeText(bytes)
          ? utf8.decode(bytes, allowMalformed: true)
          : null;
      setState(() {
        _kept = kept;
        _text = _markdown ? text : null;
        _lines = text == null ? null : swarmTextLines(text);
        _notText = text == null;
      });
    } catch (error) {
      // Its kind only: the error carries the file's signed link.
      appLog.failure(
        'swarm',
        'A Swarm file could not be read: ${error.runtimeType}',
      );
      if (mounted && !_gone) setState(() => _failed = true);
    }
  }

  /// The file in the browser, by a link that opens now; with [close], this
  /// viewer goes as it opens. False when no link could be had.
  Future<bool> _openInBrowser({bool close = false}) async {
    if (_browsing) return false;
    final ref = widget.fileRef;
    final messenger = ScaffoldMessenger.maybeOf(context);
    final Uri? url;
    _browsing = true;
    try {
      url = ref == null
          ? widget.url
          : await swarmOpenableLink(
              context,
              ref,
              onProblem: (text) =>
                  messenger?.showSnackBar(SnackBar(content: Text(text))),
            );
    } finally {
      _browsing = false;
    }
    if (url == null || !mounted || _gone) return false;
    if (close) _close();
    unawaited(widget.openInBrowser(url));
    return true;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final shown = !_gone && _lines != null;
    return Scaffold(
      key: const ValueKey('swarm-file-viewer'),
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmIconButton(
                key: const ValueKey('swarm-file-close'),
                icon: LucideIcons.x300,
                label: 'Close',
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: _gone ? '' : widget.file.name,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_markdown && shown)
                    SwarmIconButton(
                      key: const ValueKey('swarm-file-source'),
                      icon: _source ? LucideIcons.eye300 : LucideIcons.code300,
                      label: _source ? 'Show preview' : 'Show source',
                      onPressed: () => setState(() => _source = !_source),
                    ),
                  SwarmDownloadButton(
                    name: widget.file.name,
                    file: _gone ? null : _kept,
                    store: widget.store,
                  ),
                ],
              ),
            ),
            Expanded(child: _body(tty)),
          ],
        ),
      ),
    );
  }

  Widget _body(Tty tty) {
    if (_gone) return const SizedBox.expand();
    final browse = SwarmButton(
      key: const ValueKey('swarm-file-browser'),
      label: 'Open in browser',
      onPressed: () => unawaited(_openInBrowser()),
    );
    if (_failed) {
      return EmptyState(
        icon: LucideIcons.circleAlert300,
        title: 'Can’t open this file',
        message: 'It couldn’t be downloaded. Try again in the browser.',
        compact: true,
        action: browse,
      );
    }
    if (_notText) {
      return EmptyState(
        icon: LucideIcons.file300,
        title: 'No preview',
        message: 'This file isn’t text that can be shown here.',
        compact: true,
        action: browse,
      );
    }
    final padding = EdgeInsets.fromLTRB(
      AppSpace.m,
      AppSpace.xs,
      AppSpace.m,
      MediaQuery.paddingOf(context).bottom + AppSpace.xl,
    );
    final lines = _lines;
    if (lines == null) {
      return SkeletonList(
        key: const ValueKey('swarm-file-loading'),
        rows: 12,
        padding: padding,
        itemBuilder: (_, i) => Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpace.xs + 2),
          child: FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: const [.9, .7, .8, .5][i % 4],
            child: const Skeleton.text(),
          ),
        ),
      );
    }
    if (_text case final text? when !_source) {
      return SelectionArea(
        child: SingleChildScrollView(
          key: const ValueKey('swarm-file-markdown'),
          padding: padding,
          child: MarkdownBody(
            data: text,
            extensionSet: md.ExtensionSet.gitHubFlavored,
            styleSheet: swarmMarkdownStyle(context),
            // A file's pictures stay labels: nothing it points at is fetched.
            imageBuilder: (_, _, alt) => Text(
              alt?.isNotEmpty == true ? 'Image: $alt' : 'Image',
              style: AppType.caption(color: AppPalette.textSecondary),
            ),
            onTapLink: (_, href, _) {
              final uri = swarmWebLink(href);
              if (uri != null) {
                unawaited(launchUrl(uri, mode: LaunchMode.inAppBrowserView));
              }
            },
          ),
        ),
      );
    }
    final style = tty.style();
    // A line at a time, built as it scrolls in: a file may run to 2 MB.
    return SelectionArea(
      child: ListView.builder(
        key: const ValueKey('swarm-file-text'),
        padding: padding,
        itemCount: lines.length,
        itemBuilder: (_, i) => Text(lines[i], style: style),
      ),
    );
  }
}

/// The most of one line drawn as one piece: a minified file is a single
/// line, and laying out megabytes as one paragraph stalls a phone.
const _linePiece = 2000;

/// [text] as the lines the viewer draws: its own lines, a tab as four
/// spaces, a line past [_linePiece] cut into pieces of that length, never
/// between the two halves of a character outside the Basic Multilingual Plane.
@visibleForTesting
List<String> swarmTextLines(String text) {
  final lines = <String>[];
  for (var line in text.split('\n')) {
    if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
    line = line.replaceAll('\t', '    ');
    var from = 0;
    while (line.length - from > _linePiece) {
      var to = from + _linePiece;
      final unit = line.codeUnitAt(to - 1);
      if (unit >= 0xD800 && unit <= 0xDBFF) to--;
      lines.add(line.substring(from, to));
      from = to;
    }
    lines.add(line.substring(from));
  }
  return lines;
}
