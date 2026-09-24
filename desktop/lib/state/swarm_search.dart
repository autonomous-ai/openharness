import 'package:flutter/foundation.dart';

import 'app_state.dart';
import 'harness_placement.dart';
import 'pane_arrangement.dart';
import 'swarm_catalog.dart';
import 'swarm_navigation.dart';

/// What the box finds, said in the box: it searches four kinds of thing, and
/// "Find a harness" named one of them.
const kSwarmSearchHint =
    'Search agents    > commands    # projects    @ machines    ? help';
const kHarnessPickerHint = 'Find a harness…';

const kSwarmCreateRowId = 'create:harness';

/// Search text and selection retained while the start-page picker is dismissed.
/// Membership and availability are revalidated against a fresh catalog on return.
class SwarmSearchDraft {
  const SwarmSearchDraft._(
    this.targetId,
    this.query,
    this.selectedId,
    this.groupScope,
  );
  final String targetId, query;
  final String? selectedId;
  final ({String id, String name, String query})? groupScope;
}

/// One search session, shared by the native/Flutter input and its results.
/// Keystrokes only filter the cached catalog; they never query a machine.
class SwarmSearchController extends ChangeNotifier {
  SwarmSearchController(
    this.app,
    this.recent, {
    this.projects,
    this.history,
    this.commands,
    this.recentCommands,
    this.modes,
    this.adding = false,
    this.navigating = false,
    this.activityFirst = false,
    this.commandsOnly = false,
    this.offersCreate = false,
    this.resultsFromBottom = false,
    this._placement,
    this._split,
    bool previewInitiallyVisible = true,
    SwarmSearchCatalog? catalog,
    SwarmLocationCatalog? locations,
  }) : _previewVisible = previewInitiallyVisible,
       _cache = catalog ?? SwarmSearchCatalog(),
       _locations = locations ?? SwarmLocationCatalog(),
       targetId = app.activeSwarmId,
       targetName = app.activeSwarm.name {
    _refresh();
    app.addListener(_refresh);
    projects?.addListener(_refresh);
    app.sessionPreviews.addListener(_previewChanged);
  }

  final AppNotifier app;
  final List<String> recent;
  final SwarmProjectStore? projects;
  final SwarmNavigationHistory? history;

  /// Availability is read from workspace state and rechecked at activation.
  /// Commands never enter the ordinary agent/swarm catalog or History.
  final List<SwarmDestination> Function()? commands;

  /// Command ids run lately, most recent first: with nothing typed the
  /// palette opens on these, in this order, ahead of the rest.
  final List<String> Function()? recentCommands;

  /// The rows `?` lists: the box's other modes, as commands with their keys.
  final List<SwarmDestination> Function()? modes;
  final bool adding;
  final bool navigating;

  /// Open Harness filters by latest activity; commands and splits keep relevance order.
  final bool activityFirst;
  bool get setupLayout => activityFirst && !isCommandMode && !isHelpMode;
  final bool commandsOnly;

  /// Whether the list ends in a row that makes a harness instead of finding
  /// one. What was typed becomes the new harness's first task.
  final bool offersCreate;

  /// Docked pickers keep their best match next to the input at the bottom.
  /// Catalog ranking stays unchanged; rendering and spatial movement invert.
  final bool resultsFromBottom;
  HarnessPlacement? _placement;
  HarnessPlacement? get placement => _placement;
  PaneSplitRequest? _split;
  PaneSplitRequest? get split => _split;
  bool get allowsCommands => history == null && !navigating;
  bool get isCommandMode =>
      allowsCommands && (commandsOnly || query.trimLeft().startsWith('>'));

