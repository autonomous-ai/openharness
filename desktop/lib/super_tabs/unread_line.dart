import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

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

  /// Whether the reader is scrolled away from the line, and whether it is
  /// below them.
  bool away = false, below = false;

  /// Conversations whose line has been in view this visit.
  final _seen = <String>{};

  /// [id]'s line came into view: reading on needs no way back to it.
  void saw(String id) => _seen.add(id);

  /// Whether [id] shows the bar back to its line: placed and above the
  /// reader, seen or not (Slack's "N new messages").
  bool offersBar(String id) => away && !below && _at[id] != null;

  /// Whether [id] offers the pill down to its line: placed, below the reader
  /// (a link opened the chat above it), and not yet seen this visit.
  bool offersDown(String id) =>
      away && below && _at[id] != null && !_seen.contains(id);

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
    _seen.remove(id);
    away = below = false;
  }

  /// Read with Esc: no line until the next visit.
  void clear(String id) {
    _at[id] = null;
    away = below = false;
  }

  void reset() {
    _at.clear();
    _loading.clear();
    _loaded.clear();
    _failed.clear();
    _seen.clear();
    away = below = false;
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

/// Shown while the New messages line is above the screen: a flat row across the top of the chat, Slack's
/// "N new messages", that takes the reader back to it. The words carry it, not the colour.
class SuperTabUnreadBar extends StatelessWidget {
  const SuperTabUnreadBar({
    super.key,
    required this.count,
    required this.onPressed,
    this.more = false,
  });

  /// The messages from others from the line on.
  final int count;

  /// Newer pages are not read yet, so [count] is a floor.
  final bool more;
  final VoidCallback onPressed;

  static String label(int count, bool more) =>
      '${more ? '$count+' : '$count'} new ${count == 1 && !more ? 'message' : 'messages'} · Jump';

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final accent = DesktopChrome.accent;
    final words = label(count, more);
    return Semantics(
      key: const ValueKey('super-jump-unread'),
      button: true,
      label: '$words to the first unread',
      excludeSemantics: true,
      child: Material(
        color: DesktopChrome.selection,
        child: InkWell(
          onTap: onPressed,
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: grid.AppDesktop.panelPadding,
                vertical: grid.AppDesktop.controlGap,
              ),
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      words,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.control(color: accent, medium: true),
                    ),
                  ),
                  const SizedBox(width: grid.AppDesktop.controlGap),
                  Icon(
                    AppIcons.arrowUp,
                    size: grid.AppDesktop.iconSize,
                    color: accent,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Shown while the New messages line, not yet seen this visit, is below the reader (a link opened the chat above
/// it): takes the reader down to it.
class SuperTabJumpToUnread extends StatelessWidget {
  const SuperTabJumpToUnread({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => FilledButton.icon(
    key: const ValueKey('super-jump-unread'),
    onPressed: onPressed,
    icon: const Icon(AppIcons.chevronDown, size: grid.AppDesktop.iconSize),
    label: const Text('Jump to first unread'),
  );
}

/// The bar's or the jump pill's place above the list ([child], or nothing). When it opens
/// or closes, [scroll] moves by the same height in that frame, so the messages
/// under the reader's eye stay where they were.
class SuperTabUnreadBand extends SingleChildRenderObjectWidget {
  const SuperTabUnreadBand({super.key, required this.scroll, super.child});

  final ScrollController? scroll;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderSuperTabUnreadBand(scroll);

  @override
  void updateRenderObject(
    BuildContext context,
    RenderSuperTabUnreadBand renderObject,
  ) => renderObject.scroll = scroll;
}

class RenderSuperTabUnreadBand extends RenderProxyBox {
  RenderSuperTabUnreadBand(this.scroll);

  ScrollController? scroll;
  double? _height;

  @override
  void performLayout() {
    super.performLayout();
    final previous = _height;
    _height = size.height;
    final scroll = this.scroll;
    if (previous == null ||
        previous == size.height ||
        scroll == null ||
        !scroll.hasClients ||
        !scroll.position.hasPixels) {
      return;
    }
    // Laid out before the list below it, which then takes the corrected
    // offset: the list's top moves by the change, and the messages do not.
    // Only the view's edge moves, not the content, so this is not a
    // correctBy (which moves the place the chat's list keeps as well).
    final position = scroll.position;
    position.correctPixels(position.pixels + size.height - previous);
  }
}
