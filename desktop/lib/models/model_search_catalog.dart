import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/models.dart';
import '../state/swarm_navigation.dart';
import '../usage/models_menu_controller.dart';
import '../widgets/resting_model_words.dart';
import 'api_connections_controller.dart';
import 'local_model.dart';
import 'model_manager_controller.dart';

/// Between a shared model's name and the machine serving it, in its row's title.
const modelMachineSeparator = ' · ';

/// The two kinds of model the picker lists, each under its own heading: chat models, which a harness
/// runs on, and decision models (Jev, System One), which answer typed questions and run no harness.
enum ModelSearchGroup {
  chat('Chat models'),
  decision('Decision models');

  const ModelSearchGroup(this.label);
  final String label;
}

enum ModelSearchSection {
  subscriptions('Subscriptions'),
  apis('APIs'),
  local('Your models'),

  /// Models a machine of yours can download: the grid catalog's picks for it. Its heading names the
  /// machine and its memory ([ModelSearchCatalog.catalogHeadingFor]); this label is its search word.
  catalog('Get models'),
  shared('Shared with you'),

  /// Decision models, listed last, apart from every model a harness can use: a machine of yours
  /// runs or has them, ones it can download (only those it has the memory to start), and the ones
  /// a grid shared with you serves.
  jevLocal('Your models', ModelSearchGroup.decision),
  jevCatalog('Get models', ModelSearchGroup.decision),
  jevShared('Shared with you', ModelSearchGroup.decision);

  const ModelSearchSection(this.label, [this.group = ModelSearchGroup.chat]);
  final String label;
  final ModelSearchGroup group;

  /// Names the section's heading in the list: its label, which a decision section shares with its
  /// chat namesake, so that one also names its group.
  String get key =>
      group == ModelSearchGroup.chat ? label : '${group.label}: $label';
}

/// Public model metadata shared by the picker and its preview. Filtering this
/// snapshot never scans a machine or changes a harness's selected model.
class ModelSearchEntry {
  ModelSearchEntry({
    required this.id,
    required this.name,
    required this.source,
    required this.status,
    this.local,
    this.api,
    this.apiModel,
    this.subscription,
    this.node,
    this.searchAliases = const [],
    this.controller,
    this.own = false,
    this.gridModel,
    this.sharedBy,
  });
  final String id, name, source, status;
  final String? node;
  final LocalModel? local;
  final ApiConnection? api;

  /// One of [api]'s chat models: a row a harness can run on through that API ([api] is its API).
  /// Null on the API's own row.
  final ApiModel? apiModel;
  final Map<String, Object?>? subscription;
  final List<String> searchAliases;
  final ModelManagerController? controller;
  final bool own;
  final GridModel? gridModel;
  final String? sharedBy;

  /// A Jev (System One) decision model: called at `/v1/systemone`, never run as a harness.
  bool get isJev => gridModel?.decision == true || local?.decision == true;

  ModelSearchSection get section => subscription != null
      ? ModelSearchSection.subscriptions
      : api != null
      ? ModelSearchSection.apis
      : isJev
      ? isDownload
            ? ModelSearchSection.jevCatalog
            : own
            ? ModelSearchSection.jevLocal
            : ModelSearchSection.jevShared
      : isDownload
      ? ModelSearchSection.catalog
      : own
      ? ModelSearchSection.local
      : ModelSearchSection.shared;

  /// A catalog model a machine of yours does not have yet — downloading, or not started on.
  /// An engine of yours that is not serving is still yours ([LocalModel.canStop]).
  bool get isDownload =>
      local != null &&
      !local!.downloaded &&
      !local!.canStop &&
      gridModel == null;

  bool get needsDownload =>
      local != null &&
      !local!.downloaded &&
      gridModel == null &&
      controller?.operationFor(local!)?.active != true;

  // Installed weights stay above discovery-only rows and the download catalog.
  int get localRank => local?.downloaded == true
      ? 0
      : gridModel != null
      ? 1
      : 2;