  /// `?` — what this one box can do, each with the key that goes there
  /// directly. An editor's quick-open answers `?` the same way: five shortcuts
  /// that open five things read as five features, and they are one.
  bool get isHelpMode =>
      modes != null &&
      allowsCommands &&
      !commandsOnly &&
      !navigating &&
      query.trimLeft().startsWith('?');
  String get helpQuery => query.trimLeft().replaceFirst(_helpPrefix, '');
  bool get isProjectMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith('#');
  static final _quickAccessPrefix = RegExp(r'^[>@#?]');
  bool get isMachineMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith('@');
  bool get isGroupMode => isProjectMode || isMachineMode;
  ({String id, String name, String query})? _groupScope;
  bool get canGoBack => _groupScope != null;
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
      : switch (split?.axis) {
          PaneResizeAxis.x => 'New Pane to the Right',
          PaneResizeAxis.y => 'New Pane Below',
          null => placement?.title ?? 'Search',
        };

  bool _previewVisible;
  bool get previewVisible => _previewVisible;
  bool get supportsPreview => !isCommandMode && !isHelpMode && history == null;
  bool get canPreview =>
      supportsPreview &&
      selected != null &&
      // With nothing found the only row is "New harness: …"; a preview beside
      // it could only say the same words again, over 400px of empty panel.
      rows.any((row) => !row.isCreate);

  bool get hasPreview =>
      _previewVisible && canPreview && selected?.isCreate != true;

  void togglePreview() {
    if (!supportsPreview) return;
    _previewVisible = !_previewVisible;
    notifyListeners();
  }

  /// How many things could match, and how many do: fzf's `4/7`. The count is
  /// the quickest answer to "did that narrow it, or is it just not here?".
  int total = 0;

  /// Counted once per filter, not once per read: the count and the hints both
  /// rebuild on every arrow key.
  int matchCount = 0;

  // Compiled once: both run in `_filter` and in two builds per keystroke.
  static final _helpPrefix = RegExp(r'^\?\s*');
  static final _commandPrefix = RegExp(r'^>\s*');

  // Paging the preview must not rebuild the result list or its text editor.
  final _previewPage = ValueNotifier<int>(0);
  ValueListenable<int> get previewPage => _previewPage;
  final _resultPage = ValueNotifier<int>(0);
  ValueListenable<int> get resultPage => _resultPage;
  void page(int pages) {
    if (hasPreview) {
      _previewPage.value += pages;
    } else {
      _resultPage.value += pages;
    }
  }

  final String targetId, targetName;
  // The workspace can retain normalized metadata across picker openings. Each
  // read still validates its snapshot; query, selection and output stay local.
  final SwarmSearchCatalog _cache;
  final SwarmLocationCatalog _locations;
  List<SwarmDestination> _catalog = const [];
  Set<String> _commandIds = const {};
  List<SwarmDestination> rows = const [];
  String query = '';
  String? _selectedId;
  int cursor = 0;
  bool? _splitCurrent;
  Set<String> _presentIds = const {};
  SwarmSearchDraft get draft =>
      SwarmSearchDraft._(targetId, query, selected?.id, _groupScope);

  void restoreDraft(SwarmSearchDraft draft, {bool newTab = false}) {
    if (!adding || (!newTab && draft.targetId != targetId)) return;
    query = draft.query;
    _groupScope = draft.groupScope;
    _selectedId = draft.selectedId;
    cursor = 0;
    _filter();
    notifyListeners();
  }

  /// Cmd-T and Cmd-P change where Enter opens the result, while the query,
  /// highlighted result and project/machine scope remain the person's choices.
  bool changePlacement(HarnessPlacement placement) {
    if (!adding ||
        navigating ||
        history != null ||
        targetId != app.activeSwarmId) {
      return false;
    }
    if (_placement != placement || _split != null) {
      _placement = placement;
      _split = null;
      // Capacity and "already here" are destination-dependent even when the
      // catalog itself has not changed.
      _refresh(force: true);
    }
    return true;
  }

  int get capacity {
    if (placement == HarnessPlacement.newTab) return AppNotifier.maxPanes;
    final target = app.swarms
        .where((swarm) => swarm.id == targetId)
        .firstOrNull;
    return target == null ? 0 : AppNotifier.maxPanes - target.panes.length;
  }

