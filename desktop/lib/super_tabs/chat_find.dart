import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

import '../core/project_folder.dart' show foldDiacritics;
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'message_row.dart' show SuperTabMessageRow;
import 'model.dart';

/// How many older pages one search reads at most, as far back as a tagged
/// message is opened from (task #2826).
const superTabFindPages = 50;

final _marks = RegExp('[̀-ͯ]');

/// [text] as find compares it: "Tiếng Việt" and "tieng viet" read the same,
/// whether its accents were typed composed or combining.
String superTabFindFold(String text) =>
    foldDiacritics(unorm.nfd(text).replaceAll(_marks, '')).toLowerCase();

/// Find in the open chat or thread: the loaded rows that match, which one is
/// current, and reading older pages, at most [superTabFindPages] a search,
/// when stepping up past the oldest loaded match. Matches are numbered from
/// the newest, so pages read in add matches above without moving the number.
class SuperTabChatFind extends ChangeNotifier {
  SuperTabChatFind({
    required this.rows,
    required this.hasOlder,
    required this.readOlder,
  });

  /// The rows the list shows, oldest first.
  final List<SuperTabMessage> Function() rows;
  final bool Function() hasOlder;

  /// Reads the page before those loaded; false when the read failed.
  final Future<bool> Function() readOlder;

  String query = '';
  List<String> matches = const [];
  Set<String> matching = const {};
  String? current;

  /// Pages read so far by the read-back under way, null when none is.
  int? reading;
  String? note;

  // Pages this search has read, and the search a read-back belongs to.
  int _pages = 0, _search = 0;
  final _folded = <String, (String, String)>{};

  int get total => matches.length;
  int? get number {
    final at = current == null ? -1 : matches.indexOf(current!);
    return at < 0 ? null : matches.length - at;
  }

  void search(String query) {
    this.query = query;
    _search++;
    _pages = 0;
    reading = null;
    note = null;
    current = null;
    _match();
    current = matches.lastOrNull;
    notifyListeners();
  }

  /// Matches the rows again as the list draws them, telling no one: what the
  /// list draws next reads them. The current match stays the same message.
  void refresh() {
    _match();
    if (!matching.contains(current)) current = matches.lastOrNull;
  }

  void clear() => search('');

  /// Steps to the newer match; a read-back under way stops, as the phone's
  /// does.
  void newer() {
    if (reading != null) {
      _search++;
      reading = null;
    }
    final at = current == null ? -1 : matches.indexOf(current!);
    if (at >= 0 && at < matches.length - 1) current = matches[at + 1];
    note = null;
    notifyListeners();
  }

  /// A read-back under way stops with it: its view or thread is gone.
  @override
  void dispose() {
    _search++;
    super.dispose();
  }

  Future<void> older() async {
    if (reading != null || query.trim().isEmpty) return;
    final at = current == null ? matches.length : matches.indexOf(current!);
    if (at > 0) {
      current = matches[at - 1];
      note = null;
      notifyListeners();
      return;
    }
    final search = _search, oldest = matches.firstOrNull;
    while (true) {
      if (!hasOlder()) {
        note = 'No more matches in this chat';
        break;
      }
      if (_pages >= superTabFindPages) {
        note = 'No more matches in the last $superTabFindPages pages';
        break;
      }
      // The page on its way counts: "1 of 50" while the first is read.
      reading = _pages + 1;
      notifyListeners();
      final read = await readOlder();
      if (search != _search) return;
      _pages++;
      if (!read) {
        note = 'Couldn’t read older messages';
        break;
      }
      _match();
      final first = matches.firstOrNull;
      if (first != null && first != oldest) {
        // The newest of the matches the pages brought, just above the old.
        final end = oldest == null ? matches.length : matches.indexOf(oldest);
        current = matches[end - 1];
        note = null;
        break;
      }
    }
    reading = null;
    notifyListeners();
  }