  late final destination = SwarmDestination(
    id: id,
    modelId: id,
    // An API's model is listed under its API's row, so it is named alone.
    title: sharedBy?.isNotEmpty == true
        ? '$name$modelMachineSeparator$sharedBy'
        : name,
    detail: [source, node, status].whereType<String>().join(' · '),
    swarmId: null,
    current: false,
    searchFields: [
      section.label,
      source,
      node,
      sharedBy,
      status,
      local?.id,
      api?.host,
      api?.name,
      apiModel?.name,
      if (isJev) ...[ModelSearchGroup.decision.label, 'jev'],
      ...searchAliases,
    ],
  );
}

/// The row id of [modelId] on the API saved as [connectionId].
String apiModelRowId(String connectionId, String modelId) =>
    'model:apimodel:$connectionId:$modelId';

class ModelSearchCatalog extends ChangeNotifier {
  ModelSearchCatalog(
    this.manager,
    this.subscriptions, {
    this.pollHosts = true,
  }) {
    manager.addListener(_refresh);
    manager.apis.addListener(_refresh);
    subscriptions.addListener(_refresh);
    manager.app.addListener(_machinesChanged);
    _refresh();
  }
  final ModelManagerController manager;
  final ModelsMenuController subscriptions;
  final bool pollHosts;
  final _hosts = <String, ModelManagerController>{};
  final _managedRowIds = <String, String>{};
  bool _visible = false;
  bool _watchInstalled = false;
  Map<String, ModelSearchEntry> entries = {};
  List<SwarmDestination> rows = const [];

  /// The footer shares the picker's per-machine inventory, without loading API
  /// catalogs or marking the picker visible. Start after the first frame.
  void watchInstalled() {
    if (_watchInstalled) return;
    _watchInstalled = true;
    _machinesChanged();
  }

  List<ModelManagerController> get _inventories => [manager, ..._hosts.values];

  /// Same daemon model id + quantization on several machines is one variant.
  /// Catalog downloads, API rows, subscriptions and shared grids are excluded.
  int? get installedCount {
    final inventories = _inventories.where((owner) => owner.loaded);
    if (inventories.isEmpty) return null;
    return {
      for (final owner in inventories)
        for (final model in owner.localModels)
          if (model.downloaded || model.canStop)
            (model.id.trim().toLowerCase(), model.quantization?.toLowerCase()),
    }.length;
  }

