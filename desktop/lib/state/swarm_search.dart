import '../widgets/engine_identity.dart';

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:collection/collection.dart' show compareNatural;

import '../models/api_connections_controller.dart'
    show ApiConnection, ApiModel, agentOnApiModel;
import '../models/local_model.dart';
import '../models/model_search_catalog.dart';
import '../models/coding_model.dart';
import '../models/swarm_models_target.dart';
import '../usage/models_menu_controller.dart' show subscriptionSearchId;
import '../core/dsh_catalog.dart';
import '../store/experimental_harnesses.dart';
import '../core/machine_resources.dart';
import '../core/models.dart'
    show Agent, ConnectionStatus, GridModels, GridModel;
import '../core/relative_time.dart';

import 'account_devices.dart' show AccountDevice;
import 'app_state.dart';
import 'agent_switch_handoff.dart';
import 'harness_placement.dart';
import 'pane_arrangement.dart';
import 'swarm_catalog.dart';
import 'swarm_navigation.dart';
import 'harness_sessions.dart';
import 'machine_devices.dart';
import 'search_when.dart';
import 'session_content_search.dart';

const kSwarmSearchHint = 'Search harnesses';
const kHarnessPickerHint = kSwarmSearchHint;

const kSwarmCreateRowId = 'create:harness';

/// A session picker can choose a contribution without opening a native pane.
/// The caller owns that purpose and revalidates its authority on submission.
class HarnessPickerContext {
  const HarnessPickerContext({
    required this.title,
    required this.description,
    required this.action,
    required this.unavailable,
  });
  final String title, description, action;
  final String? Function(SwarmDestination) unavailable;
}

/// The Machines picker's two runs of rows: the account's computers, then its phones and apps.
enum MachineSearchSection {
  computers('Computers'),
  phones('Phones & apps');