  bool get canAccept => canSubmit(selected);

  SwarmDestination? get selected => rows.isEmpty ? null : rows[cursor];
  String get hint => isCommandMode
      ? 'Search commands…'
      : isHelpMode
      ? 'Choose a mode or search help…'
      : _groupScope != null
      ? 'Search agents in ${_groupScope!.name}…'
      : isProjectMode
      ? 'Search projects…'
      : isMachineMode
      ? 'Search machines…'
      : history != null
      ? 'Search history…'
      : placement != null
      ? kHarnessPickerHint
      : kSwarmSearchHint;

  /// What the create row would start the harness on: what was typed, as its
  /// first message. An editor's palette offers `New agent: "fix the login
  /// test"` the same way — in the AI age the thing you type when nothing
  /// matches is more often a job than a name. (Naming the project is a field
  /// of New Harness itself.)
  String? get createTask {
    final typed = query.trim();
    if (typed.isEmpty ||
        isCommandMode ||
        isHelpMode ||
        _groupScope != null ||
        isGroupMode) {
      return null;
    }
    return typed;
  }

  bool get _showsCreateRow =>
      offersCreate &&
      adding &&
      history == null &&
      !navigating &&
      !isCommandMode &&
      !isHelpMode &&
      _groupScope == null &&
      !isGroupMode &&
      canCreate;

  SwarmDestination? _createRow;
  SwarmDestination _createRowFor(String? name) {
    const title = 'New Harness';
    // The same object while the words are the same: live preview text
    // re-filters constantly and compares rows by identity.
    if (_createRow?.task == name && _createRow != null) return _createRow!;
    return _createRow = SwarmDestination(
      id: kSwarmCreateRowId,
      title: title,
      detail: name ?? 'use current defaults',
      swarmId: null,
      current: false,
      isCreate: true,
      task: name,
    );
  }

  bool get canCreate =>
      history == null &&
      (placement == HarnessPlacement.newTab ||
          app.swarms.any(
            (swarm) =>
                swarm.id == targetId &&
                !swarm.isStore &&
                !swarm.isOrchestrator &&
                swarm.panes.length < AppNotifier.maxPanes,
          )) &&
      (split == null || app.isPaneSplitCurrent(split!));

  String get commandQuery => query.trimLeft().replaceFirst(_commandPrefix, '');

  String get primaryAction =>
      placement?.action ??
      switch (split?.axis) {
        PaneResizeAxis.x => 'Split right',
        PaneResizeAxis.y => 'Split down',
        null => 'Open Harness',
      };

  String actionLabel(SwarmDestination? row) => row?.isCreate == true
      ? 'New Harness'
      : row?.pickerQuery != null
      ? 'Open'
      : isGroupMode && row?.isGroup == true
      ? 'Choose ${isProjectMode ? 'project' : 'machine'}'
      : placement != null && row != null && alreadyHere(row)
      ? 'Focus pane'
      : row?.isCommand == true
      ? (isHelpMode ? 'Open' : action(row!))
      : adding
      ? row != null &&
                row.agentId == null &&
                split == null &&
                _missingCount(row) > 1
            ? 'Open ${_missingCount(row)} Harnesses'
            : primaryAction
      : row == null
      ? 'Go to'
      : action(row);

  String get unavailableMessage =>
      split != null && !app.isPaneSplitCurrent(split!)
      ? 'The layout changed. Split the pane again.'
      : selected != null && alreadyHere(selected!)
      ? 'This harness is already open here.'
      // A tab, project or machine with nothing left to add is not "no room".
      : selected != null &&
            selected!.agentId == null &&
            selected!.members.isNotEmpty &&
            !_hasMissing(selected!)
      ? 'Everything in it is already open here.'
      : 'No room for another harness.';