  String get installedDetail {
    final count = installedCount;
    final machines = _inventories
        .where(
          (owner) => owner.localModels.any(
            (model) => model.downloaded || model.canStop,
          ),
        )
        .length;
    final unknown = _inventories
        .where((owner) => !owner.inventoryAvailable)
        .length;
    return [
      count == null
          ? 'Installed local models have not been read yet.'
          : '$count local model${count == 1 ? '' : 's'} installed across '
                '$machines machine${machines == 1 ? '' : 's'}.',
      if (unknown > 0)
        'Inventory unavailable on $unknown machine${unknown == 1 ? '' : 's'}; showing last known models.',
      'Open local models.',
    ].join('\n');
  }

  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
    manager.apis.loadModels(wanted: visible);
    _machinesChanged();
    for (final controller in _hosts.values) {
      controller.setPanelVisible(visible);
      if (visible) unawaited(controller.refresh());
    }
  }

  void _machinesChanged() {
    final machines = manager.app.machineStates;
    for (final id in _hosts.keys.toList()) {
      final machine = machines[id];
      if (machine == null ||
          id == manager.machine?.machine.machineId ||
          machine.machine.isShared ||
          machine.needsLink) {
        _hosts.remove(id)!.dispose();
        _managedRowIds.removeWhere((key, _) => key.startsWith('$id:'));
      }
    }
    if (_visible || _watchInstalled) {
      for (final machine in machines.values) {
        final id = machine.machine.machineId;
        if (id == manager.machine?.machine.machineId ||
            machine.machine.isShared ||
            machine.needsLink ||
            _hosts.containsKey(id)) {
          continue;
        }
        final controller = ModelManagerController(
          manager.app,
          targetMachineId: id,
          poll: manager.poll && pollHosts,
          backgroundInventory: _watchInstalled,
        );
        _hosts[id] = controller;
        controller.addListener(_refresh);
        controller.setPanelVisible(_visible);
        controller.start();
      }
    }
    _refresh();
  }

  Future<void> refresh({bool force = false}) async {
    _machinesChanged();
    if (_visible) manager.apis.loadModels(reread: force);
    await Future.wait([
      manager.refresh(force: force),
      for (final controller in _hosts.values) controller.refresh(force: force),
    ]);
  }

  // Harness already stores both naming conventions on one machine record.
  // Resolve that record first, then take model ids and capabilities from its
  // own inventory. Duplicate names never grant control over an arbitrary host.
  ModelManagerController? _hostFor(String node) {
    if (node.isEmpty) return null;
    final matching = manager.app.machineStates.values.where(
      (state) =>
          !state.machine.isShared &&
          (state.machine.hostname == node || state.machine.name == node),
    );
    if (matching.length != 1) return null;
    final host = matching.single;
    return host.machine.machineId == manager.machine?.machine.machineId
        ? manager
        : _hosts[host.machine.machineId];
  }

  String _managedKey(ModelManagerController owner, LocalModel model) =>
      '${owner.machine?.machine.machineId}:${model.id}';

  void _refresh() {
    final discovered = <ModelSearchEntry>[];
    final served = <String, GridModel>{};
    for (final section in manager.sections) {
      for (final model in section.models) {
        final owner = section.own ? _hostFor(model.node) : null;
        // A Jev model folds only into a Jev model of yours, a chat model only into a chat one: a chat
        // row would offer a Jev model to a harness.
        final matches =
            owner?.localModels
                .where(
                  (local) =>
                      local.decision == model.decision &&
                      (local.downloaded || local.canStop) &&
                      (local.name.toLowerCase() == model.id.toLowerCase() ||
                          local.id.toLowerCase() == model.id.toLowerCase()),
                )
                .toList() ??
            const <LocalModel>[];
        final id =
            'model:${section.own ? 'own' : 'shared'}:${section.name}:${model.node}:${model.id}';
        final gridModel = GridModel(
          id: model.id,
          node: model.node,
          grid: model.grid ?? section.name,
          unavailable: model.unavailable,
          decision: model.decision,
        );
        if (owner != null && matches.length == 1) {
          served[_managedKey(owner, matches.single)] = gridModel;
          _managedRowIds.putIfAbsent(
            _managedKey(owner, matches.single),
            () => id,
          );
          continue;
        }
        final words = sectionWords(section);
        discovered.add(
          ModelSearchEntry(
            id: id,
            name: model.id,
            source: section.own
                ? 'On your machines'
                : 'Shared · ${section.name}',
            node: owner?.machine?.machine.displayName ?? model.node,
            searchAliases: [
              model.node,
              if (section.own) 'local',
              if (model.decision) ...['jev', 'decision'],
            ],
            own: section.own,
            controller: owner,
            gridModel: gridModel,
            sharedBy: section.own ? null : model.node,
            status:
                offlineRowNote(model) ??
                words.sentence ??
                words.subtitle ??
                (manager.models?.reachable == false
                    ? 'Unavailable'
                    : 'Available'),
          ),
        );
      }
    }
    // A Jev model a machine of yours serves (`grid join --serve` of a decision GGUF) is listed once,
    // under Jev models: its local row would offer it to a harness, which cannot run on it.
    final deciders = {
      for (final section in manager.sections)
        if (section.own)
          for (final model in section.models)
            if (model.decision) model.id.toLowerCase(),
    };
    final local = [
      for (final owner in [manager, ..._hosts.values])
        for (final model in owner.localModels)
          if (model.decision ||
              (!deciders.contains(model.name.toLowerCase()) &&
                  !deciders.contains(model.id.toLowerCase())))
            (owner: owner, model: model),
    ];
    int rank(ModelManagerController owner, LocalModel model) =>
        owner.operationFor(model)?.active == true
        ? 0
        : model.running
        ? 1
        : model.downloaded
        ? 2
        : 3;
    local.sort((a, b) {
      final state = rank(a.owner, a.model).compareTo(rank(b.owner, b.model));
      if (state != 0) return state;
      // Preserve the daemon's order, not an alphabetised re-sort: it ranks the
      // catalog's downloads for a coding agent on that machine (`rankForCoding`
      // in the CLI's localModels.ts), so its first are the ones to offer.
      final aIndex = a.owner.localModels.indexOf(a.model);
      final bIndex = b.owner.localModels.indexOf(b.model);
      final order = aIndex.compareTo(bIndex);
      if (order != 0) return order;
      final host = (a.owner.machine?.machine.displayName ?? '').compareTo(
        b.owner.machine?.machine.displayName ?? '',
      );
      return host != 0
          ? host
          : _managedKey(
              a.owner,
              a.model,
            ).compareTo(_managedKey(b.owner, b.model));
    });
    // A row names its model alone; the quantization is in the preview. Only two versions of one
    // model on one machine need it to be told apart.
    final named = <String, int>{};
    for (final (:owner, :model) in local) {
      final key = '${identityHashCode(owner)}:${model.name.toLowerCase()}';
      named[key] = (named[key] ?? 0) + 1;
    }
    bool twin(ModelManagerController owner, LocalModel model) =>
        (named['${identityHashCode(owner)}:${model.name.toLowerCase()}'] ?? 0) >
        1;
    final all = [
      for (final (:owner, :model) in local)
        ModelSearchEntry(
          id: _managedRowIds.putIfAbsent(
            _managedKey(owner, model),
            () => (identical(owner, manager)
                ? 'model:local:${model.id}'
                : 'model:machine:${_managedKey(owner, model)}'),
          ),
          name: model.name.isEmpty || twin(owner, model)
              ? model.displayName
              : model.name,
          source: 'Local',
          node: owner.machine?.machine.displayName,
          status: localStatus(model, controller: owner),
          local: model,
          own: true,
          controller: owner,
          gridModel: served[_managedKey(owner, model)],
          searchAliases: [
            ?owner.machine?.machine.hostname,
            ?model.quantization,
          ],
        ),
      ...discovered.where((entry) => entry.own),
      ...discovered.where((entry) => !entry.own),
      for (final row in subscriptions.rows)
        ModelSearchEntry(
          id: subscriptionSearchId(row),
          name: [
            '${row['title'] ?? 'Subscription'}',
            if ('${row['account'] ?? ''}'.isNotEmpty) '${row['account']}',
          ].join(' · '),
          source: 'Subscription',
          status: '${row['status'] ?? 'Usage unavailable'}',
          subscription: row,
        ),
      for (final api in manager.apis.connections) ...[
        ModelSearchEntry(
          id: 'model:api:${api.id}',
          name: api.name,
          source: 'API',
          status: api.host,
          api: api,
        ),
        // Straight after their API, in the API's order: the list keeps a section's rows as built.
        for (final model
            in manager.apis.models[api.id]?.models ?? const <ApiModel>[])
          ModelSearchEntry(
            id: apiModelRowId(api.id, model.id),
            name: model.id,
            source: 'API',
            status: api.name,
            api: api,
            apiModel: model,
          ),
      ],
    ];
    final order = {for (final (index, entry) in all.indexed) entry.id: index};
    all.sort((a, b) {
      final section = a.section.index.compareTo(b.section.index);
      if (section != 0) return section;
      final installed = a.localRank.compareTo(b.localRank);
      return installed != 0 ? installed : order[a.id]!.compareTo(order[b.id]!);
    });
    entries = {for (final entry in all) entry.id: entry};
    rows = [for (final entry in all) entry.destination];
    notifyListeners();
  }

  String localStatus(LocalModel model, {ModelManagerController? controller}) {
    final owner = controller ?? manager;
    final operation = owner.operationFor(model);
    if (operation?.active == true) {
      final progress = operation!.progress;
      return '${operation.label}${progress == null ? '' : ' ${(progress * 100).floor()}%'}';
    }
    if (owner.pendingId == model.id) {
      return owner.pendingDownload
          ? 'Downloading'
          : owner.pendingStart
          ? 'Starting'
          : 'Stopping';
    }
    if (operation?.failed == true) return 'Failed · try again';
    return model.running
        ? 'Running'
        : model.downloaded
        ? 'Downloaded'
        : 'Not downloaded';
  }

  /// The inline status word for a list row: a short word with no progress
  /// percentage (the percentage lives in the pane/detail). Operation and pending
  /// states map to their bare label so the row never repeats the "42%".
  String localStatusWord(
    LocalModel model, {
    ModelManagerController? controller,
  }) {
    final owner = controller ?? manager;
    final operation = owner.operationFor(model);
    if (operation?.active == true) return operation!.label;
    if (owner.pendingId == model.id) {
      return owner.pendingDownload
          ? 'Downloading'
          : owner.pendingStart
          ? 'Starting'
          : 'Stopping';
    }
    if (operation?.failed == true) return 'Failed';
    return model.running
        ? 'Running'
        : model.downloaded
        ? 'Downloaded'
        : 'Not downloaded';
  }

  /// The chat downloads' heading ([catalogHeadingFor]).
  String get catalogHeading => catalogHeadingFor(ModelSearchSection.catalog);

  /// A downloads section's heading — chat models' or decision models' — the machine they are for and its
  /// memory, `Get for this Mac · 64 GB`. Downloads for more than one machine are headed plainly; each
  /// row's preview names its machine.
  String catalogHeadingFor(ModelSearchSection section) {
    final owners = {
      for (final entry in entries.values)
        if (entry.section == section) entry.controller ?? manager,
    };
    if (owners.length != 1) return section.label;
    final owner = owners.single;
    final machine = owner.machine;
    final memory = owner.memoryBytes;
    return [
      'Get for ${machine == null || machine.isLocalMachine ? thisComputerName() : machine.machine.displayName}',
      if (memory != null) gigabytesLabel(memory),
    ].join(' · ');
  }

  @override
  void dispose() {
    manager.app.removeListener(_machinesChanged);
    for (final controller in _hosts.values) {
      controller.dispose();
    }
    manager.removeListener(_refresh);
    manager.apis.removeListener(_refresh);
    subscriptions.removeListener(_refresh);
    super.dispose();
  }
}

