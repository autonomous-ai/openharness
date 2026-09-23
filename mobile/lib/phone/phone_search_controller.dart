import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/phone_search_history.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_destination.dart';
import 'phone_search_catalog.dart';
import 'phone_search_commands.dart';
import 'phone_search_rank.dart';

/// What the box finds, said in the box.
///
/// The desktop's `kSwarmSearchHint`, word for word. It searches four kinds of
/// thing, and a hint that named only one of them ("Search agents") was most of
/// why nobody on the phone knew the other three existed.
const kPhoneSearchHint =
    'Search harnesses   > commands   # projects   @ machines   ? help';

/// One search session, shared by the field and its results.
///
/// The phone's `SwarmSearchController`. Ported mode for mode: `>` commands,
/// `#` projects, `@` machines, `?` help, and the group scope that choosing a
/// project or a machine drops you into.
///
/// ⚠️ **Keystrokes never ask a machine anything.** They filter the catalog the
/// app already holds — agents, machines, projects, and the session content
/// [AppNotifier.sessionPreviews] has cached — so typing on two bars of signal
/// stays instant and costs no data.
///
/// What the desktop has and this does not: panes, tabs, placement, splits, the
/// preview panel, and the "New Harness" row. All four are about WHERE a result
/// opens, and a phone has one place.
class PhoneSearchController extends ChangeNotifier {
  PhoneSearchController({
    required this.notifier,
    this.history,
    this.commands,
  }) {
    _catalog = _cache.read(notifier);
    _filter();
    notifier.addListener(_rebuild);
    notifier.sessionPreviews.addListener(_previewChanged);
  }

  final AppNotifier notifier;

  /// Where visits are remembered, so the box opens on the agents actually being
  /// switched between. Null keeps this search's ranking to one session.
  final PhoneSearchHistory? history;

  /// What `>` lists. Read on every filter rather than held, because which
  /// commands are available follows the app: there is no "Change model" while
  /// no agent is open.
  final List<PhoneCommand> Function()? commands;

  final _cache = PhoneSearchCatalogCache();
  List<PhoneDestination> _catalog = const [];
  Set<String> _commandIds = const {};

  /// What the list draws, best first.
  List<PhoneDestination> rows = const [];

  String query = '';

  /// How many things could match, and how many do — fzf's `4/7`. The quickest
  /// answer to "did that narrow it, or is it just not here?".
  int total = 0;
  int matchCount = 0;

  static final _quickAccessPrefix = RegExp(r'^[>@#?]');
  static final _commandPrefix = RegExp(r'^>\s*');
  static final _helpPrefix = RegExp(r'^\?\s*');

  bool get isCommandMode => query.trimLeft().startsWith('>');
  bool get isHelpMode => query.trimLeft().startsWith('?');
  bool get isProjectMode => query.trimLeft().startsWith('#');
  bool get isMachineMode => query.trimLeft().startsWith('@');
  bool get isGroupMode => isProjectMode || isMachineMode;

  String get commandQuery => query.trimLeft().replaceFirst(_commandPrefix, '');
  String get helpQuery => query.trimLeft().replaceFirst(_helpPrefix, '');

  /// The project or machine the search has been narrowed to, once one was
  /// chosen. Its [query] is what the field goes back to on [back].
  ({String id, String name, String query})? _groupScope;
  bool get canGoBack => _groupScope != null;
  String? get scopeName => _groupScope?.name;

  /// What the rows are actually matched against: the query minus its mode
  /// character.
  String get matchQuery => isCommandMode
      ? commandQuery
      : isHelpMode
      ? helpQuery
      : isGroupMode
      ? query.trimLeft().substring(1).trimLeft()
      : query;

  String get title => isCommandMode
      ? 'Commands'
      : isHelpMode
      ? 'Quick access'
      : isProjectMode
      ? 'Projects'
      : isMachineMode
      ? 'Machines'
      : _groupScope != null
      ? 'Harnesses · ${_groupScope!.name}'
      : 'Search';

  String get hint => isCommandMode
      ? 'Search commands…'
      : isHelpMode
      ? 'Choose a mode or search help…'
      : _groupScope != null
      ? 'Search harnesses in ${_groupScope!.name}…'
      : isProjectMode
      ? 'Search projects…'
      : isMachineMode
      ? 'Search machines…'
      : kPhoneSearchHint;