  const MachineSearchSection(this.label);
  final String label;
}

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
    this.noteFor,
    this.additionalDestinations = const [],
    this.swarmModels,
    this.harnessContext,
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
    if (activityFirst &&
        history == null &&
        !navigating &&
        harnessContext == null) {
      _content = SessionContentSearch(
        machines: () => app.searchableMachineIds,
        ask: (machineId, words, when) =>
            app.searchSessions(machineId, words, when: when),
      )..addListener(_contentChanged);
    }
    _refresh();
    app.addListener(_refresh);
    app.experimentalFeatures.addListener(_refresh);
    projects?.addListener(_refresh);
    models?.addListener(_modelsChanged);
    app.gridPictures.addListener(_modelChoicesChanged);
    app.sessionPreviews.addListener(_previewChanged);
  }

  final AppNotifier app;
  final List<String> recent;

  /// A line the box answers a query with, shown as the first row and never
  /// taken by Return (the daemons' easter words: `xyzzy`).
  final String? Function(String query)? noteFor;
  final List<SwarmDestination> additionalDestinations;
  final HarnessPickerContext? harnessContext;
  final SwarmProjectStore? projects;
  final ModelSearchCatalog? models;

  /// Set when these Models are a Swarm's Local models ([SwarmModelsTarget]): no Subscriptions, and a model's action
  /// puts it on the Swarm's grid ([swarmModelAction]) rather than starting a harness on it.
  final SwarmModelsTarget? swarmModels;
  bool modelDownloadsVisible = false;
  bool isModelDownloadsRow(SwarmDestination? row) =>
      isModelMode && row?.id == 'model:downloads';

  /// Grid is not set up on this machine, so local and shared models are one row offering to set it
  /// up — Grid is an add-on, set up the first time a person asks for it, never by opening a picker.
  bool get gridSetupOffered {
    final manager = models?.manager;
    return manager != null &&
        (manager.gridSetupNeeded || manager.settingUpGrid);
  }

  /// The row that sets Grid up ([gridSetupOffered]).
  bool isGridSetupRow(SwarmDestination? row) =>
      isModelMode && row?.id == gridSetupRowId;

  static const gridSetupRowId = 'model:grid-setup';

  late final _gridSetupRow = SwarmDestination(
    id: gridSetupRowId,
    modelId: gridSetupRowId,
    title: '[ Set up local & shared models ]',
    detail: '',
    swarmId: null,
    current: false,
  );

  /// Saved APIs whose models are shown under them. An API such as OpenRouter lists hundreds, so
  /// they stay folded until Enter on the API's row — or a search that matches them.
  final expandedApis = <String>{};

  /// [row] is a saved API's own row (not one of its models).
  bool isApiRow(SwarmDestination? row) {
    final entry = models?.entries[row?.modelId];
    return entry?.api != null && entry?.apiModel == null;
  }

  /// [row] is one of a saved API's models, listed under the API's row.
  bool isApiModelRow(SwarmDestination? row) =>
      models?.entries[row?.modelId]?.apiModel != null;

  /// Whether [row]'s API has its models shown under it, and the words at the end of its row: how
  /// many models it lists, or that it is for tools. Null for any other row.
  ({bool open, String hint})? apiRowState(SwarmDestination? row) {
    if (!isModelMode || !isApiRow(row)) return null;
    final api = models!.entries[row!.modelId]!.api!;
    final listed = models!.manager.apis.models[api.id];
    final count = listed?.models.length ?? 0;
    return (
      // Open while any of its models is listed under it: unfolded, or found by a search.
      open: rows.any(
        (shown) =>
            models!.entries[shown.modelId]?.apiModel != null &&
            models!.entries[shown.modelId]!.api!.id == api.id,
      ),
      hint: !api.servesModels
          ? 'Tools'
          : listed?.loading == true && count == 0
          ? 'Loading…'
          : count > 0
          ? '$count ${count == 1 ? 'model' : 'models'}'
          : 'Tools',
    );
  }

  /// Enter on [row] shows or hides its API's models: it lists some, or is still reading them.
  bool canExpandApi(SwarmDestination? row) {
    if (!isModelMode || !isApiRow(row)) return false;
    final api = models!.entries[row!.modelId]!.api!;
    final listed = models!.manager.apis.models[api.id];
    return api.servesModels &&
        listed != null &&
        (listed.models.isNotEmpty || listed.loading);
  }

  /// The API model [row] offers the focused harness, or null when it cannot run on it: only a
  /// harness on the machine the APIs are saved on (this computer, in the desktop app), where the
  /// key is kept, on an engine that can be re-pointed.
  ({ApiConnection api, ApiModel model})? selectableApiModel(
    SwarmDestination? row,
  ) {
    if (!isModelMode || modelSelectionEngine == null) return null;
    final entry = models?.entries[row?.modelId];
    final api = entry?.api, model = entry?.apiModel;
    if (api == null || model == null || !api.servesModels) return null;
    if (_modelChoices?.canRunLocally(modelSelectionEngine) == false) {
      return null;
    }
    final machine = app.stateOf(_modelSelectionMachineId ?? '');
    if (machine == null ||
        machine.machine.machineId != models!.manager.apis.machineId ||
        machine.connectionStatus != ConnectionStatus.connected) {
      return null;
    }
    return (api: api, model: model);
  }

  /// How many catalog models the list shows before "More models" is pressed.
  static const shownDownloads = 5;

  /// Catalog models this list could show: the ones past [shownDownloads] are behind the row below.
  int _downloadCount = 0;

  /// The row under the downloads that shows the rest of the catalog, or folds it away again.
  SwarmDestination get _downloadsRow => SwarmDestination(
    id: 'model:downloads',
    modelId: 'model:downloads',
    title: modelDownloadsVisible
        ? '[ Show fewer ]'
        : '[ More models (${_downloadCount - shownDownloads}) ]',
    detail: '',
    swarmId: null,
    current: false,
  );

  ModelSearchSection modelSection(SwarmDestination row) => row.isCreate
      ? ModelSearchSection.apis
      : isGridSetupRow(row)
      ? ModelSearchSection.local
      : isModelDownloadsRow(row)
      ? ModelSearchSection.catalog
      : models?.entries[row.modelId]?.section ?? ModelSearchSection.local;

  /// Whether a search should still show the Set up row: always with nothing typed, and for words that
  /// ask for what it unlocks.
  bool _offersGridSetupFor(String query) {
    final words = query.trim().toLowerCase();
    if (words.isEmpty) return true;
    return const [
      'set up',
      'setup',
      'local',
      'shared',
      'grid',
      'download',
    ].any((word) => word.contains(words) || words.contains(word));
  }

  /// A section's heading in the list. The downloads name the machine they are for.
  String modelSectionLabel(ModelSearchSection section) =>
      section == ModelSearchSection.catalog && models != null
      ? models!.catalogHeading
      : section.label;

  String? modelRowAction(SwarmDestination row) {
    final entry = models?.entries[row.modelId];
    if (entry == null) return null;
    return canSelectModel(row)
        ? 'Use'
        : canGetModel(row)
        ? 'Get'
        : null;
  }

  /// The word at the end of a model row. A row of yours says what Enter does on it — Use, Get —
  /// unless something is happening to it (Downloading, Starting) or the harness is already on it
  /// (In use); only a row with no action says its state. Operation words come from the catalogue's
  /// [ModelSearchCatalog.localStatusWord], which the preview's status also reads.
  String? modelRowStatus(SwarmDestination row) {
    if (isGridSetupRow(row)) {
      final manager = models!.manager;
      return manager.settingUpGrid
          ? 'Setting up…'
          : manager.setUpWaitsForSignIn
          ? 'Signing in…'
          : null;
    }
    final catalog = models;
    final entry = catalog?.entries[row.modelId];
    if (entry == null || catalog == null) return null;
    // A Swarm's Local models say what each row is to the Swarm.
    if (swarmModels case final swarm?) {
      final local = entry.local;
      final owner = entry.controller ?? catalog.manager;
      if (local != null &&
          (owner.operationFor(local)?.active == true ||
              owner.pendingId == local.id)) {
        return catalog.localStatusWord(local, controller: owner);
      }
      if (local?.servedOn(swarm.grid) == true) return 'In Swarm';
      if (entry.apiModel case final model?) {
        return swarm.shared(entry.api!.id, model.id) ? 'Shared' : null;
      }
      if (entry.gridModel case GridModel(:final id, grid: final sharedGrid?)
          when local == null) {
        return swarm.offered(sharedGrid, id) ? 'Offered' : null;
      }
    }
    if (modelRowInUse(row)) return inUseWord;
    // An API's model says what Enter does on it — Use, when this pane can run on it, else nothing.
    // Its entry's status is only the API's name, which the row it sits under already shows.
    if (entry.apiModel != null) return modelRowAction(row);
    final local = entry.local;
    // A subscription says how much of it is left — the one figure worth a glance; Enter on it is
    // the preview's to say. Other rows with no weights here say what Enter does.
    if (entry.subscription != null) return entry.status;
    if (local == null) return modelRowAction(row) ?? entry.status;
    final owner = entry.controller ?? catalog.manager;
    final operation = owner.operationFor(local);
    if (operation?.active == true ||
        owner.pendingId == local.id ||
        operation?.failed == true) {
      return catalog.localStatusWord(local, controller: owner);
    }
    // Use under way: running is not yet the harness on it. Until it moves, the row keeps saying so —
    // a row that turned to Use there read as a second click to make.
    if (usingModelId == row.modelId) {
      return local.downloaded ? 'Starting' : 'Downloading';
    }
    return modelRowAction(row) ??
        (local.running
            ? 'Running'
            : local.downloaded
            ? 'Downloaded'
            : null);
  }

  static const inUseWord = '● In use';

  /// A model row's title on the desktop list: the two action rows named for what they do, without
  /// the terminal list's brackets; every other row as it is.
  String modelRowTitle(SwarmDestination row) {
    if (isGridSetupRow(row)) return 'Set up local & shared models';
    if (isModelDownloadsRow(row)) {
      return modelDownloadsVisible
          ? 'Show fewer'
          : 'More models (${_downloadCount - shownDownloads})';
    }
    return row.title;
  }

  /// The end of the model's name in a row titled `gemma-4-31B-it · video-editor-tom` — a shared
  /// model with the machine serving it, which is drawn on a second line under the name. Null for a
  /// row that names no machine.
  int? modelRowNameEnd(SwarmDestination row) {
    final entry = models?.entries[row.modelId];
    final machine = entry?.sharedBy;
    if (entry == null || machine == null || machine.isEmpty) return null;
    return row.title == '${entry.name}$modelMachineSeparator$machine'
        ? entry.name.length
        : null;
  }

  /// Whether the harness this picker chooses for is on [row]'s model now: the grid model the
  /// daemon read off its process, or a saved API's model at that API's address.
  bool modelRowInUse(SwarmDestination row) {
    final entry = models?.entries[row.modelId];
    final agent = _modelSelectionAgent;
    if (entry == null || agent == null) return false;
    if (entry.apiModel case final model?) {
      return agentOnApiModel(agent, entry.api!, model.id);
    }
    final current = agent.gridModel?.toLowerCase();
    return current != null &&
        entry.gridModel?.id.toLowerCase() == current &&
        (entry.local?.running ?? true);
  }

  /// Whether the model row is live right now: running, in use, or a download, start or stop under
  /// way. Only a live row's word is green.
  bool modelRowLive(SwarmDestination row) {
    if (isGridSetupRow(row)) {
      final manager = models!.manager;
      return manager.settingUpGrid || manager.setUpWaitsForSignIn;
    }
    final catalog = models;
    final entry = catalog?.entries[row.modelId];
    if (entry == null || catalog == null) return false;
    if (modelRowInUse(row)) return true;
    final local = entry.local;
    if (local == null) return false;
    final owner = entry.controller ?? catalog.manager;
    return owner.operationFor(local)?.active == true ||
        owner.pendingId == local.id ||
        local.running;
  }

  /// A model of yours that could not be started or downloaded: its row's word is a warning.
  bool modelRowFailed(SwarmDestination row) {
    final catalog = models;
    final local = catalog?.entries[row.modelId]?.local;
    if (catalog == null || local == null) return false;
    final owner = catalog.entries[row.modelId]!.controller ?? catalog.manager;
    return owner.operationFor(local)?.failed == true;
  }

  /// What sets one model of yours apart from the next, in two aligned columns ahead of the row's
  /// word: its size, and its speed — measured while it runs, else the catalog's estimate for this
  /// machine (`~`), else the app it came from (`Ollama`). Null for any other row. Widths are fixed
  /// so every row's columns line up.
  String? modelRowFacts(SwarmDestination row) {
    final local = models?.entries[row.modelId]?.local;
    if (local == null) return null;
    final size = local.sizeBytes == null
        ? ''
        : gigabytesLabel(local.sizeBytes!);
    final measured = local.running ? local.tokensPerSecond : null;
    final speed = measured != null
        ? '${measured.round()} tok/s'
        : local.estTokS != null
        ? '~${local.estTokS!.round()} tok/s'
        : local.app ?? '';
    return '${size.padLeft(6)}  ${speed.padLeft(9)}';
  }

  /// A download, folded under "More models" past the first few.
  bool _foldedDownload(SwarmDestination row) =>
      models?.entries[row.modelId]?.needsDownload == true;

  bool canGetModel(SwarmDestination? row) {
    if (!isModelMode) return false;
    final entry = models?.entries[row?.modelId];
    final owner = entry?.controller;
    return entry?.needsDownload == true &&
        entry?.local?.canStart == true &&
        owner != null &&
        owner.inventoryAvailable &&
        !owner.busy &&
        owner.machine?.connectionStatus == ConnectionStatus.connected &&
        owner.machine?.needsLink == false &&
        (owner.targetMachineId == null || owner.machine?.isOffline == false);
  }

  /// What a model row does in a Swarm's Local models ([swarmModels]): a model of this person's machines runs for the
  /// Swarm or stops (Get first, when it is not downloaded); an API's model is shared with the Swarm or no longer. Null
  /// outside a Swarm, and for a row with nothing to do: an API's own row (it opens its models), a model shared with the
  /// person (agents on their machines use it as it is), a download under way (the preview's Cancel).
  ({String label, String command, Future<String?> Function()? run})?
  swarmModelAction(SwarmDestination? row) {
    final action = _swarmModelAction(row);
    final swarm = swarmModels;
    // Before the Swarm's models are set up, the owner's first share or run sets them up, then does it; a download needs
    // nothing of the Swarm. Anyone else waits for the owner (the preview says so).
    if (action == null ||
        swarm == null ||
        !swarm.setupNeeded ||
        action.command == 'picker.model_download') {
      return action;
    }
    final run = action.run;
    return (
      label: swarm.settingUp ? 'Setting up…' : action.label,
      command: action.command,
      run: run == null || !swarm.canSetUp || swarm.settingUp
          ? null
          : () async {
              final error = await swarm.whenSetUp(run);
              // A set up that failed is said in the preview, once; what the share or run itself answered is said here.
              return swarm.setupNeeded ? null : error;
            },
    );
  }

  ({String label, String command, Future<String?> Function()? run})?
  _swarmModelAction(SwarmDestination? row) {
    final swarm = swarmModels;
    final entry = models?.entries[row?.modelId];
    if (swarm == null || entry == null) return null;
    if (entry.local case final local?) {
      final owner = entry.controller ?? models!.manager;
      if (owner.downloading(local)) return null;
      final ready =
          !owner.busy &&
          owner.inventoryAvailable &&
          owner.machine?.connectionStatus == ConnectionStatus.connected &&
          owner.machine?.needsLink == false &&
          (owner.targetMachineId == null || owner.machine?.isOffline == false);
      // The Swarm's grid is read when the action runs: a first run sets the Swarm's models up, and names it then.
      Future<String?> Function() act(String action, {bool forSwarm = false}) =>
          () async {
            await owner.control(
              local,
              action,
              grid: forSwarm ? swarm.grid : null,
            );
            return owner.error;
          };
      if (local.servedOn(swarm.grid)) {
        return (
          label: 'Stop for Swarm',
          command: 'picker.model_stop',
          run: ready ? act('stop', forSwarm: true) : null,
        );
      }
      // Too small or too slow to drive a coding agent: no Builder would be offered it, so neither Get nor Run is
      // (coding_model.dart; the preview says why).
      final capable = codingRefusal(local) == null;
      if (!local.downloaded && !local.canStop) {
        return (
          label: 'Get',
          command: 'picker.model_download',
          run: ready && capable && local.canStart && owner.supportsDownload
              ? act('download')
              : null,
        );
      }
      return (
        label: 'Run for Swarm',
        command: 'picker.model_start',
        run: ready && capable && local.canStart
            ? act('start', forSwarm: true)
            : null,
      );
    }
    if (entry.apiModel case final model?) {
      final api = entry.api!;
      final on = swarm.shared(api.id, model.id);
      return (
        label: on ? 'Stop sharing' : 'Share with Swarm',
        command: 'picker.accept',
        run: () => swarm.share(api.id, model.id, start: !on),
      );
    }
    // A model shared with the person, on someone else's grid: offering it lets the Lead start Builders on their
    // machines on it (owner, 2026-10-23: a choice, as running a model or sharing an API is).
    if (entry.gridModel case GridModel(:final id, grid: final sharedGrid?)
        when entry.api == null) {
      final on = swarm.offered(sharedGrid, id);
      return (
        label: on ? 'Stop offering' : 'Offer to Swarm',
        command: 'picker.accept',
        run: () => swarm.offer(sharedGrid, id, start: !on),
      );
    }
    return null;
  }

  Future<String?> getModel(SwarmDestination row) async {
    if (!canGetModel(row)) return null;
    final entry = models!.entries[row.modelId]!;
    final owner = entry.controller!;
    await owner.control(
      entry.local!,
      owner.supportsDownload ? 'download' : 'start',
    );
    return owner.error;
  }

  String? modelUseReason(SwarmDestination? row) {
    final entry = models?.entries[row?.modelId];
    if (entry == null || canSelectModel(row)) return null;
    if (modelSelectionEngine == null) return 'No active harness';
    if (entry.subscription case final subscription?) {
      if (subscription['engine'] != modelSelectionEngine) {
        return subscription['engine'] == 'claude'
            ? 'Claude only'
            : 'Codex only';
      }
      if (subscription['status'] == 'Not signed in') return 'Not signed in';
      return 'Other account';
    }
    if (entry.apiModel != null) {
      final machine = app.stateOf(_modelSelectionMachineId ?? '');
      if (machine != null &&
          machine.machine.machineId != models!.manager.apis.machineId) {
        return 'Other machine';
      }
      return 'Not available to this harness';
    }
    if (entry.api != null) return canExpandApi(row) ? null : 'Tools only';
    if (entry.gridModel?.unavailable != null) return 'Offline';
    if (entry.needsDownload) return 'Download first';
    if (entry.local case final local?) {
      final owner = entry.controller!;
      if (owner.operationFor(local)?.active == true) return entry.status;
      if (owner.machine?.isOffline == true ||
          owner.machine?.connectionStatus != ConnectionStatus.connected ||
          owner.machine?.needsLink == true) {
        return 'Connect host';
      }
      if (!local.running && !local.canStart && local.canStop) {
        return 'Not serving';
      }
      if (owner.busy) return 'Host busy';
    }
    return 'Not available to this harness';
  }

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

  final _activity = <String, DateTime?>{};

  /// A row's last activity as it was when this opening first listed it. The
  /// list keeps its activity snapshot and order while agents work on:
  /// rows moving under the cursor as someone arrowed through them was the
  /// confusing part. The next opening reads activity afresh.
  DateTime? activityOf(SwarmDestination row) =>
      _activity.putIfAbsent(row.id, () => row.lastActivityAt);

  /// Cmd-P starts without a choice; typing or navigating activates a result.
  final bool selectOnEmptyQuery;
  // Prefixes change the catalog, never the Cmd-P dialog's layout.
  bool get setupLayout => activityFirst;
  bool managing = false;
  String? modelSelectionEngine;
  String? _modelSelectionMachineId;
  String? _modelSelectionAgentId;
  GridModels? _modelChoices;

  /// The harness this picker chooses a model for, as the app knows it now.
  Agent? get _modelSelectionAgent {
    final id = _modelSelectionAgentId;
    if (id == null) return null;
    return app
        .stateOf(_modelSelectionMachineId ?? '')
        ?.agents
        .where((agent) => agent.id == id)
        .firstOrNull;
  }

  String? usingModelId;
  String? modelUseErrorId, modelUseError;
  Timer? _modelUseTimer;
  Completer<void>? _modelUseWait;

  void setModelSelection(
    String? engine,
    GridModels? choices, {
    String? machineId,
    String? agentId,
  }) {
    modelSelectionEngine = engine;
    _modelSelectionMachineId = machineId;
    _modelSelectionAgentId = engine == null ? null : agentId;
    _modelChoices = choices;
    notifyListeners();
  }

  void _modelChoicesChanged() {
    if (_disposed || _modelSelectionMachineId == null) return;
    final choices = app.gridPictures[_modelSelectionMachineId!];
    if (choices == null || identical(choices, _modelChoices)) return;
    _modelChoices = choices;
    notifyListeners();
  }

  GridModel? selectableGridModel(SwarmDestination? row) {
    if (!isModelMode ||
        modelSelectionEngine == null ||
        _modelChoices?.canRunLocally(modelSelectionEngine) != true) {
      return null;
    }
    final entry = models?.entries[row?.modelId];
    if (entry?.local case final local?) {
      if (!local.running ||
          entry!.controller?.operationFor(local)?.active == true) {
        return null;
      }
    }
    final offered = entry?.gridModel;
    if (offered == null || offered.unavailable != null) return null;
    for (final section in _modelChoices!.sections) {
      if (section.name != offered.grid && !(section.own && entry!.own)) {
        continue;
      }
      for (final candidate in section.models) {
        if (candidate.id.toLowerCase() == offered.id.toLowerCase() &&
            candidate.unavailable == null) {
          return GridModel(
            id: candidate.id,
            node: candidate.node,
            grid: section.name,
            unavailable: candidate.unavailable,
          );
        }
      }
    }
    return null;
  }

  bool canSelectModel(SwarmDestination? row) {
    if (!isModelMode || modelSelectionEngine == null || row?.isModel != true) {
      return false;
    }
    final entry = models?.entries[row!.modelId];
    final subscription = entry?.subscription;
    if (subscription != null) {
      final machine = app.stateOf(_modelSelectionMachineId ?? '');
      if (machine == null || subscription['engine'] != modelSelectionEngine) {
        return false;
      }
      final available = models!.subscriptions.subscriptionFor(
        modelSelectionEngine!,
        local: machine.isLocalMachine,
        machineName: machine.machine.displayName,
      );
      return available != null &&
          available['status'] != 'Not signed in' &&
          subscriptionSearchId(available) == subscriptionSearchId(subscription);
    }
    return selectableGridModel(row) != null ||
        selectableApiModel(row) != null ||
        canStartModelForUse(row);
  }

  bool canStartModelForUse(SwarmDestination? row) {
    if (!isModelMode ||
        modelSelectionEngine == null ||
        _modelChoices?.reachable != true ||
        _modelChoices?.canRunLocally(modelSelectionEngine) != true) {
      return false;
    }
    final entry = models?.entries[row?.modelId];
    final owner = entry?.controller;
    final model = entry?.local;
    return model != null &&
        owner != null &&
        entry!.own &&
        model.downloaded &&
        !model.running &&
        model.canStart &&
        owner.inventoryAvailable &&
        !owner.busy &&
        owner.machine?.connectionStatus == ConnectionStatus.connected &&
        owner.machine?.needsLink == false &&
        owner.machine?.isOffline == false;
  }

  /// Explicit Enter on installed weights starts once, then waits for the host
  /// and the pane's serving picture before selecting. Closing the picker only
  /// cancels the pending switch; the daemon continues its start operation.
  Future<GridModel?> startModelForUse(
    SwarmDestination row, {
    required bool Function() stillCurrent,
    Duration timeout = const Duration(minutes: 3),
  }) async {
    if (usingModelId != null || !canStartModelForUse(row)) return null;
    return _useModel(
      row,
      stillCurrent: stillCurrent,
      timeout: timeout,
      download: false,
    );
  }

  /// Whether Get on [row] can go on to put the picker's harness on the model: a download of yours,
  /// chosen for a harness that can run on a local model. Otherwise Get only downloads. Another model
  /// running on that machine is stopped first ([otherRunningModel]): it runs one at a time.
  bool canGetModelForUse(SwarmDestination? row) =>
      canGetModel(row) &&
      modelSelectionEngine != null &&
      _modelChoices?.reachable == true &&
      _modelChoices?.canRunLocally(modelSelectionEngine) == true &&
      models!.entries[row!.modelId]!.own;

  /// Another model of yours running on [row]'s machine — the one to stop before [row]'s can run.
  LocalModel? otherRunningModel(SwarmDestination? row) {
    final entry = models?.entries[row?.modelId];
    final local = entry?.local, owner = entry?.controller;
    if (local == null || owner == null) return null;
    return owner.localModels
        .where((model) => model.canStop && model.id != local.id)
        .firstOrNull;
  }

  /// Get, then Use, in one step: downloads [row]'s model, starts it, and answers the grid model the
  /// harness can be switched to. The daemon owns the download, so closing the picker stops only
  /// the waiting and the switch — the download goes on, and the row says so.
  Future<GridModel?> getModelForUse(
    SwarmDestination row, {
    required bool Function() stillCurrent,
    Duration timeout = const Duration(minutes: 3),
  }) async {
    if (usingModelId != null || !canGetModelForUse(row)) return null;
    return _useModel(
      row,
      stillCurrent: stillCurrent,
      timeout: timeout,
      download: true,
    );
  }

  /// The model Use or Get is stopping to make room — its machine runs one local model at a time.
  String? stoppingOther;

  /// What the picker is doing for Use or Get, for its hint: `Downloading 42%…`, `Starting…`.
  String? get usingLabel {
    final entry = models?.entries[usingModelId];
    final local = entry?.local;
    if (usingModelId == null) return null;
    if (stoppingOther case final other?) return 'Stopping $other…';
    if (entry == null || local == null) return 'Starting…';
    final owner = entry.controller ?? models!.manager;
    final operation = owner.operationFor(local);
    if (operation?.active == true && operation!.stage == 'downloading') {
      final progress = operation.progress;
      return 'Downloading${progress == null ? '' : ' ${(progress * 100).floor()}%'}…';
    }
    return local.downloaded || owner.pendingStart
        ? 'Starting…'
        : 'Downloading…';
  }

  Future<void> _modelUsePause() async {
    _modelUseWait = Completer<void>();
    _modelUseTimer = Timer(const Duration(seconds: 2), () {
      if (_modelUseWait?.isCompleted == false) _modelUseWait!.complete();
    });
    await _modelUseWait!.future;
    _modelUseWait = null;
    _modelUseTimer = null;
  }

  Future<GridModel?> _useModel(
    SwarmDestination row, {
    required bool Function() stillCurrent,
    required Duration timeout,
    required bool download,
  }) async {
    final entry = models!.entries[row.modelId]!;
    final owner = entry.controller!;
    final modelId = entry.local!.id;
    final host = owner.machine;
    usingModelId = row.modelId;
    modelUseErrorId = modelUseError = null;
    notifyListeners();
    bool current() =>
        !_disposed && stillCurrent() && identical(owner.machine, host);
    void fail(String message) {
      modelUseErrorId = row.modelId;
      modelUseError = message;
    }

    bool hostGone() =>
        host?.connectionStatus != ConnectionStatus.connected ||
        host?.needsLink == true ||
        host?.isOffline == true;
    LocalModel? model() =>
        owner.localModels.where((model) => model.id == modelId).firstOrNull;

    /// The model running on that machine besides this one, stopped and gone before this one starts:
    /// the machine runs one local model at a time, and Use is a switch, not two steps to make.
    Future<bool> stopOther() async {
      final other = otherRunningModel(row);
      if (other == null) return true;
      stoppingOther = other.name;
      notifyListeners();
      try {
        await owner.control(other, 'stop');
        final deadline = DateTime.now().add(timeout);
        while (current()) {
          if (hostGone()) {
            fail('Reconnect to ${entry.node} to use this model.');
            return false;
          }
          final now = owner.localModels
              .where((model) => model.id == other.id)
              .firstOrNull;
          final operation = now == null ? null : owner.operationFor(now);
          if (operation?.failed == true ||
              (owner.error != null && !owner.busy)) {
            fail(
              operation?.error ??
                  owner.error ??
                  'Could not stop ${other.name}. Try again.',
            );
            return false;
          }
          if (now?.canStop != true &&
              operation?.active != true &&
              !owner.busy) {
            return true;
          }
          if (DateTime.now().isAfter(deadline)) {
            fail('${other.name} is still stopping. Try again in a moment.');
            return false;
          }
          await _modelUsePause();
          if (!current()) return false;
          await owner.refresh();
        }
        return false;
      } finally {
        stoppingOther = null;
        if (!_disposed) notifyListeners();
      }
    }

    try {
      if (download) {
        await owner.control(
          entry.local!,
          owner.supportsDownload ? 'download' : 'start',
        );
        // A download takes as long as it takes, with its progress on the row: no deadline here.
        while (true) {
          if (!current()) return null;
          if (hostGone()) {
            fail('Reconnect to ${entry.node} to get this model.');
            return null;
          }
          final got = model();
          final operation = got == null ? null : owner.operationFor(got);
          if (operation?.failed == true ||
              (owner.error != null && !owner.busy)) {
            fail(
              operation?.error ??
                  owner.error ??
                  'Could not download this model. Try again.',
            );
            return null;
          }
          if (got != null &&
              got.downloaded &&
              operation?.active != true &&
              !owner.busy) {
            if (!got.running) {
              if (!await stopOther()) return null;
              await owner.control(model() ?? got, 'start');
            }
            break;
          }
          await _modelUsePause();
          if (!current()) return null;
          await owner.refresh();
        }
      } else {
        if (!await stopOther()) return null;
        await owner.control(model() ?? entry.local!, 'start');
      }
      final deadline = DateTime.now().add(timeout);
      while (current()) {
        if (hostGone()) {
          fail('Reconnect to ${entry.node} to use this model.');
          return null;
        }
        final started = model();
        final operation = started == null ? null : owner.operationFor(started);
        if (operation?.failed == true || (owner.error != null && !owner.busy)) {
          fail(
            operation?.error ??
                owner.error ??
                'Could not start this model. Try again.',
          );
          return null;
        }
        if (started?.running == true && operation?.active != true) {
          // The grid's models only: the harness moves onto one of them, and this machine's own list
          // already says the model runs. A full forced read held the move 16s past "running" [run],
          // with the row saying Use — and a second Use looked needed.
          await models!.manager.refresh(force: true, local: false);
          if (!current()) return null;
          final machineId = _modelSelectionMachineId;
          if (machineId != null) {
            final picture = await app.readGridPicture(machineId);
            if (!current()) return null;
            _modelChoices = picture;
          }
          final selected = selectableGridModel(row);
          if (selected != null) return selected;
        }
        if (DateTime.now().isAfter(deadline)) {
          fail(
            'The model is still starting. Try Enter again when it is ready.',
          );
          return null;
        }
        await _modelUsePause();
        if (!current()) return null;
        await owner.refresh();
      }
    } catch (_) {
      if (current()) fail('Could not use this model. Try again.');
    } finally {
      if (!_disposed) {
        usingModelId = null;
        notifyListeners();
      }
    }
    return null;
  }

  void setManaging(bool value) {
    if (_disposed || managing == value) return;
    managing = value;
    notifyListeners();
  }

  final bool commandsOnly;

  /// Open Harness also asks every machine's session index what was said in
  /// each conversation; its hits join the ranking as they arrive.
  SessionContentSearch? _content;

  /// Whether somebody moved through the results since the query changed:
  /// until then, rows arriving from a machine keep the best one selected.
  bool _chosen = false;

  /// The query the machines' session indexes last answered, or null before
  /// any answer: whether what was said has been searched yet.
  String? get contentAnswered => _content?.answered;

  /// What a machine's session index found in this row's conversation for the
  /// current query, when that is how the row matched.
  SessionContentHit? contentHitFor(String rowId) =>
      _contentQuery.isEmpty ? null : _content?.hitsFor(_contentQuery)[rowId];

  /// When the query says to look ("dial last week"), and its words without
  /// that: Open Harness only, where a time narrows to what was worked on then.
  ({String words, SearchWhen? when}) get _read {
    final content = _content;
    final query = _contentQuery;
    return content == null || query.isEmpty
        ? (words: matchQuery, when: null)
        : content.read(query);
  }

  /// The words matched against names and highlighted: the query less any time.
  String get wordsQuery => _read.words;

  /// The words sent to the session indexes: plain harness search only.
  String get _contentQuery =>
      isCommandMode ||
          isHelpMode ||
          isGroupMode ||
          isModelMode ||
          isStoreMode ||
          isAgentMode
      ? ''
      : matchQuery;

  void _contentChanged() {
    if (_disposed) return;
    if (!_chosen) {
      cursor = 0;
      _selectedId = null;
    }
    _filter();
    notifyListeners();
  }

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
  bool get allowsCommands =>
      harnessContext == null && history == null && !navigating;
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
  static final _quickAccessPrefix = RegExp(r'^[>@#?:*&]');
  bool get isMachineMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith('@');
  bool get isModelMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith(':');
  bool get isAgentMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith('&');
  String? agentSelectionMachineId, agentSelectionId;
  Agent? get agentSelection => app
      .stateOf(agentSelectionMachineId ?? '')
      ?.agents
      .where((a) => a.id == agentSelectionId)
      .firstOrNull;
  void setAgentSelection(String machineId, String agentId) {
    agentSelectionMachineId = machineId;
    agentSelectionId = agentId;
    _filter();
    notifyListeners();
  }

  bool canSelectAgent(String engine) =>
      agentSelection != null &&
      app.stateOf(agentSelectionMachineId!)?.machine.isShared == false &&
      app
          .agentSwitchEngines(agentSelectionMachineId!, agentSelection!)
          .contains(engine);
  bool get isStoreMode =>
      allowsCommands && !commandsOnly && query.trimLeft().startsWith('*');
  bool get isGroupMode => isProjectMode || isMachineMode;
  String get scopePrefix => isAgentMode
      ? '&'
      : isMachineMode
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
  String get createLabel => isMachineMode
      ? 'Add machine'
      : isModelMode
      ? '[ Add ]'
      : 'New Harness';

  /// What the create row's preview says, in full: the steps, for Add machine.
  String get createDescription => isMachineMode
      ? 'On the other computer:\n\n1. Install the app or CLI.\n2. Sign in to the same account.\n\nIt appears here and connects on its own.\n\nA machine someone shares with you appears here too.'
      : isModelMode
      ? 'Add an API key\n\n'
            'OpenRouter or a Custom API: Use its models to run a harness.\n'
            'fal.ai or Replicate: harness agents can call it as a tool.\n\n'
            'The key stays on this computer.'
      : 'Choose a harness, machine, and project.';

  /// The create row's own subtitle, one line that says something by itself: a row shows only its
  /// first line, and Add machine's first line of [createDescription] is only "On the other
  /// computer:". The steps stay in the preview beside it.
  String get createDetail => isMachineMode
      ? 'Install Harness there and sign in to the same account'
      : createDescription;
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
    _content?.search(_contentQuery);
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
      : isGroupMode || isModelMode || isStoreMode || isAgentMode
      ? query.trimLeft().substring(1).trimLeft()
      : query;
  String get title => isAgentMode
      ? 'Agents'
      : isCommandMode
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
  bool get supportsPreview =>
      harnessContext == null &&
      history == null &&
      (setupLayout || !isCommandMode && !isHelpMode);
  bool get canPreview =>
      supportsPreview &&
      selected != null &&
      // With nothing found the only row is "New harness: …"; a preview beside
      // it could only say the same words again, over 400px of empty panel.
      rows.any((row) => !row.isCreate);

  bool get hasPreview =>
      harnessContext == null &&
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
    _content?.search(_contentQuery);
    notifyListeners();
  }

  /// Cmd-T and Cmd-P change where Enter opens the result, while the query,
  /// highlighted result and project/machine scope remain the person's choices.
  bool changePlacement(HarnessPlacement placement) {
    if (harnessContext != null ||
        !adding ||
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
    if (harnessContext != null || placement == HarnessPlacement.newTab) {
      return AppNotifier.maxPanes;
    }
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
  String get hint => isAgentMode
      ? 'Search agents'
      : isCommandMode
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
      detail: name ?? createDetail,
      terminalDetail: createDetail,
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
                !swarm.isUtility &&
                !swarm.isOrchestrator &&
                swarm.panes.length < AppNotifier.maxPanes,
          )) &&
      (split == null || app.isPaneSplitCurrent(split!));

  String get commandQuery => query.trimLeft().replaceFirst(_commandPrefix, '');

  String get primaryAction =>
      harnessContext?.action ??
      placement?.action ??
      switch (split?.axis) {
        PaneResizeAxis.x => 'Split right',
        PaneResizeAxis.y => 'Split down',
        null => 'Open Harness',
      };

  String actionLabel(SwarmDestination? row) =>
      harnessContext != null && row?.agentId != null
      ? harnessContext!.action
      : row?.isAgentChoice == true
      ? 'Change agent'
      : row?.isCreate == true
      ? isModelMode
            ? 'Add'
            : row!.title
      : isGridSetupRow(row)
      ? models!.manager.settingUpGrid
            ? 'Setting up…'
            : app.signingIn
            ? 'Signing in…'
            : app.isGuest
            ? 'Sign in'
            : 'Set up'
      : isModelDownloadsRow(row)
      ? modelDownloadsVisible
            ? 'Show fewer'
            : 'More models'
      : canExpandApi(row)
      ? expandedApis.contains(models!.entries[row!.modelId]!.api!.id)
            ? 'Hide models'
            : 'Show models'
      : canSelectModel(row)
      ? 'Use'
      : canGetModel(row)
      ? 'Get'
      : row?.isModel == true
      ? 'Unavailable'
      : row?.isAccountDevice == true || (setupLayout && row?.isMachine == true)
      ? 'Manage'
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
      ? 'Open'
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
    if (isAgentMode) {
      _filter();
      notifyListeners();
      return;
    }
    final storeChanged = isStoreMode && _refreshStore();
    final base = navigating
        ? _locations.read(app, projects?.projects ?? const [])
        : history == null
        ? _cache.read(app, projects?.projects ?? const [], recent: recent)
        : [...history!.menuDestinations(app), ...closedWorkDestinations(app)];
    final next = additionalDestinations.isEmpty
        ? base
        : <String, SwarmDestination>{
            for (final row in additionalDestinations) row.id: row,
            for (final row in base) row.id: row,
          }.values.toList();
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

  /// With a time in the query, the rows worked on then: last active in it, or
  /// vouched for by a machine that saw a turn in it.
  List<SwarmDestination> _within(List<SwarmDestination> rows) {
    final when = _read.when;
    if (when == null) return rows;
    final hits = _content?.hitsFor(_contentQuery) ?? const {};
    bool then(DateTime? at) =>
        at != null && !at.isBefore(when.from) && !at.isAfter(when.to);
    return [
      for (final row in rows)
        if (hits.containsKey(row.id) || then(activityOf(row))) row,
    ];
  }

  void refreshCommands() {
    if (!isCommandMode) return;
    _filter();
    notifyListeners();
  }

  /// A contribution's permissions and membership can change without changing
  /// the native machine catalog. Keep the person's query and selection intact.
  void refreshAvailability() {
    if (harnessContext != null) notifyListeners();
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
      for (final entry in storeVisibleHarnesses(
        app.machineStates.values.expand((machine) => machine.dsh.byId.values),
        app.experimentalFeatures,
      ))
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
            machineLabel:
                app.shownMachineName(session.machine.machine.machineId) ??
                session.machine.machine.displayName,
            terminalDetail:
                '${session.status} · ${app.shownMachineName(session.machine.machine.machineId) ?? session.machine.machine.displayName}',
            promptContext: original?.promptContext,
            machineId: session.machineId,
            agentId: session.agent.id,
            engine: session.agent.identityEngine,
            swarmId: original?.swarmId,
            paneId: original?.paneId,
            previewKey: original?.previewKey,
            lastActivityAt: session.agent.lastActivityAt,
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

  MachineDevices? _machineDevices;

  /// The account's signed-in devices, while the picker lists machines: read the first time it does,
  /// and kept for the rest of the visit.
  MachineDevices? get machineDevices => _machineDevices;

  MachineDevices? _ensureMachineDevices() {
    if (_disposed || history != null) return _machineDevices;
    if (_machineDevices case final devices?) return devices;
    final devices = _machineDevices = MachineDevices(app)
      ..addListener(_machineDevicesChanged);
    // Read after this filter: an answer that is already there would otherwise filter again from
    // inside it.
    scheduleMicrotask(() {
      if (!_disposed && identical(_machineDevices, devices)) devices.start();
    });
    return devices;
  }

  void _machineDevicesChanged() {
    if (_disposed || !isMachineMode) return;
    final previousSelection = selected?.id;
    _filter(keepOrder: true);
    if (previousSelection != null) {
      final index = rows.indexWhere((row) => row.id == previousSelection);
      if (index >= 0) {
        cursor = index;
        _selectedId = previousSelection;
      }
    }
    notifyListeners();
  }

  /// Which run of the Machines picker [row] belongs to.
  MachineSearchSection machineSection(SwarmDestination row) =>
      row.isAccountDevice && !row.deviceIsComputer
      ? MachineSearchSection.phones
      : MachineSearchSection.computers;

  /// Selects the device row for [pub] — a deep link to one device (a new one to review). False when
  /// the list holds no such row (yet).
  bool selectDevice(String pub) {
    final index = rows.indexWhere(
      (row) =>
          row.devicePub == pub ||
          (row.isMachine &&
              _machineDevices?.forMachine(row.machineId!)?.pub == pub),
    );
    if (index < 0) return false;
    if (index != cursor) move(index - cursor);
    return true;
  }

  /// Selects the first phone or app, for a way in that is about them (Add Phone's Manage devices…).
  bool selectFirstPhone() {
    final index = rows.indexWhere(
      (row) => machineSection(row) == MachineSearchSection.phones,
    );
    if (index < 0) return false;
    if (index != cursor) move(index - cursor);
    return true;
  }

  final _decoratedMachines =
      <String, (SwarmDestination, int, SwarmDestination)>{};

  /// The machines, and beside them every device signed in to the account that is not one: phones,
  /// browsers, and a computer with no machine record. A machine's row adds what its key says — this
  /// computer's code, when another was last active, whether it is new.
  List<SwarmDestination> _machineCandidates() {
    final machines = _catalog.where((row) => row.isMachine).toList();
    final devices = _ensureMachineDevices();
    if (devices == null || devices.devices == null) return machines;
    final ids = {for (final row in machines) row.machineId!};
    final now = DateTime.now();
    return [
      for (final row in machines) _machineRow(row, devices, now),
      for (final device in devices.rows(ids)) _deviceRow(device, devices, now),
    ];
  }

  SwarmDestination _machineRow(
    SwarmDestination row,
    MachineDevices devices,
    DateTime now,
  ) {
    final device = devices.forMachine(row.machineId!);
    if (device == null) return row;
    final cached = _decoratedMachines[row.id];
    if (cached != null &&
        identical(cached.$1, row) &&
        cached.$2 == devices.stamp) {
      return cached.$3;
    }
    final local =
        device.self || app.stateOf(row.machineId!)?.isLocalMachine == true;
    final code = device.fingerprint.split('·').first;
    final decorated = SwarmDestination(
      id: row.id,
      title: row.title,
      detail: [
        row.detail,
        if (local) ...[
          'This computer',
          if (code.isNotEmpty) 'code $code…',
        ] else
          activityPhrase(
            lastSeen: device.lastSeen,
            addedAt: device.addedAt,
            now: now,
          ),
        if (device.suspended) 'Suspended' else if (devices.isNew(device)) 'New',
      ].join(' · '),
      machineId: row.machineId,
      swarmId: row.swarmId,
      current: row.current,
      members: row.members,
      searchFields: [...row.fields.skip(1), device.fingerprint, device.label],
    );
    _decoratedMachines[row.id] = (row, devices.stamp, decorated);
    return decorated;
  }

  SwarmDestination _deviceRow(
    AccountDevice device,
    MachineDevices devices,
    DateTime now,
  ) => SwarmDestination(
    id: 'device:${device.pub}',
    devicePub: device.pub,
    deviceIsComputer: device.isMachine,
    title: device.label.trim().isEmpty ? 'Unnamed device' : device.label.trim(),
    detail: devices.detail(device, now: now),
    swarmId: null,
    current: false,
    searchFields: [
      device.fingerprint,
      device.isMachine ? 'computer' : 'app phone browser',
    ],
  );

  void _filter({bool keepOrder = false}) {
    final previous = rows;
    if (isAgentMode) {
      final engines = [...allEngines]
        ..sort(
          (a, b) => a.id == b.id
              ? 0
              : a.id == 'opencode'
              ? -1
              : b.id == 'opencode'
              ? 1
              : a.label.compareTo(b.label),
        );
      rows = [
        for (final engine in engines)
          if ('${engine.label} ${engine.id}'.toLowerCase().contains(
            matchQuery.toLowerCase(),
          ))
            SwarmDestination(
              id: 'engine:${engine.id}',
              agentEngine: engine.id,
              engine: engine.id,
              title: engine.id == 'claude' ? 'Claude Code' : engine.label,
              detail: agentSelection == null
                  ? 'Focus a harness to change its agent'
                  : !canSelectAgent(engine.id)
                  ? 'Not supported by this harness'
                  : agentSelection?.engine == engine.id
                  ? 'Current agent'
                  : engine.id == 'opencode'
                  ? 'Muse Spark 1.3 · continue with recent context'
                  : supportsAgentHandoff(engine.id)
                  ? 'Continue this project with recent context'
                  : 'New conversation in the same project',
              swarmId: null,
              current: agentSelection?.engine == engine.id,
            ),
      ];
      total = engines.length;
      matchCount = rows.length;
      cursor = rows.isEmpty ? 0 : cursor.clamp(0, rows.length - 1);
      _selectedId = selected?.id;
      return;
    }
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
        ? _machineCandidates()
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
    if (isModelMode) {
      _downloadCount = candidates.where(_foldedDownload).length;
    }
    if (isModelMode && matchQuery.trim().isEmpty && !modelDownloadsVisible) {
      // Always surface the top few catalog models (in the daemon's order) so the
      // picker opens with them already in view; the rest stay hidden until
      // "More models" is pressed.
      final topCatalog = candidates
          .where(_foldedDownload)
          .take(shownDownloads)
          .map((row) => row.id)
          .toSet();
      candidates = candidates
          .where((row) => !_foldedDownload(row) || topCatalog.contains(row.id))
          .toList();
    }
    if (isModelMode && matchQuery.trim().isEmpty) {
      candidates = candidates.where((row) {
        final entry = models?.entries[row.modelId];
        return entry?.apiModel == null || expandedApis.contains(entry!.api!.id);
      }).toList();
    }
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
    // Conversations Harness did not start, found by what was said in them: a
    // row only while a search matches one, never in the list as it opens.
    if (byActivity &&
        _contentQuery.isNotEmpty &&
        scopedBranch == null &&
        _groupScope == null &&
        split == null) {
      final present = {for (final row in candidates) row.id};
      candidates = [
        ...candidates,
        for (final hit
            in _content?.hitsFor(_contentQuery).values ??
                const <SessionContentHit>[])
          if (hit.external case final external?
              when !present.contains(hit.destinationId))
            externalSessionDestination(
              hit,
              external,
              machineLabel: app.shownMachineName(hit.machineId) ?? '',
            ),
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
            _within(candidates),
            wordsQuery,
            recent: recent,
            previews: app.sessionPreviews,
            activityOf: activityOf,
            contentHits: _contentQuery.isEmpty
                ? null
                : _content?.hitsFor(_contentQuery),
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
    if (isMachineMode && matchQuery.trim().isEmpty) {
      // Signed-in devices keep the order the account's list gives them (new first, then by activity),
      // after the machines.
      final deviceOrder = {
        for (final (index, row) in rows.indexed)
          if (row.isAccountDevice) row.id: index,
      };
      int priority(SwarmDestination row) {
        if (row.isAccountDevice) return 4;
        final machine = app.stateOf(row.machineId!);
        if (machine == null) return 3;
        if (machine.isLocalMachine) return 1;
        if (machine.isOffline) return 3;
        if (machine.needsLink) return 0;
        return machine.connectionStatus == ConnectionStatus.disconnected
            ? 3
            : 2;
      }

      rows.sort((a, b) {
        final group = priority(a).compareTo(priority(b));
        if (group != 0) return group;
        if (a.isAccountDevice && b.isAccountDevice) {
          return deviceOrder[a.id]!.compareTo(deviceOrder[b.id]!);
        }
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
    // Computers, then phones and apps: the order the picker draws them in, so the arrows walk the
    // rows in the order the eye does.
    if (isMachineMode) {
      rows = [
        for (final section in MachineSearchSection.values)
          for (final row in rows)
            if (!row.isCreate && machineSection(row) == section) row,
        for (final row in rows)
          if (row.isCreate) row,
      ];
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
          !isMachineMode &&
              (resultsFromBottom ||
                  navigating ||
                  placement != null ||
                  query.trim().isEmpty)
          ? [?create, ...found]
          : [...found, ?create];
    }
    if (isModelMode) {
      // A subscription is one person's own: nothing in it can be given to a Swarm. And what the Swarm's own grid serves
      // is the Swarm's already, not shared with the person: its models are listed where they come from.
      if (swarmModels case final swarm?) {
        rows = rows.where((row) {
          if (modelSection(row) == ModelSearchSection.subscriptions) {
            return false;
          }
          if (!swarmSharedWithYouShown &&
              modelSection(row) == ModelSearchSection.shared) {
            return false;
          }
          final entry = models?.entries[row.modelId];
          return entry?.local != null || entry?.gridModel?.grid != swarm.grid;
        }).toList();
      }
      if (matchQuery.trim().isEmpty && _downloadCount > shownDownloads) {
        rows = [...rows, _downloadsRow];
      }
      if (gridSetupOffered) {
        // Local and shared models are this one row until Grid is set up: a downloaded file, a
        // download or a model shared on a grid cannot be used before then, and a list of them
        // beside "Set up" read as if they could.
        rows = rows.where((row) {
          final section = modelSection(row);
          return section == ModelSearchSection.subscriptions ||
              section == ModelSearchSection.apis;
        }).toList();
        if (_offersGridSetupFor(matchQuery)) rows = [...rows, _gridSetupRow];
      }
      // An API's models are listed under its row, as a group: a search that matches a model and not
      // its API still shows the API above it, and the models of two APIs never interleave.
      final shown = {for (final row in rows) row.modelId};
      for (final row in [...rows]) {
        final entry = models?.entries[row.modelId];
        final heading = entry?.apiModel == null
            ? null
            : models!.entries['model:api:${entry!.api!.id}']?.destination;
        if (heading != null && shown.add(heading.modelId)) rows.add(heading);
      }
      final apiOrder = {
        for (final (index, row) in (models?.rows ?? const []).indexed)
          if (isApiRow(row)) models!.entries[row.modelId]!.api!.id: index,
      };
      int apiGroup(SwarmDestination row) =>
          apiOrder[models?.entries[row.modelId]?.api?.id] ?? 0;
      final order = {for (final (index, row) in rows.indexed) row.id: index};
      rows.sort((a, b) {
        final section = modelSection(a).index.compareTo(modelSection(b).index);
        if (section != 0) return section;
        if (modelSection(a) != ModelSearchSection.local &&
            modelSection(a) != ModelSearchSection.catalog) {
          final create = (a.isCreate ? 1 : 0).compareTo(b.isCreate ? 1 : 0);
          if (create != 0) return create;
          if (modelSection(a) == ModelSearchSection.apis && !a.isCreate) {
            final group = apiGroup(a).compareTo(apiGroup(b));
            if (group != 0) return group;
            final heading = (isApiRow(a) ? 0 : 1).compareTo(
              isApiRow(b) ? 0 : 1,
            );
            if (heading != 0) return heading;
          }
          return order[a.id]!.compareTo(order[b.id]!);
        }
        // The downloads toggle sorts AFTER the catalog rows (rank 2), so the
        // always-visible top catalog models sit above the "[ Get models ]" row.
        final installed = (models?.entries[a.modelId]?.localRank ?? 3)
            .compareTo(models?.entries[b.modelId]?.localRank ?? 3);
        return installed != 0
            ? installed
            : order[a.id]!.compareTo(order[b.id]!);
      });
      if (modelScope case final scope?) {
        rows = rows.where((row) => modelSection(row) == scope).toList();
      }
    }
    if (!isCommandMode && !isHelpMode) {
      if (noteFor?.call(query) case final note?) {
        rows = [
          SwarmDestination(
            id: 'note:${query.trim().toLowerCase()}',
            title: note,
            detail: '',
            swarmId: null,
            current: false,
            isNote: true,
          ),
          ...rows,
        ];
      }
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
    if (harnessContext != null && preferred == null) {
      final agent = rows.indexWhere(
        (row) => row.agentId != null && canSubmit(row),
      );
      if (agent >= 0) cursor = agent;
    }
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
    if (_openSection case final section? when isModelMode) {
      final first = rows.indexWhere((row) => modelSection(row) == section);
      if (first >= 0) cursor = first;
    }
    _selectedId = selected?.id;
    matchCount = rows
        .where(
          (row) =>
              !row.isCreate &&
              !row.isNote &&
              !isModelDownloadsRow(row) &&
              !isGridSetupRow(row),
        )
        .length;
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

  /// The model section the picker opened on, with nothing typed: its first row
  /// stays selected as the rows arrive, until somebody types, moves or picks.
  ModelSearchSection? _openSection;

  /// Select the first row of [section], as the footer's Models and
  /// Subscriptions do, instead of typing a filter the person must delete.
  void openModelSection(ModelSearchSection section) {
    _openSection = section;
    _filter();
    notifyListeners();
  }

  /// The models list of a Swarm's Manage models, drawn in its own way (`super_tabs/local_models.dart`).
  bool get isSwarmModels => isModelMode && swarmModels != null;

  /// How many of the Swarm's APIs' models [row]'s API shares with the Swarm. Null for any row but an API's own.
  int? swarmApiShareCount(SwarmDestination row) {
    final swarm = swarmModels;
    if (swarm == null || !isApiRow(row)) return null;
    final id = models!.entries[row.modelId]!.api!.id;
    return swarm.shares.where((key) => key.startsWith('$id\u0000')).length;
  }

  /// The one model section the list shows, or every section: the scope buttons of a Swarm's Manage models.
  ModelSearchSection? modelScope;

  void setModelScope(ModelSearchSection? section) {
    if (modelScope == section) return;
    modelScope = section;
    cursor = 0;
    _selectedId = null;
    _filter();
    notifyListeners();
  }

  void setQuery(String value) {
    if (query == value) return;
    if (_quickAccessPrefix.hasMatch(value.trimLeft())) _groupScope = null;
    _openSection = null;
    query = value;
    if (isStoreMode) _refreshStore();
    cursor = 0;
    _selectedId = null;
    _chosen = false;
    _filter();
    _content?.search(_contentQuery);
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
    _openSection = null;
    cursor = ((cursor < 0 && delta < 0 ? 0 : cursor) + delta) % rows.length;
    _selectedId = selected!.id;
    _chosen = true;
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
    _openSection = null;
    if (canExpandApi(destination)) {
      final api = models!.entries[destination.modelId]!.api!;
      final opening = expandedApis.add(api.id);
      if (!opening) expandedApis.remove(api.id);
      _filter();
      final index = opening
          ? rows.indexWhere(
              (row) =>
                  row.modelId?.startsWith(apiModelRowId(api.id, '')) == true,
            )
          : rows.indexWhere((row) => row.id == destination.id);
      if (index >= 0) {
        cursor = index;
        _selectedId = selected!.id;
      }
      notifyListeners();
      return null;
    }
    if (isGridSetupRow(destination)) {
      final manager = models!.manager;
      if (!manager.settingUpGrid && !app.signingIn) {
        unawaited(manager.setUpGrid());
      }
      notifyListeners();
      return null;
    }
    if (isModelDownloadsRow(destination)) {
      modelDownloadsVisible = !modelDownloadsVisible;
      _filter();
      if (modelDownloadsVisible) {
        final index = rows.indexWhere(_foldedDownload);
        if (index >= 0) {
          cursor = index;
          _selectedId = selected!.id;
        }
      }
      notifyListeners();
      return null;
    }
    if (swarmModels != null && destination.isModel) {
      // Return does what the preview's button does, for the Swarm.
      final run = swarmModelAction(destination)?.run;
      if (run != null) unawaited(run());
      return null;
    }
    if (destination.isModel &&
        !canSelectModel(destination) &&
        !canGetModel(destination)) {
      return null;
    }
    if (destination.isAccountDevice) {
      // A device is managed in the preview beside it; a click only chooses it.
      return setupLayout ? SwarmSearchSelection(destination) : null;
    }
    if (setupLayout && (destination.isMachine || destination.isModel)) {
      return SwarmSearchSelection(destination);
    }
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

  /// Read live state at activation too: a rendered row can outlive a disconnect.
  String? sessionUnavailable(SwarmDestination? row) {
    if (harnessContext != null && row?.agentId != null) {
      return harnessContext!.unavailable(row!);
    }
    if (row?.external case final external?) {
      // Short: it is a row's note. The preview says what to do about it. Its
      // preview's answer is the fresher, when there is one.
      final previewed = app.sessionTails.read((
        machineId: row!.machineId ?? '',
        sessionId: external.sessionId,
      ));
      if (external.open || previewed?.openElsewhere == true) {
        // One in a terminal can be moved here: opening it moves it.
        final where = previewed?.openIn ?? external.openIn;
        if (where == 'terminal') return null;
        if (where == 'harness') return 'Already in Harness';
        if (where == 'maybe') return 'May be open in a terminal';
        if (external.origin == 'terminal') {
          // A machine that predates taking over; or no terminal holds it now.
          return where == null ? 'Open in another terminal' : 'Open in an app';
        }
        return 'Open in the ${external.originLabel}';
      }
      final machine = app.stateOf(row.machineId ?? '');
      return machine == null || machine.nodeOnline == false
          ? 'Its machine is offline.'
          : null;
    }
    if (!setupLayout || row?.agentId == null) return null;
    final machine = app.stateOf(row!.machineId!);
    final agent = machine?.agents
        .where((agent) => agent.id == row.agentId)
        .firstOrNull;
    return harnessSessionUnavailable(machine, agent);
  }

  bool canSubmit(SwarmDestination? row) => row?.agentEngine != null
      ? canSelectAgent(row!.agentEngine!)
      : row?.devicePub != null
      ? isMachineMode && _machineDevices?.byPub(row!.devicePub!) != null
      : row?.isNote == true ||
            sessionUnavailable(row) != null ||
            sessionFilter == SessionFilter.needsInput &&
                _unavailableAttentionIds.contains(row?.id)
      ? false
      : isModelDownloadsRow(row)
      ? true
      : isGridSetupRow(row)
      ? !models!.manager.settingUpGrid && !app.signingIn
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
      harnessContext == null &&
      adding &&
      row.agentId != null &&
      _presentIds.contains(row.id);

  bool canAdd(SwarmDestination? row) => harnessContext != null
      ? adding && row?.agentId != null && sessionUnavailable(row) == null
      : row?.external != null
      // A conversation Harness did not start becomes a new harness: room for
      // one more pane, or a tab of its own.
      ? !navigating &&
            history == null &&
            split == null &&
            sessionUnavailable(row) == null &&
            (placement == HarnessPlacement.newTab ||
                app.swarms.any(
                  (swarm) =>
                      swarm.id == targetId &&
                      !swarm.isUtility &&
                      !swarm.isOrchestrator &&
                      swarm.panes.length < AppNotifier.maxPanes,
                ))
      : !navigating &&
            history == null &&
            row != null &&
            sessionUnavailable(row) == null &&
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
                              !swarm.isUtility &&
                              !swarm.isOrchestrator &&
                              swarm.panes.length + _missingCount(row) <=
                                  AppNotifier.maxPanes,
                        )));

  SwarmSearchSelection? addHere() => adding || isGroupMode || isHelpMode
      ? submit()
      : canAdd(selected)
      ? SwarmSearchSelection(selected!, SwarmSearchAction.addHere)
      : null;

  static String action(SwarmDestination row) => row.isAgentChoice
      ? 'Change agent'
      : row.isCommand
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
    _content?.removeListener(_contentChanged);
    _content?.dispose();
    _modelUseTimer?.cancel();
    if (_modelUseWait?.isCompleted == false) _modelUseWait!.complete();
    app.removeListener(_refresh);
    app.experimentalFeatures.removeListener(_refresh);
    projects?.removeListener(_refresh);
    models?.removeListener(_modelsChanged);
    app.gridPictures.removeListener(_modelChoicesChanged);
    app.sessionPreviews.removeListener(_previewChanged);
    _machineDevices?.removeListener(_machineDevicesChanged);
    _machineDevices?.dispose();
    _previewPage.dispose();
    _previewLine.dispose();
    _resultPage.dispose();
    super.dispose();
  }
}

/// A Cmd-P row for a conversation Harness did not start, from the hit that
/// found it: its title (or what was first asked), the engine and where it ran.
SwarmDestination externalSessionDestination(
  SessionContentHit hit,
  ExternalSessionRef external, {
  String machineLabel = '',
}) {
  final engine = external.engineName;
  final folder =
      external.cwd.split('/').where((part) => part.isNotEmpty).lastOrNull ??
      external.cwd;
  final detail = [
    engine,
    external.originLabel,
    folder,
    'not in Harness',
  ].join(' · ');
  return SwarmDestination(
    id: hit.destinationId,
    title: external.title.isEmpty ? 'Untitled conversation' : external.title,
    detail: detail,
    terminalDetail: [
      detail,
      if (machineLabel.isNotEmpty) machineLabel,
    ].join(' · '),
    lastActivityAt: hit.lastAt ?? hit.at,
    swarmId: null,
    current: false,
    machineId: hit.machineId,
    machineLabel: machineLabel,
    engine: external.engine,
    external: external,
    searchFields: [folder, external.cwd, engine],
  );
}
