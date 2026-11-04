import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_new_message_sheet.dart' show swarmSearchFold;
import 'swarm_style.dart';

/// How many older pages one search reads at the most, counted from the last
/// change to its query (task #2826): as many as a quote's original is looked
/// for in.
const swarmFindPages = 50;

const _limitNote = 'No more matches in the last $swarmFindPages pages';
const _startNote = 'No more matches in this chat';
const _failedNote = 'Couldn’t read older messages';

/// Find in the open chat — the main chat or a thread (task #2826, the
/// desktop's `SuperTabChatFind`): the messages [rows] shows (oldest first)
/// that say [query], case and accents aside ([swarmSearchFold]), numbered
/// from the newest (1), so an older page adds matches above without moving
/// [number].
///
/// Typing never reads a page. [older] past the oldest loaded match reads
/// older pages ([readOlder]) one at a time until one brings a match, the chat
/// starts, a read fails, or [swarmFindPages] were read since the query last
/// changed; [note] says which. A new [search], [newer] or [clear] stops a
/// read-back under way.
class SwarmChatFind extends ChangeNotifier {
  SwarmChatFind({
    required this.rows,
    required this.hasOlder,
    required this.readOlder,
  });

  /// The messages the chat shows, oldest first.
  final List<SuperTabMessage> Function() rows;

  /// Older messages wait to be read.
  final bool Function() hasOlder;

  /// Reads the page before the oldest shown; false when it failed, or
  /// brought nothing while more is said to be there.
  final Future<bool> Function() readOlder;

  String _query = '';
  String get query => _query;

  List<String> _matches = const [];
  Set<String> _matching = const {};

  /// The ids of the rows that match, oldest first.
  List<String> get matches => _matches;
  Set<String> get matching => _matching;

  /// The match shown and lit; null with none.
  String? get current => _current;
  String? _current;

  /// [current]'s place, the newest match being 1.
  int? get number {
    final at = _current == null ? -1 : _matches.indexOf(_current!);
    return at < 0 ? null : _matches.length - at;
  }

  int get total => _matches.length;

  /// While a read-back runs: how many of this search's [swarmFindPages] it
  /// has read, the one under way included. Null otherwise.
  int? get reading => _reading;
  int? _reading;

  /// Why Up found nothing older: the page limit, the chat's start, or a read
  /// that failed.
  String? get note => _note;
  String? _note;

  /// Older pages this search has read.
  int _pages = 0;

  /// Moves on with every search, close and step down: a read-back that
  /// started under another stops.
  int _generation = 0;
  bool _disposed = false;

  /// Each row's text folded, by id, with the text it was folded from: a row
  /// is folded again only once edited.
  var _folded = <String, (String, String)>{};

  /// What the person typed: the newest match is current. Reads nothing.
  void search(String query) {
    if (query == _query) return;
    _query = query;
    _restart();
    _match();
    _current = _matches.lastOrNull;
    _tell();
  }

  /// Closes the search: no query, no matches, no read-back.
  void clear() {
    _query = '';
    _restart();
    _matches = const [];
    _matching = const {};
    _current = null;
    _folded = {};
    _tell();
  }

  void _restart() {
    _generation++;
    _pages = 0;
    _reading = null;
    _note = null;
  }

  /// The rows changed (a message arrived, was edited or went): [current]
  /// stays the same message while it still matches, else the newest does.
  void refresh() {
    final before = (_matches, _current);
    _match();
    if (!_matching.contains(_current)) _current = _matches.lastOrNull;
    if (!listEquals(before.$1, _matches) || before.$2 != _current) _tell();
  }

  /// One match newer; it stops a read-back under way, which went the other
  /// way.
  void newer() {
    if (_reading != null) {
      _generation++;
      _reading = null;
    }
    _note = null;
    final at = _current == null ? -1 : _matches.indexOf(_current!);
    if (at >= 0 && at < _matches.length - 1) _current = _matches[at + 1];
    _tell();
  }

  /// One match older: read in from older pages when none older is loaded.
  /// Nothing while a read-back runs.
  Future<void> older() async {
    if (_reading != null) return;
    final at = _current == null ? -1 : _matches.indexOf(_current!);
    if (at > 0) {
      _current = _matches[at - 1];
      _note = null;
      return _tell();
    }
    if (_needle.isEmpty) return;
    final generation = _generation, from = _current;
    _note = null;
    while (true) {
      if (!hasOlder()) {
        _note = _startNote;
        break;
      }
      if (_pages >= swarmFindPages) {
        _note = _limitNote;
        break;
      }
      _reading = ++_pages;
      _tell();
      bool read;
      try {
        read = await readOlder();
      } catch (_) {
        read = false;
      }
      if (_disposed || generation != _generation) return;
      _match();
      if (!_matching.contains(_current)) _current = _matches.lastOrNull;
      if (!read) {
        _note = _failedNote;
        break;
      }
      // The match just older than where Up was pressed, or the newest one
      // when there was none.
      final was = from == null ? -1 : _matches.indexOf(from);
      if (was > 0 || (was < 0 && _matches.isNotEmpty)) {
        _current = was > 0 ? _matches[was - 1] : _matches.last;
        break;
      }
    }
    _reading = null;
    _tell();
  }

  String get _needle => swarmSearchFold(_query.trim());