  void setQuery(String value) {
    if (query == value) return;
    // Typing a mode character leaves whatever group was chosen: `@` means "pick
    // a machine", which is not a thing to do inside one.
    if (_quickAccessPrefix.hasMatch(value.trimLeft())) _groupScope = null;
    query = value;
    _filter();
    notifyListeners();
  }

  /// Leaves the chosen project or machine, putting the query that chose it back
  /// in the field. False when there was no group to leave, so the caller can let
  /// the gesture close the search instead.
  bool back() {
    final scope = _groupScope;
    if (scope == null) return false;
    _groupScope = null;
    setQuery(scope.query);
    return true;
  }

  /// Back to an empty box: no query, and out of any project or machine chosen
  /// on the way — what a search that was cancelled opens on next time.
  void reset() {
    if (query.isEmpty && _groupScope == null) return;
    _groupScope = null;
    query = '';
    _filter();
    notifyListeners();
  }

  /// What a tap does: scope to a group, take a `?` row's mode, or hand the row
  /// back for the caller to open. Null when the tap was absorbed here.
  PhoneDestination? submit(PhoneDestination row) {
    if (!canSubmit(row)) return null;
    if (row.isGroup) {
      final group = _catalog
          .where((entry) => entry.id == row.id && entry.isGroup)
          .firstOrNull;
      if (group == null) return null;
      _groupScope = (id: group.id, name: group.title, query: query);
      setQuery('');
      return null;
    }
    if (row.pickerQuery case final next?) {
      setQuery(next);
      return null;
    }
    if (row.isCommand) {
      final id = row.commandId;
      if (id != null) history?.rememberCommand(id);
      return row;
    }
    final id = row.agentId == null ? null : row.id;
    if (id != null) history?.remember(id);
    return row;
  }

  /// Whether a tap on [row] can do anything at all. A row that cannot is drawn
  /// dimmed with the reason on its trailing edge rather than hidden: an agent
  /// whose terminal has gone is still the answer to "where did it go".
  bool canSubmit(PhoneDestination row) => switch (row.kind) {
    // Stopped work counts: the tap resumes it first — see [AgentEntry.isOpenable].
    PhoneDestinationKind.agent => row.entry?.isOpenable ?? false,
    // A locked machine opens its password form, which is the thing to do about
    // it; a switched-off one has nothing to take a password.
    PhoneDestinationKind.machine =>
      _catalog.any((entry) => entry.id == row.id && entry.isMachine),
    PhoneDestinationKind.project =>
      _catalog.any((entry) => entry.id == row.id && entry.isProject),
    PhoneDestinationKind.command => _commandIds.contains(row.id),
    PhoneDestinationKind.mode => true,
  };

  void _rebuild() {
    final next = _cache.read(notifier);
    // Nothing about the fleet changed shape, so the rows cannot have either —
    // and re-ranking would hand the list a new set of objects to rebuild from
    // for no reason. What the rows SAY still updates: they read their machine
    // live, and the preview store has its own path in.
    if (identical(next, _catalog)) return;
    _catalog = next;
    _filter();
    _scheduleNotify();
  }

  /// Content landing can add or remove a match, but must never shuffle the rows
  /// under a thumb or repaint a list whose result set has not changed.
  void _previewChanged() {
    if (matchQuery.trim().isEmpty || isCommandMode || isHelpMode) return;
    final previous = rows;
    _filter();
    if (!listEquals(previous, rows)) _scheduleNotify();
  }

  /// Announce a change the APP made, one microtask late.
  ///
  /// ⚠️ **Never synchronously, because these two arrive mid-build.**
  /// [PhoneSearchResults] warms the preview store from its `initState`, and the
  /// store publishes to its listeners as it goes — so the controller was told to
  /// re-rank while the very list watching it was still being built, and
  /// `markNeedsBuild` threw. A microtask drains after the build phase, which is
  /// the earliest moment a rebuild can legally be asked for.
  ///
  /// [rows] is still updated synchronously above: what the box HOLDS is current
  /// immediately, and only the repaint waits. Coalesced, so a machine answering
  /// with forty agents costs one rebuild rather than forty.
  ///
  /// Typing does not come through here — [setQuery] notifies directly, because a
  /// keystroke is never inside a build and the field must not lag a frame.
  void _scheduleNotify() {
    if (_notifyScheduled || _disposed) return;
    _notifyScheduled = true;
    scheduleMicrotask(() {
      _notifyScheduled = false;
      if (!_disposed) notifyListeners();
    });
  }