  void _refresh({bool force = false}) {
    final next = navigating
        ? _locations.read(app, projects?.projects ?? const [])
        : history == null
        ? _cache.read(app, projects?.projects ?? const [], recent: recent)
        : [...history!.menuDestinations(app), ...closedWorkDestinations(app)];
    final splitCurrent = split == null || app.isPaneSplitCurrent(split!);
    if (!force && identical(next, _catalog) && splitCurrent == _splitCurrent) {
      if (!isCommandMode) return;
      // Which commands are available follows the workspace, so command mode
      // cannot skip the look — but most ticks change none of them, and those
      // must not re-rank, re-sort and rebuild the list.
      final available = {
        for (final command in commands?.call() ?? const <SwarmDestination>[])
          command.id,
      };
      if (setEquals(available, _commandIds)) return;
    }
    _catalog = next;
    _splitCurrent = splitCurrent;
    _presentIds = {
      for (final swarm in app.swarms.where(
        (s) => placement != HarnessPlacement.newTab && s.id == targetId,
      ))
        for (final pane in swarm.panes)
          if (pane.agentId != null)
            agentDestinationId(pane.machineId, pane.agentId!),
    };
    _filter();
    notifyListeners();
  }

  void refreshCommands() {
    if (!isCommandMode) return;
    _filter();
    notifyListeners();
  }

  void _previewChanged() {
    if (matchQuery.trim().isEmpty ||
        isCommandMode ||
        isHelpMode ||
        history != null) {
      return;
    }
    final previous = rows;
    final previousSelection = selected?.id;
    _filter(keepOrder: true);
    // Live text can add/remove a match. Preserve selection and avoid repainting
    // the editor when the result set is unchanged.
    if (!listEquals(previous, rows) || previousSelection != selected?.id) {
      notifyListeners();
    }
  }

