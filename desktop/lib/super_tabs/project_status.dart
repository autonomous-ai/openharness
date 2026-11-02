import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'message_text.dart';

/// "8:33 PM" today, "Oct 30, 8:33 PM" before, in this computer's time.
String superTabStatusTime(DateTime at, DateTime now) {
  final local = at.toLocal(), today = now.toLocal();
  final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
  final minute = local.minute.toString().padLeft(2, '0');
  final clock = '$hour:$minute ${local.hour < 12 ? 'AM' : 'PM'}';
  if (local.year == today.year &&
      local.month == today.month &&
      local.day == today.day) {
    return clock;
  }
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', //
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  final year = local.year == today.year ? '' : ' ${local.year}';
  return '${months[local.month - 1]} ${local.day}$year, $clock';
}

/// The project menu's Status (Quiet Swarm, screen 9b): what the coordinator
/// last reported, replaced in place by each report. It reads nothing of its
/// own: the text comes with the Swarm read. What waits on the reader is in
/// Activity.
Future<void> showSuperTabProjectStatus(
  BuildContext context,
  SuperTabController c,
  String projectId, {
  DateTime Function() now = DateTime.now,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: projectId,
    requireWrite: false,
    child: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final status = c.snapshot?.projectById(projectId)?.status;
        final at = status?.at;
        return SuperTabDetailDialog(
          title: at == null
              ? 'Status'
              : 'Status · updated ${superTabStatusTime(at, now())}',
          body: status == null
              ? const SizedBox.shrink()
              : _StatusText(status.text),
        );
      },
    ),
  ),
);

/// The report as the coordinator wrote it, line for line, with its web links
/// clickable. Not Markdown: the card is a glance, not a message.
class _StatusText extends StatefulWidget {
  const _StatusText(this.text);
  final String text;

  @override
  State<_StatusText> createState() => _StatusTextState();
}

class _StatusTextState extends State<_StatusText> {
  static final _link = RegExp(r'https?://[^\s<>()\[\]]+');

  /// The text cut into plain pieces and links, with one tap per link: made
  /// again only when the text changes, so a rebuild (a theme flip, a Swarm
  /// read) never drops a tap under the pointer.
  var _pieces = <(String, TapGestureRecognizer?)>[];

  @override
  void initState() {
    super.initState();
    _cut();
  }

  @override
  void didUpdateWidget(_StatusText old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _cut();
  }

  @override
  void dispose() {
    _release();
    super.dispose();
  }

  void _release() {
    for (final (_, tap) in _pieces) {
      tap?.dispose();
    }
  }

  void _cut() {
    _release();
    final text = widget.text.trimRight();
    final pieces = <(String, TapGestureRecognizer?)>[];
    var at = 0;
    for (final match in _link.allMatches(text)) {
      // A sentence's closing punctuation is not part of its link.
      var url = match[0]!;
      while (url.isNotEmpty && '.,;:!?\'"'.contains(url[url.length - 1])) {
        url = url.substring(0, url.length - 1);
      }
      final uri = SuperTabMessageText.webLink(url);
      if (uri == null) continue;
      if (match.start > at) pieces.add((text.substring(at, match.start), null));
      pieces.add((
        url,
        TapGestureRecognizer()..onTap = () => openInBrowser(uri),
      ));
      at = match.start + url.length;
    }
    if (at < text.length) pieces.add((text.substring(at), null));
    _pieces = pieces;
  }

  @override
  Widget build(BuildContext context) {
    final link = TextStyle(
      color: DesktopChrome.accent,
      decoration: TextDecoration.underline,
      decorationColor: DesktopChrome.accent,
    );
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.listRowGap),
      child: Text.rich(
        key: const ValueKey('super-project-status-text'),
        TextSpan(
          style: DesktopChrome.text(),
          children: [
            for (final (text, tap) in _pieces)
              tap == null
                  ? TextSpan(text: text)
                  : TextSpan(
                      text: text,
                      style: link,
                      recognizer: tap,
                      mouseCursor: SystemMouseCursors.click,
                    ),
          ],
        ),
      ),
    );
  }
}
