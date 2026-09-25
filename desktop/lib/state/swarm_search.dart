import 'package:flutter/foundation.dart';
import 'package:collection/collection.dart' show compareNatural;

import '../models/model_search_catalog.dart';
import '../core/dsh_catalog.dart';
import '../core/machine_resources.dart';

import 'app_state.dart';
import 'harness_placement.dart';
import 'pane_arrangement.dart';
import 'swarm_catalog.dart';
import 'swarm_navigation.dart';
import 'harness_sessions.dart';

const kSwarmSearchHint = 'Search harnesses';
const kHarnessPickerHint = kSwarmSearchHint;

const kSwarmCreateRowId = 'create:harness';

typedef SwarmGroupScope = ({
  String id,
  String name,
  String query,
  String? branch,
});

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
  final SwarmGroupScope? groupScope;
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
    this.models,
    this.adding = false,
    this.navigating = false,
    this.activityFirst = false,
    this.selectOnEmptyQuery = true,
    this.commandsOnly = false,
    this.offersCreate = false,
    this.offersHarnessCreate = true,
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
    models?.addListener(_modelsChanged);
    app.sessionPreviews.addListener(_previewChanged);
  }

  final AppNotifier app;
  final List<String> recent;
  final SwarmProjectStore? projects;
  final ModelSearchCatalog? models;
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

  /// Cmd-P starts without a choice; typing or navigating activates a result.
  final bool selectOnEmptyQuery;
  bool get setupLayout => activityFirst && !isCommandMode && !isHelpMode;
  final bool commandsOnly;
  SessionFilter sessionFilter = SessionFilter.all;
  SessionSort sessionSort = SessionSort.recent;
  final machineResources = <String, MachineResources>{};
  bool _disposed = false;
  int _resourcesRevision = 0;
  final _heldRows = <String, SwarmDestination>{};
  bool get hasPendingAction => _heldRows.isNotEmpty;

  /// Pausing the last harness may remove its tab. Keep the management action
  /// visible and make subsequent creation target the workspace that remains.
  void followRemainingWorkspace() {
    targetId = app.activeSwarmId;
    targetName = app.activeSwarm.name;
    _refresh(force: true);
  }

  void holdRow(SwarmDestination row) => _heldRows[row.id] = row;
  void releaseRow(String id) {
    if (_disposed) return;
    _heldRows.remove(id);
    _filter();
    notifyListeners();
  }

  /// Read a snapshot when Machines opens or Refresh is chosen, never while
  /// filtering or moving through its results.
  Future<void> refreshMachineResources() async {
    final revision = ++_resourcesRevision;
    final readings = await Future.wait(
      app.machineStates.values.map(
        (machine) async => (
          machine,
          await app.readMachineResources(machine.machine.machineId),
        ),
      ),
    );
    if (_disposed || revision != _resourcesRevision) return;
    machineResources.clear();
    for (final (machine, reading) in readings) {
      final id = machine.machine.machineId;
      if (reading != null && identical(machine, app.stateOf(id))) {
        machineResources[id] = reading;
      }
    }
    notifyListeners();
  }

  void setSessionFilter(SessionFilter filter) {
    sessionFilter = filter;
    _filter();
    notifyListeners();
  }

  void setSessionSort(SessionSort sort) {
    sessionSort = sort;
    _filter();
    notifyListeners();
  }

  /// Whether the list offers a creation row for its current resource type.
  final bool offersCreate;

  /// Cmd-P finds existing harnesses; splits can also offer a new harness.
  /// Machine, project, and model setup remain available in their own scopes.
  final bool offersHarnessCreate;

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
  static final _quickAccessPrefix = RegExp(r'^[>@#?:*]');
  bool get isMachineMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith('@');
  bool get isModelMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith(':');
  bool get isStoreMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith('*');
  bool get isGroupMode => isProjectMode || isMachineMode;
  String get scopePrefix => isMachineMode
      ? '@'
      : isProjectMode
      ? '#'
      : isModelMode
      ? ':'
      : isStoreMode
      ? '*'
      : isCommandMode
      ? '>'
      : isHelpMode
      ? '?'
      : '';
  String get prompt => scopePrefix.isEmpty ? '>' : scopePrefix;
  String get inputQuery =>
      isGroupMode || isModelMode || isStoreMode ? matchQuery : query;

  /// Prefix keystrokes change the prompt. The editable field holds only the
  /// search text, so clearing it does not silently change the selected type.
  void editQuery(String value) {
    if (RegExp(r'^[@#:*?]').hasMatch(value)) {
      setQuery(value);
    } else if (isCommandMode || isHelpMode) {
      setQuery(value);
    } else if (value.startsWith('>') && !isCommandMode) {
      setQuery(value.substring(1).trimLeft());
    } else {
      setQuery(scopePrefix.isEmpty ? value : '$scopePrefix$value');
    }
  }

  String get createLabel => isMachineMode
      ? 'New Machine'
      : isModelMode
      ? 'New Model'
      : 'New Harness';
  String get createDescription => isMachineMode
      ? 'Set up or link another computer.'
      : isModelMode
      ? 'Add a local model or connect an API.'
      : 'Choose a harness, machine, and project.';
  SwarmGroupScope? _groupScope;
  bool get canGoBack => _groupScope != null;
  String? get scopedBranch => _groupScope?.branch;

  /// Open a known resource by identity, never by a fuzzy display-name match.
  bool scopeToGroup(String id, {String? branch}) {
    final group = _catalog
        .where((row) => row.id == id && row.isGroup)
        .firstOrNull;
    if (group == null) return false;
    _groupScope = (
      id: group.id,
      name: group.title,
      query: group.isMachine ? '@' : '#',
      branch: branch,
    );
    query = '';
    sessionFilter = SessionFilter.all;
    cursor = 0;
    _selectedId = null;
    _filter();
    notifyListeners();
    return true;
  }

  String? get scopedMachineId => _groupScope == null
      ? null
      : _catalog
            .where((row) => row.id == _groupScope!.id)
            .firstOrNull
            ?.machineId;
  String get matchQuery => isCommandMode
      ? commandQuery
      : isHelpMode
      ? helpQuery
      : isGroupMode || isModelMode || isStoreMode
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
      : isModelMode
      ? 'Models'
      : isStoreMode
      ? 'Store'
      : _groupScope != null
      ? 'Harnesses · ${_groupScope!.name}${scopedBranch == null ? '' : ' ($scopedBranch)'}'
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
      _previewVisible &&
      (canPreview ||
          setupLayout ||
          isModelMode ||
          isStoreMode ||
          sessionFilter != SessionFilter.all) &&
      (selected?.isCreate != true ||
          setupLayout ||
          isModelMode ||
          isGroupMode ||
          sessionFilter != SessionFilter.all);

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
  final _previewLine = ValueNotifier<int>(0);
  ValueListenable<int> get previewLine => _previewLine;
  final _resultPage = ValueNotifier<int>(0);
  ValueListenable<int> get resultPage => _resultPage;
  void page(int pages) {
    if (hasPreview) {
      _previewPage.value += pages;
    } else {
      _resultPage.value += pages;
    }
  }

  void pageResults(int pages) => _resultPage.value += pages;

  void scrollPreview(int lines) {
    if (hasPreview) _previewLine.value += lines;
  }

  String targetId, targetName;
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

  SwarmDestination? get selected =>
      cursor < 0 || cursor >= rows.length ? null : rows[cursor];
  bool get _emptyFinder =>
      !selectOnEmptyQuery &&
      setupLayout &&
      !canGoBack &&
      sessionFilter == SessionFilter.all &&
      query.trim().isEmpty;
  bool get showsTypeHints => _emptyFinder && selected == null;
  String get hint => isCommandMode
      ? 'Search commands'
      : isHelpMode
      ? 'Search help'
      : _groupScope != null
      ? 'Search harnesses in ${_groupScope!.name}'
      : isProjectMode
      ? 'Search projects'
      : isMachineMode
      ? 'Search machines'
      : isModelMode
      ? 'Search models'
      : isStoreMode
      ? 'Search store'
      : history != null
      ? 'Search history'
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
        isGroupMode ||
        isModelMode ||
        isStoreMode) {
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
      !isProjectMode &&
      (offersHarnessCreate || isGroupMode || isModelMode) &&
      (_groupScope == null || scopedMachineId != null) &&
      (isGroupMode ||
          isModelMode ||
          sessionFilter != SessionFilter.needsInput) &&
      !isStoreMode &&
      (isGroupMode || isModelMode || canCreate);

  SwarmDestination? _createRow;
  SwarmDestination _createRowFor(String? name) {
    final title = createLabel;
    // The same object while the words are the same: live preview text
    // re-filters constantly and compares rows by identity.
    if (_createRow?.task == name && _createRow?.title == title) {
      return _createRow!;
    }
    return _createRow = SwarmDestination(
      id: isGroupMode || isModelMode
          ? 'create:$scopePrefix'
          : kSwarmCreateRowId,
      title: title,
      detail: name ?? createDescription,
      terminalDetail: createDescription,
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
      ? row!.title
      : row?.isModel == true
      ? models?.entries[row!.modelId]?.api != null
            ? 'Edit connection'
            : 'Open Model Manager'
      : row?.isStoreEntry == true
      ? 'Open in Store'
      : row?.pickerQuery != null
      ? 'Open'
      : isGroupMode && row?.isGroup == true
      ? 'Choose ${isProjectMode ? 'project' : 'machine'}'
      : row?.agentId != null &&
            app
                    .stateOf(row!.machineId!)
                    ?.agents
                    .any(
                      (agent) => agent.id == row.agentId && agent.isStopped,
                    ) ==
                true
      ? 'Resume & open'
      : sessionFilter == SessionFilter.needsInput && row?.agentId != null
      ? 'Answer'
      : placement != null && row != null && alreadyHere(row)
      ? 'Focus pane'
      : setupLayout && row?.agentId != null
      ? 'Open'
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
    final storeChanged = isStoreMode && _refreshStore();
    final next = navigating
        ? _locations.read(app, projects?.projects ?? const [])
        : history == null
        ? _cache.read(app, projects?.projects ?? const [], recent: recent)
        : [...history!.menuDestinations(app), ...closedWorkDestinations(app)];
    final splitCurrent = split == null || app.isPaneSplitCurrent(split!);
    if (!force &&
        sessionFilter == SessionFilter.all &&
        !storeChanged &&
        identical(next, _catalog) &&
        splitCurrent == _splitCurrent) {
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

  void _modelsChanged() {
    if (!isModelMode) return;
    _filter();
    notifyListeners();
  }

  Map<String, DshEntry> _storeEntries = {};
  Map<String, DshEntry> get storeEntries => _storeEntries;
  List<SwarmDestination> _storeDestinations = const [];

  bool _refreshStore() {
    final entries = {
      for (final machine in app.machineStates.values)
        for (final entry in machine.dsh.byId.values)
          if (!entry.isViewerPackage) entry.id: entry,
    };
    if (mapEquals(entries, _storeEntries)) return false;
    _storeEntries = entries;
    _storeDestinations = _storeRows();
    return true;
  }

  List<SwarmDestination> _storeRows() => [
    for (final entry in storeEntries.values)
      SwarmDestination(
        id: 'store-entry:${entry.id}',
        storeId: entry.id,
        title: entry.name,
        detail: entry.tagline ?? entry.description ?? entry.category ?? '',
        swarmId: null,
        current: false,
        searchFields: [
          entry.id,
          entry.description,
          entry.tagline,
          entry.category,
          entry.author,
        ],
      ),
  ];

  final _unavailableAttentionIds = <String>{};
  List<SwarmDestination> _attentionRows() {
    _unavailableAttentionIds.clear();
    final existing = {for (final row in _catalog) row.id: row};
    return [
      for (final session in harnessSessions(
        app,
      ).where((session) => session.needsInput))
        () {
          final original = existing[session.id];
          if (!session.canOpen) _unavailableAttentionIds.add(session.id);
          return SwarmDestination(
            id: session.id,
            title: session.agent.displayName,
            detail: '${session.status} · ${session.question!.prompt}',
            machineLabel: session.machine.machine.displayName,
            terminalDetail:
                '${session.status} · ${session.machine.machine.displayName}',
            promptContext: original?.promptContext,
            machineId: session.machineId,
            agentId: session.agent.id,
            engine: session.agent.identityEngine,
            swarmId: original?.swarmId,
            paneId: original?.paneId,
            previewKey: original?.previewKey,
            lastActivityAt: session.lastActiveAt,
            current: original?.current ?? false,
            searchFields: [
              ...?original?.fields,
              session.question!.prompt,
              session.machine.machine.displayName,
              session.status,
            ],
          );
        }(),
    ];
  }

  void _previewChanged() {
    if (matchQuery.trim().isEmpty ||
        isCommandMode ||
        isHelpMode ||
        isModelMode ||
        isStoreMode ||
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
        activityFirst &&
        !navigating &&
        !isCommandMode &&
        !isGroupMode &&
        !isModelMode &&
        !isStoreMode;
    _commandIds = {for (final command in availableCommands) command.id};
    final scopedMembers = _groupScope == null
        ? null
        : _catalog
                  .where((row) => row.id == _groupScope!.id)
                  .firstOrNull
                  ?.members ??
              <String>{};
    var candidates = isCommandMode
        ? availableCommands
        : isModelMode
        ? models?.rows ?? const <SwarmDestination>[]
        : isStoreMode
        ? _storeDestinations
        : byActivity && sessionFilter == SessionFilter.needsInput
        ? _attentionRows()
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
    if (scopedBranch case final branch?) {
      candidates = candidates.where((row) {
        final machine = app.stateOf(row.machineId ?? '');
        final agent = machine?.agents
            .where((agent) => agent.id == row.agentId)
            .firstOrNull;
        return agent != null && machine?.projectOf(agent)?.branch == branch;
      }).toList();
    }
    if (byActivity && _heldRows.isNotEmpty && scopedBranch == null) {
      final present = {for (final row in candidates) row.id};
      candidates = [
        ...candidates,
        ..._heldRows.values.where((row) => !present.contains(row.id)),
      ];
    }
    total = candidates.length;
    rows = isCommandMode
        ? _recentFirst(rankSwarmDestinations(availableCommands, commandQuery))
        : isModelMode && matchQuery.trim().isEmpty
        ? candidates
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
            recent: isProjectMode ? const [] : recent,
            previews: history == null ? app.sessionPreviews : null,
          );
    if (isProjectMode) {
      final open = {
        for (final pane in app.allPanes)
          if ((pane.agentId ?? pane.ownerAgentId) case final id?)
            agentDestinationId(pane.machineId, id),
      };
      rows.sort((a, b) {
        final aOpen = a.members.any(open.contains);
        final bOpen = b.members.any(open.contains);
        if (aOpen != bOpen) return aOpen ? -1 : 1;
        final name = compareNatural(
          a.title.toLowerCase(),
          b.title.toLowerCase(),
        );
        return name != 0 ? name : a.id.compareTo(b.id);
      });
    }
    if (byActivity &&
        sessionFilter != SessionFilter.needsInput &&
        (sessionFilter != SessionFilter.all ||
            sessionSort != SessionSort.recent)) {
      final sessions = [
        for (final destination in candidates)
          if (destination.agentId != null)
            for (final machine in [app.stateOf(destination.machineId!)])
              if (machine != null)
                for (final agent in machine.agents.where(
                  (agent) => agent.id == destination.agentId,
                ))
                  HarnessSession(
                    machine: machine,
                    agent: agent,
                    open: destination.hasView,
                    working: machine.processingAgentIds.contains(agent.id),
                    question: machine.blockedAgents[agent.id],
                  ),
      ];
      final visible = visibleHarnessSessions(
        sessions,
        filter: sessionFilter,
        sort: sessionSort,
        recent: recent,
      );
      final ranks = {for (var i = 0; i < visible.length; i++) visible[i].id: i};
      rows = rows.where((row) => ranks.containsKey(row.id)).toList();
      if (sessionSort != SessionSort.recent) {
        rows.sort((a, b) => ranks[a.id]!.compareTo(ranks[b.id]!));
      }
    }
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
      final create = _showsCreateRow && scopedBranch == null
          ? _createRowFor(createTask)
          : null;
      final found = [
        for (final row in rows)
          if (!row.isCreate) row,
      ];
      // When creation is available, keep its row outside the result order.
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
    final waitingForSelection = _emptyFinder && _selectedId == null;
    cursor = waitingForSelection
        ? -1
        : rows.isEmpty
        ? 0
        : index >= 0
        ? index
        // New Tab, New Pane and directional splits start on creation with an
        // empty query. Other searches and typed queries prefer a match.
        : preferred == null &&
              rows.length > 1 &&
              rows.first.isCreate &&
              ((placement == null && split == null) ||
                  !selectOnEmptyQuery ||
                  matchQuery.trim().isNotEmpty)
        ? 1
        : cursor.clamp(0, rows.length - 1);
    // Nor on a row Return cannot take: "Already added", dimmed, with its
    // reason stranded at the bottom. Only when the position is ours to pick —
    // a row somebody arrowed to stays theirs.
    if (preferred == null &&
        cursor >= 0 &&
        rows.isNotEmpty &&
        !canSubmit(rows[cursor])) {
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
    if (isStoreMode) _refreshStore();
    cursor = 0;
    _selectedId = null;
    _filter();
    notifyListeners();
  }

  bool back() {
    final scope = _groupScope;
    if (scope == null) return false;
    if (scope.branch != null) return scopeToGroup(scope.id);
    _groupScope = null;
    setQuery(scope.query);
    return true;
  }

  void move(int delta) {
    if (rows.isEmpty) return;
    cursor = ((cursor < 0 && delta < 0 ? 0 : cursor) + delta) % rows.length;
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
        _groupScope = (
          id: group.id,
          name: group.title,
          query: query,
          branch: null,
        );
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

  bool canSubmit(SwarmDestination? row) =>
      sessionFilter == SessionFilter.needsInput &&
          _unavailableAttentionIds.contains(row?.id)
      ? false
      : row?.pickerQuery != null
      ? isHelpMode && _commandIds.contains(row!.id)
      : row?.isModel == true
      ? isModelMode && models?.entries.containsKey(row!.modelId) == true
      : row?.isStoreEntry == true
      ? isStoreMode && storeEntries.containsKey(row!.storeId)
      : isGroupMode && row?.isGroup == true
      ? _catalog.any((group) => group.id == row!.id && group.isGroup)
      : row != null && row.isCreate
      ? _showsCreateRow && (isMachineMode || isModelMode || canCreate)
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
      !row.isModel &&
      !row.isStoreEntry &&
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
      : row.isCreate
      ? row.title
      : row.isModel
      ? 'Show model actions'
      : row.isStoreEntry
      ? 'Open in Store'
      : row.closedId != null
      ? 'Reopen'
      : row.isSwarm && !row.isStore && row.members.length != 1
      ? 'Go to Tab'
      : 'Open Harness';

  @override
  void dispose() {
    _disposed = true;
    app.removeListener(_refresh);
    projects?.removeListener(_refresh);
    models?.removeListener(_modelsChanged);
    app.sessionPreviews.removeListener(_previewChanged);
    _previewPage.dispose();
    _previewLine.dispose();
    _resultPage.dispose();
    super.dispose();
  }
}