  void _filter({bool keepOrder = false}) {
    final previous = rows;
    if (isHelpMode) {
      // The modes keep the order they are taught in; what follows `?` only
      // narrows them, the way a quick-open's own `?` does.
      final all = modes?.call() ?? const <SwarmDestination>[];
      final needle = helpQuery.toLowerCase();
      _commandIds = {for (final mode in all) mode.id};
      total = all.length;
      rows = [
        for (final mode in all)
          if (needle.isEmpty ||
              mode.fields.any((field) => field.contains(needle)) ||
              mode.detail.toLowerCase().contains(needle))
            mode,
      ];
      cursor = rows.isEmpty ? 0 : cursor.clamp(0, rows.length - 1);
      _selectedId = selected?.id;
      matchCount = rows.length;
      return;
    }
    final availableCommands = isCommandMode
        ? commands?.call() ?? const <SwarmDestination>[]
        : const <SwarmDestination>[];
    final byActivity =
        activityFirst && !navigating && !isCommandMode && !isGroupMode;
    _commandIds = {for (final command in availableCommands) command.id};
    final scopedMembers = _groupScope == null
        ? null
        : _catalog
                  .where((row) => row.id == _groupScope!.id)
                  .firstOrNull
                  ?.members ??
              <String>{};
    final candidates = isCommandMode
        ? availableCommands
        : isProjectMode
        ? _catalog.where((row) => row.isProject).toList()
        : isMachineMode
        ? _catalog.where((row) => row.isMachine).toList()
        : placement != null || _groupScope != null
        ? _catalog
              .where(
                (row) =>
                    row.agentId != null &&
                    (scopedMembers == null || scopedMembers.contains(row.id)),
              )
              .toList()
        : navigating || !adding
        ? _catalog
        : _catalog
              .where(
                (row) =>
                    (split == null || row.agentId != null) &&
                    (_hasMissing(row) ||
                        (query.isNotEmpty && row.agentId != null)),
              )
              .toList();
    total = candidates.length;
    rows = isCommandMode
        ? _recentFirst(rankSwarmDestinations(availableCommands, commandQuery))
        : navigating
        ? rankSwarmLocations(
            _catalog,
            matchQuery,
            recent: recent,
            previews: app.sessionPreviews,
          )
        : byActivity
        ? rankSwarmDestinationsByActivity(
            candidates,
            matchQuery,
            recent: recent,
            previews: app.sessionPreviews,
          )
        : rankSwarmDestinations(
            candidates,
            matchQuery,
            recent: recent,
            previews: history == null ? app.sessionPreviews : null,
          );
    if (keepOrder && !navigating && !byActivity) {
      final remaining = {for (final row in rows) row.id: row};
      rows = [
        for (final row in previous) ?remaining.remove(row.id),
        ...remaining.values,
      ];
    }
    // Keep the match order within each group, but put rows Return can open
    // first. An already-added exact match must not bury the usable matches.
    // Location navigation retains its parent/child structure; Open Harness
    // retains its activity order, including unavailable sessions.
    if (!navigating && !isCommandMode && !byActivity) {
      final available = <SwarmDestination>[];
      final unavailable = <SwarmDestination>[];
      for (final row in rows) {
        (canSubmit(row) ? available : unavailable).add(row);
      }
      rows = [...available, ...unavailable];
    }
    // Creation has a stable place beside the prompt. Filtering changes the
    // matches above it, never the position of the action itself.
    if (offersCreate) {
      final create = _showsCreateRow ? _createRowFor(createTask) : null;
      final found = [
        for (final row in rows)
          if (!row.isCreate) row,
      ];
      // Navigating (⌘O) always leads with New Harness: the list below it is
      // ordered by latest activity, so the one thing that is never a
      // result needs a fixed home rather than a place in that order.
      rows =
          resultsFromBottom ||
              navigating ||
              placement != null ||
              query.trim().isEmpty
          ? [?create, ...found]
          : [...found, ?create];
    }
    // The parent stays above its children visually, but Enter after a query
    // still targets the best match, including an agent nested under that parent.
    final preferred =
        _selectedId ??
        (navigating && !isCommandMode
            ? rankSwarmDestinations(
                rows,
                query,
                recent: recent,
                previews: app.sessionPreviews,
              ).firstOrNull?.id
            : null);
    final index = rows.indexWhere((row) => row.id == preferred);
    cursor = rows.isEmpty
        ? 0
        : index >= 0
        ? index
        // New Tab, New Pane and directional splits start on creation with an
        // empty query. Other searches and typed queries prefer a match.
        : preferred == null &&
              rows.length > 1 &&
              rows.first.isCreate &&
              ((placement == null && split == null) || query.trim().isNotEmpty)
        ? 1
        : cursor.clamp(0, rows.length - 1);
    // Nor on a row Return cannot take: "Already added", dimmed, with its
    // reason stranded at the bottom. Only when the position is ours to pick —
    // a row somebody arrowed to stays theirs.
    if (preferred == null && rows.isNotEmpty && !canSubmit(rows[cursor])) {
      final first = rows.indexWhere(canSubmit);
      if (first >= 0) cursor = first;
    }
    _selectedId = selected?.id;
    matchCount = rows.where((row) => !row.isCreate).length;
  }