  bool _notifyScheduled = false;
  bool _disposed = false;

  void _filter() {
    if (isHelpMode) {
      // The modes keep the order they are taught in; what follows `?` only
      // narrows them, the way a quick-open's own `?` does.
      final all = phoneSearchModes(commands?.call() ?? const <PhoneCommand>[]);
      final needle = helpQuery.trim().toLowerCase();
      _commandIds = {for (final mode in all) mode.id};
      total = all.length;
      rows = [
        for (final mode in all)
          if (needle.isEmpty ||
              mode.fields.any((field) => field.contains(needle)))
            mode,
      ];
      matchCount = rows.length;
      return;
    }
    final available = isCommandMode
        ? [
            for (final command
                in commands?.call() ?? const <PhoneCommand>[])
              command.destination,
          ]
        : const <PhoneDestination>[];
    _commandIds = {for (final row in available) row.id};
    final scoped = _groupScope == null
        ? null
        : _catalog
                  .where((row) => row.id == _groupScope!.id)
                  .firstOrNull
                  ?.members ??
              const <String>{};
    final candidates = isCommandMode
        ? available
        : isProjectMode
        ? [for (final row in _catalog) if (row.isProject) row]
        : isMachineMode
        ? [for (final row in _catalog) if (row.isMachine) row]
        : scoped != null
        ? [
            for (final row in _catalog)
              if (row.isAgent && scoped.contains(row.id)) row,
          ]
        // ⚠️ **Agents only, and this is the desktop's behaviour, not a cut.**
        // Every one of `swarm_screen.dart`'s six `_openSearch` calls passes
        // `adding: true`, which makes `placement` (or `split`) non-null, which
        // takes `_filter` down its `row.agentId != null` branch. So the desktop
        // box has never listed a machine or a project in a plain query — its
        // `16/16` counts agents. They are reached through `@` and `#`, and they
        // stay searchable as fields on the agents inside them.
        : [
            for (final row in _catalog)
              if (row.isAgent) row,
          ];
    total = candidates.length;
    rows = isCommandMode
        ? _recentFirst(rankPhoneDestinations(candidates, commandQuery))
        : rankPhoneDestinations(
            candidates,
            matchQuery,
            recent: history?.recent ?? const <String>[],
            previews: notifier.sessionPreviews,
          );
    matchCount = rows.length;
    // ⚠️ **Not with nothing typed.** That list is the desktop's Harness Monitor
    // order ([rankPhoneDestinations]), where paused work sits among the rest by
    // when it last moved — moving it to the bottom here is the phone's list
    // disagreeing with the laptop's again.
    if (_listsMonitorOrder) return;
    // Keep the match order, but put rows a tap can open first. An agent whose
    // terminal has gone must not bury the ones that answer.
    final open = <PhoneDestination>[];
    final shut = <PhoneDestination>[];
    for (final row in rows) {
      (canSubmit(row) ? open : shut).add(row);
    }
    rows = [...open, ...shut];
    matchCount = rows.length;
  }

  /// Whether [rows] are agents with nothing typed — the list that follows the
  /// desktop's monitor.
  bool get _listsMonitorOrder =>
      !isCommandMode &&
      !isProjectMode &&
      !isMachineMode &&
      matchQuery.trim().isEmpty;

  /// With nothing typed, the commands run lately lead, newest first; the rest
  /// keep their order. Once something is typed, the match decides.
  List<PhoneDestination> _recentFirst(List<PhoneDestination> ranked) {
    final recent = history?.recentCommands ?? const <String>[];
    if (commandQuery.trim().isNotEmpty || recent.isEmpty) return ranked;
    final byId = {
      for (final row in ranked)
        if (row.commandId != null) row.commandId!: row,
    };
    final first = [for (final id in recent) ?byId[id]];
    return [
      ...first,
      for (final row in ranked)
        if (!first.contains(row)) row,
    ];
  }

  @override
  void dispose() {
    _disposed = true;
    notifier.removeListener(_rebuild);
    notifier.sessionPreviews.removeListener(_previewChanged);
    super.dispose();
  }
}