  void _match() {
    final folded = superTabFindFold(query.trim());
    if (folded.isEmpty) {
      matches = const [];
      matching = const {};
      return;
    }
    matches = [
      for (final row in rows())
        if (_fold(row).contains(folded)) row.id,
    ];
    matching = matches.toSet();
  }

  /// Each message is folded once while its text stays the same.
  String _fold(SuperTabMessage row) {
    final seen = _folded[row.id];
    if (seen != null && seen.$1 == row.text) return seen.$2;
    final folded = superTabFindFold(row.text);
    _folded[row.id] = (row.text, folded);
    return folded;
  }
}

/// The find field over a chat or thread: "n of N", older and newer, close.
/// Enter steps older, Shift+Enter newer, Esc closes.
class SuperTabFindBar extends StatefulWidget {
  const SuperTabFindBar({
    super.key,
    required this.find,
    required this.onClose,
    this.focus,
  });

  final SuperTabChatFind find;
  final VoidCallback onClose;
  final FocusNode? focus;

  @override
  State<SuperTabFindBar> createState() => _SuperTabFindBarState();
}

class _SuperTabFindBarState extends State<SuperTabFindBar> {
  late final _text = TextEditingController(text: widget.find.query);
  late final _focus = widget.focus ?? FocusNode(debugLabel: 'Find in chat');

  @override
  void initState() {
    super.initState();
    _focus.requestFocus();
  }

  @override
  void dispose() {
    _text.dispose();
    if (widget.focus == null) _focus.dispose();
    super.dispose();
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final composing = _text.value.composing;
    if (composing.isValid && !composing.isCollapsed) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.escape) {
      widget.onClose();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      if (HardwareKeyboard.instance.isShiftPressed) {
        widget.find.newer();
      } else {
        widget.find.older();
      }
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  String _status(SuperTabChatFind find) {
    if (find.reading case final pages?) {
      return 'Reading older messages · $pages of $superTabFindPages';
    }
    if (find.note case final note?) return note;
    if (find.query.trim().isEmpty) return '';
    final number = find.number;
    return number == null ? 'No matches' : '$number of ${find.total}';
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.find,
      builder: (context, _) {
        final find = widget.find;
        final status = _status(find);
        return Container(
          key: const ValueKey('super-find-bar'),
          // The field lines up with the messages' text under it.
          padding: const EdgeInsets.fromLTRB(
            SuperTabMessageRow.horizontalInset,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.controlGap,
          ),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
          ),
          child: Row(
            children: [
              Expanded(
                child: Focus(
                  onKeyEvent: _key,
                  child: TextField(
                    key: const ValueKey('super-find-field'),
                    controller: _text,
                    focusNode: _focus,
                    style: DesktopChrome.text(),
                    onChanged: find.search,
                    decoration: const InputDecoration(
                      isDense: true,
                      hintText: 'Find in chat',
                      prefixIcon: Icon(AppIcons.search, size: 16),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              Semantics(
                liveRegion: true,
                child: Text(
                  status,
                  key: const ValueKey('super-find-count'),
                  maxLines: 1,
                  style: DesktopChrome.metadata(),
                ),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              AppIconButton(
                key: const ValueKey('super-find-older'),
                icon: AppIcons.chevronUp,
                tooltip: 'Older match (Enter)',
                onPressed: find.query.trim().isEmpty || find.reading != null
                    ? null
                    : find.older,
              ),
              AppIconButton(
                key: const ValueKey('super-find-newer'),
                icon: AppIcons.chevronDown,
                tooltip: 'Newer match (Shift-Enter)',
                onPressed: (find.number ?? 1) > 1 ? find.newer : null,
              ),
              AppIconButton(
                key: const ValueKey('super-find-close'),
                icon: AppIcons.close,
                tooltip: 'Close find (Esc)',
                onPressed: widget.onClose,
              ),
            ],
          ),
        );
      },
    );
  }
}