  void _match() {
    final needle = _needle;
    if (needle.isEmpty) {
      _matches = const [];
      _matching = const {};
      return;
    }
    final kept = _folded, folded = <String, (String, String)>{};
    final ids = <String>[];
    for (final m in rows()) {
      if (m.deleted || folded.containsKey(m.id)) continue;
      final was = kept[m.id];
      final text = was != null && was.$1 == m.text
          ? was
          : (m.text, swarmSearchFold(m.text));
      folded[m.id] = text;
      if (text.$2.contains(needle)) ids.add(m.id);
    }
    _folded = folded;
    _matches = List.unmodifiable(ids);
    _matching = Set.unmodifiable(ids);
  }

  void _tell() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    super.dispose();
  }
}

/// Find's bar, under the chat's or the thread's header: the field, "n of N",
/// ↑ older, ↓ newer and ✕, each a 44-point target; what Up found nothing
/// older for, or how far it reads back, on a line under them. The keyboard's
/// search key steps older, the keyboard staying up.
class SwarmFindBar extends StatefulWidget {
  const SwarmFindBar({
    super.key,
    required this.find,
    required this.onClose,
    this.hint = 'Find in chat',
  });

  final SwarmChatFind find;
  final VoidCallback onClose;

  /// What the empty field says: the thread's says "Find in thread".
  final String hint;

  @override
  State<SwarmFindBar> createState() => _SwarmFindBarState();
}

class _SwarmFindBarState extends State<SwarmFindBar> {
  late final _field = TextEditingController(text: widget.find.query);

  @override
  void initState() {
    super.initState();
    _field.addListener(_typed);
    widget.find.addListener(_cleared);
  }

  @override
  void didUpdateWidget(SwarmFindBar old) {
    super.didUpdateWidget(old);
    if (old.find == widget.find) return;
    old.find.removeListener(_cleared);
    widget.find.addListener(_cleared);
    _cleared();
  }

  @override
  void dispose() {
    widget.find.removeListener(_cleared);
    _field.dispose();
    super.dispose();
  }

  void _typed() => widget.find.search(_field.text);

  /// The search was closed or replaced under the field: it says so too.
  void _cleared() {
    if (widget.find.query != _field.text) _field.text = widget.find.query;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.find,
      builder: (context, _) {
        final find = widget.find;
        final typed = find.query.trim().isNotEmpty;
        final number = find.number;
        final count = !typed
            ? null
            : number == null
            ? 'No matches'
            : '$number of ${find.total}';
        final status = switch (find.reading) {
          final pages? => 'Reading older messages · $pages of $swarmFindPages',
          null => find.note,
        };
        return Padding(
          key: const ValueKey('swarm-find-bar'),
          // The ✕'s drawn box ends at the screen's side inset.
          padding: const EdgeInsetsDirectional.fromSTEB(
            AppSpace.screenInset,
            AppSpace.xs,
            AppSpace.xs,
            AppSpace.xs,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(child: _input()),
                  if (count != null)
                    Padding(
                      padding: const EdgeInsetsDirectional.only(
                        start: AppSpace.s,
                      ),
                      child: Text(
                        count,
                        key: const ValueKey('swarm-find-count'),
                        maxLines: 1,
                        style: AppType.caption(
                          color: AppPalette.textSecondary,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ),
                  SwarmIconButton(
                    key: const ValueKey('swarm-find-older'),
                    icon: LucideIcons.chevronUp300,
                    label: 'Older match',
                    onPressed: typed && find.reading == null
                        ? () => unawaited(find.older())
                        : null,
                  ),
                  SwarmIconButton(
                    key: const ValueKey('swarm-find-newer'),
                    icon: LucideIcons.chevronDown300,
                    label: 'Newer match',
                    onPressed:
                        number != null && number > 1 || find.reading != null
                        ? find.newer
                        : null,
                  ),
                  SwarmIconButton(
                    key: const ValueKey('swarm-find-close'),
                    icon: LucideIcons.x300,
                    label: 'Close find',
                    onPressed: widget.onClose,
                  ),
                ],
              ),
              if (status != null)
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    start: AppSpace.m,
                    top: AppSpace.xs,
                  ),
                  child: Text(
                    status,
                    key: const ValueKey('swarm-find-status'),
                    style: AppType.caption(color: AppPalette.textSecondary),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  /// The field, as Search's is: a pill with the search glyph, none of the
  /// app's field look.
  Widget _input() => Material(
    color: AppPalette.swarmSearchSurface,
    shape: const StadiumBorder(),
    clipBehavior: Clip.antiAlias,
    child: TextField(
      key: const ValueKey('swarm-find-field'),
      controller: _field,
      autofocus: true,
      autocorrect: false,
      textInputAction: TextInputAction.search,
      // Search steps older, and the keyboard stays up for the next.
      onEditingComplete: () {},
      onSubmitted: (_) => unawaited(widget.find.older()),
      style: AppType.label(color: AppPalette.textPrimary),
      cursorColor: AppPalette.swarmAccent,
      decoration: InputDecoration(
        isDense: true,
        filled: false,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        hintText: widget.hint,
        hintStyle: AppType.label(color: AppPalette.textFaint),
        prefixIcon: Icon(
          LucideIcons.search300,
          size: AppIconSize.besideText,
          color: AppPalette.textSecondary,
        ),
        contentPadding: const EdgeInsets.symmetric(vertical: AppSpace.m),
      ),
    ),
  );
}