  /// With nothing typed, the commands run lately lead, newest first; the rest
  /// keep their order. Once something is typed, the match decides.
  List<SwarmDestination> _recentFirst(List<SwarmDestination> ranked) {
    final recent = recentCommands?.call() ?? const <String>[];
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

  void setQuery(String value) {
    if (query == value) return;
    if (_quickAccessPrefix.hasMatch(value.trimLeft())) _groupScope = null;
    query = value;
    cursor = 0;
    _selectedId = null;
    _filter();
    notifyListeners();
  }

  bool back() {
    final scope = _groupScope;
    if (scope == null) return false;
    _groupScope = null;
    setQuery(scope.query);
    return true;
  }

  void move(int delta) {
    if (rows.isEmpty) return;
    cursor = (cursor + delta) % rows.length;
    _selectedId = selected!.id;
    notifyListeners();
  }

  /// Positive means down on screen, including in a bottom-up dock. At a dock
  /// edge, keep the selection still instead of jumping to the opposite end.
  void moveVisually(int direction) {
    if (!resultsFromBottom) {
      move(direction);
      return;
    }
    if (rows.isEmpty) return;
    final next = (cursor - direction).clamp(0, rows.length - 1);
    if (next != cursor) move(next - cursor);
  }

  SwarmSearchSelection? submit([SwarmDestination? row]) {
    final destination = row ?? selected;
    if (destination == null || !canSubmit(destination)) return null;
    if (isGroupMode && destination.isGroup) {
      final group = _catalog
          .where((row) => row.id == destination.id && row.isGroup)
          .firstOrNull;
      if (group != null) {
        _groupScope = (id: group.id, name: group.title, query: query);
        setQuery('');
      }
      return null;
    }
    if (destination.pickerQuery case final next?) {
      if (modes?.call().any(
            (mode) => mode.id == destination.id && mode.pickerQuery == next,
          ) ??
          false) {
        setQuery(next);
      }
      return null;
    }
    if (destination.isCommand &&
        !((isHelpMode ? modes : commands)?.call().any(
              (command) => command.id == destination.id,
            ) ??
            false)) {
      return null;
    }
    return SwarmSearchSelection(
      destination,
      adding ? SwarmSearchAction.addHere : SwarmSearchAction.open,
    );
  }

  bool canSubmit(SwarmDestination? row) => row?.pickerQuery != null
      ? isHelpMode && _commandIds.contains(row!.id)
      : isGroupMode && row?.isGroup == true
      ? _catalog.any((group) => group.id == row!.id && group.isGroup)
      : row != null && row.isCreate
      ? canCreate
      : row != null &&
            (!adding || row.isCommand || canAdd(row)) &&
            (!row.isCommand ||
                ((isCommandMode || isHelpMode) &&
                    _commandIds.contains(row.id))) &&
            (adding ||
                !row.isGroup ||
                canOpenSwarmGroup(app, row, destinationSwarmId: targetId)) &&
            (row.closedId == null || app.canReopenClosed(row.closedId!));

  int _missingCount(SwarmDestination row) => row.agentId != null
      ? (_presentIds.contains(row.id) ? 0 : 1)
      : row.members.where((id) => !_presentIds.contains(id)).length;

  bool _hasMissing(SwarmDestination row) => row.agentId != null
      ? !_presentIds.contains(row.id)
      : row.members.any((id) => !_presentIds.contains(id));

  bool alreadyHere(SwarmDestination row) =>
      adding && row.agentId != null && _presentIds.contains(row.id);

  bool canAdd(SwarmDestination? row) =>
      !navigating &&
      history == null &&
      row != null &&
      !row.isCommand &&
      row.closedId == null &&
      (placement == null || row.agentId != null) &&
      (placement != null && alreadyHere(row) ||
          _hasMissing(row) &&
              (split == null || row.agentId != null) &&
              (split == null || app.isPaneSplitCurrent(split!)) &&
              (placement == HarnessPlacement.newTab ||
                  app.swarms.any(
                    (swarm) =>
                        swarm.id == targetId &&
                        !swarm.isStore &&
                        !swarm.isOrchestrator &&
                        swarm.panes.length + _missingCount(row) <=
                            AppNotifier.maxPanes,
                  )));

  SwarmSearchSelection? addHere() => adding || isGroupMode || isHelpMode
      ? submit()
      : canAdd(selected)
      ? SwarmSearchSelection(selected!, SwarmSearchAction.addHere)
      : null;

  static String action(SwarmDestination row) => row.isCommand
      ? 'Run command'
      : row.closedId != null
      ? 'Reopen'
      : row.isSwarm && !row.isStore && row.members.length != 1
      ? 'Go to Tab'
      : 'Open Harness';

  @override
  void dispose() {
    app.removeListener(_refresh);
    projects?.removeListener(_refresh);
    app.sessionPreviews.removeListener(_previewChanged);
    _previewPage.dispose();
    _resultPage.dispose();
    super.dispose();
  }
}
