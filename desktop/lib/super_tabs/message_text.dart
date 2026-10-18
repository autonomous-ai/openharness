import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// Shared messages are selectable text. Only explicit web links are opened,
/// using the app's existing browser path; messages never execute local paths.
class SuperTabMessageText extends StatefulWidget {
  const SuperTabMessageText(this.text, {super.key});
  final String text;
  @override
  State<SuperTabMessageText> createState() => _SuperTabMessageTextState();
}

class _SuperTabMessageTextState extends State<SuperTabMessageText> {
  final _links = <TapGestureRecognizer>[];
  List<InlineSpan> _spans = [];
  Color? _accent;
  static final _web = RegExp(r'https?://[^\s<>"\x00-\x1f]+');

  @override
  void initState() {
    super.initState();
    _read();
  }

  @override
  void didUpdateWidget(SuperTabMessageText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) _read();
  }

  void _read() {
    _accent = DesktopChrome.accent;
    for (final link in _links) {
      link.dispose();
    }
    _links.clear();
    _spans = [];
    var offset = 0;
    for (final match in _web.allMatches(widget.text)) {
      final raw = match.group(0)!;
      final link = raw.replaceFirst(RegExp(r'[.,;!?\]\)]+$'), '');
      final uri = Uri.tryParse(link);
      if (uri == null || uri.host.isEmpty) continue;
      _spans.add(TextSpan(text: widget.text.substring(offset, match.start)));
      final recognizer = TapGestureRecognizer()
        ..onTap = () {
          openInBrowser(uri);
        };
      _links.add(recognizer);
      _spans.add(
        TextSpan(
          text: link,
          recognizer: recognizer,
          style: TextStyle(
            color: DesktopChrome.accent,
            decoration: TextDecoration.underline,
          ),
        ),
      );
      offset = match.start + link.length;
    }
    _spans.add(TextSpan(text: widget.text.substring(offset)));
  }

  @override
  void dispose() {
    for (final link in _links) {
      link.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    if (_accent != DesktopChrome.accent) _read();
    return SelectableText.rich(
      TextSpan(children: _spans),
      style: DesktopChrome.text(),
    );
  }
}