/// Bytes as a person reads a model's size: `2.7 GB` under ten, `27 GB` above.
String gigabytesLabel(double bytes) {
  final gb = bytes / (1024 * 1024 * 1024);
  return gb < 9.95 ? '${gb.toStringAsFixed(1)} GB' : '${gb.round()} GB';
}

/// This computer as its owner calls it: `this Mac` on a Mac, `this computer` on Linux.
String thisComputerName() => defaultTargetPlatform == TargetPlatform.macOS
    ? 'this Mac'
    : 'this computer';

/// How to call the Jev model [model] served on [grid], as a person pastes it into a terminal: load
/// the grid's address and key with `harness grid env` (the harness's own `grid`, so no `grid` of
/// one's own is needed, nor one new enough to call a resting grid), then ask it one decision. The
/// key never appears here; the shell reads it from the variable that sets.
String jevRequest(String grid, String model) {
  final body = jsonEncode({
    'model': model,
    'state': 'I was charged twice. Please refund the duplicate.',
    'questions': {
      'refund': {'type': 'noul', 'instructions': 'Is a refund requested?'},
    },
  });
  return 'eval "\$(harness grid env ${_shellWord(grid)})"\n'
      'curl "\$OPENAI_BASE_URL/systemone" \\\n'
      '  -H "Authorization: Bearer \$OPENAI_API_KEY" \\\n'
      '  -H "Content-Type: application/json" \\\n'
      "  -d ${_shellWord(body)}";
}

/// [value] as one shell word: bare when it is plainly safe, single-quoted otherwise.
String _shellWord(String value) =>
    RegExp(r'^[A-Za-z0-9._:@/+-]+$').hasMatch(value)
    ? value
    : "'${value.replaceAll("'", r"'\''")}'";
