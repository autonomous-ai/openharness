import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// The first message of [shown] the reader has not read, for the New messages line: in the main stream (a reply
/// that lives only in its thread is read there), from someone else, and after both the reader's read mark [mark] and
/// their own newest message in the chat, since writing in a chat reads what came before it. Null when everything is read, and
/// for a conversation the reader has never read on any device (no mark), which opens at its end as before.
String? superTabFirstUnread(
  List<SuperTabMessage> shown,
  int mark, {
  required bool Function(SuperTabMessage) own,
}) {
  if (mark <= 0) return null;
  var read = mark;
  for (final message in shown) {
    // A reply of one's own that lives only in its thread reads that thread,
    // not the chat.
    if (own(message) && message.inMainStream && message.sequence > read) {
      read = message.sequence;
    }
  }
  for (final message in shown) {
    if (message.sequence > read && message.inMainStream && !own(message)) {
      return message.id;
    }
  }
  return null;
}

/// Where each conversation's New messages line sits: decided once when the conversation is opened with its messages
/// at hand, then held while new messages arrive and the read mark moves, so the line never jumps. Leaving the
/// conversation, or Esc, forgets it.
class SuperTabUnreadLines {
  final _at = <String, String?>{};

  /// Conversations reading back to the mark before their line is placed, and those that did this visit.
  final _loading = <String>{}, _loaded = <String>{};

  /// Reads back that failed this visit, by conversation: tried again up to [_tries] times.
  final _failed = <String, int>{};
  static const _tries = 3;

  /// The line on screen, to tell whether it is scrolled out of view.
  final key = GlobalKey(debugLabel: 'New messages line');

  /// Whether the reader is scrolled away from the line, so the jump pill shows.
  bool away = false;

  /// The message [id]'s line sits above, or null.
  String? lineAt(String id) => _at[id];

  /// Decides [id]'s line from its [shown] messages once: true when this call placed a line, so the view opens at it.
  bool decide(
    String id,
    List<SuperTabMessage> shown,
    int mark, {
    required bool Function(SuperTabMessage) own,
  }) {
    if (_at.containsKey(id) || shown.isEmpty) return false;
    return (_at[id] = superTabFirstUnread(shown, mark, own: own)) != null;
  }

  /// Whether [id]'s line waits for older messages: loading, or a read back that failed and is not yet done. Nothing is
  /// followed or marked read meanwhile, and no line is placed short of the first unread.
  bool waitsForHistory(String id) =>
      _loading.contains(id) ||
      (_failed.containsKey(id) && !_loaded.contains(id));

  /// Whether [id] must first read back to the [mark] the held messages do not reach ([heldBack] false) for its line,
  /// once per visit; when true, the caller loads and then calls [historyLoaded].
  bool startHistory(
    String id,
    List<SuperTabMessage> shown,
    int mark, {
    required bool heldBack,
  }) {
    if (_at.containsKey(id) ||
        _loading.contains(id) ||
        _loaded.contains(id) ||
        (_failed[id] ?? 0) >= _tries) {
      return false;
    }
    if (heldBack || mark <= 0 || shown.isEmpty || shown.last.sequence <= mark) {
      return false;
    }
    _loading.add(id);
    return true;
  }

  /// The read back of [id] ended: [reached] the mark, or failed and may be tried again ([mayRetry]).
  void historyLoaded(String id, {required bool reached}) {
    if (!_loading.remove(id)) return;
    if (reached) {
      _loaded.add(id);
    } else {
      _failed[id] = (_failed[id] ?? 0) + 1;
    }
  }

  /// Whether a read back of [id] failed this visit: a try again reads no more older pages.
  bool retrying(String id) => _failed.containsKey(id);

  /// Whether [id]'s failed read back has tries left.
  bool mayRetry(String id) =>
      !_loaded.contains(id) && (_failed[id] ?? 0) < _tries;

  /// [id] was left: the next visit decides again.
  void forget(String? id) {
    _at.remove(id);
    _loading.remove(id);
    _loaded.remove(id);
    _failed.remove(id);
    away = false;
  }

  /// Read with Esc: no line until the next visit.
  void clear(String id) {
    _at[id] = null;
    away = false;
  }

  void reset() {
    _at.clear();
    _loading.clear();
    _loaded.clear();
    _failed.clear();
    away = false;
  }
}

/// The line above the first unread message: the accent rule and the words, so colour is never the only signal.
class SuperTabNewMessagesLine extends StatelessWidget {
  const SuperTabNewMessagesLine({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final accent = DesktopChrome.accent;
    return Padding(
      key: const ValueKey('super-new-messages-line'),
      padding: const EdgeInsets.fromLTRB(
        grid.AppDesktop.panelPadding,
        grid.AppDesktop.controlGap,
        grid.AppDesktop.panelPadding,
        0,
      ),
      child: Semantics(
        container: true,
        label: 'New messages',
        excludeSemantics: true,
        child: Row(
          children: [
            Expanded(child: Divider(color: accent)),
            const SizedBox(width: grid.AppDesktop.controlGap),
            Text(
              'New messages',
              style: DesktopChrome.metadata(color: accent)
                  .copyWith(fontWeight: grid.AppFont.semibold),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shown while the New messages line is scrolled out of view: takes the reader back to it.
class SuperTabJumpToUnread extends StatelessWidget {
  const SuperTabJumpToUnread({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => FilledButton.icon(
    key: const ValueKey('super-jump-unread'),
    onPressed: onPressed,
    icon: const Icon(AppIcons.chevronUp, size: grid.AppDesktop.iconSize),
    label: const Text('Jump to first unread'),
  );
}
