import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/models.dart';
import '../state/swarm_navigation.dart';
import '../usage/models_menu_controller.dart';
import '../widgets/resting_model_words.dart';
import 'api_connections_controller.dart';
import 'local_model.dart';
import 'model_manager_controller.dart';

enum ModelSearchSection {
  subscriptions('Subscriptions'),
  apis('APIs'),
  local('Your local AI models'),
  shared('Shared with you');

  const ModelSearchSection(this.label);
  final String label;
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
  final Map<String, Object?>? subscription;
  final List<String> searchAliases;
  final ModelManagerController? controller;
  final bool own;
  final GridModel? gridModel;
  final String? sharedBy;

  ModelSearchSection get section => subscription != null
      ? ModelSearchSection.subscriptions
      : api != null
      ? ModelSearchSection.apis
      : own
      ? ModelSearchSection.local
      : ModelSearchSection.shared;

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
    title: sharedBy?.isNotEmpty == true ? '$name · $sharedBy' : name,
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
      ...searchAliases,
    ],
  );
}

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
  Map<String, ModelSearchEntry> entries = {};
  List<SwarmDestination> rows = const [];

  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
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
          machine.isLocalMachine ||
          machine.machine.isShared) {
        _hosts.remove(id)!.dispose();
        _managedRowIds.removeWhere((key, _) => key.startsWith('$id:'));
      }
    }
    if (_visible) {
      for (final machine in machines.values) {
        final id = machine.machine.machineId;
        if (machine.isLocalMachine ||
            machine.machine.isShared ||
            _hosts.containsKey(id)) {
          continue;
        }
        final controller = ModelManagerController(
          manager.app,
          targetMachineId: id,
          poll: manager.poll && pollHosts,
        );
        _hosts[id] = controller;
        controller.addListener(_refresh);
        controller.setPanelVisible(true);
        controller.start();
      }
    }
    _refresh();
  }

  Future<void> refresh({bool force = false}) async {
    _machinesChanged();
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
    return host.isLocalMachine ? manager : _hosts[host.machine.machineId];
  }

  String _managedKey(ModelManagerController owner, LocalModel model) =>
      '${owner.machine?.machine.machineId}:${model.id}';

  void _refresh() {
    final discovered = <ModelSearchEntry>[];
    final served = <String, GridModel>{};
    for (final section in manager.sections) {
      for (final model in section.models) {
        final owner = section.own ? _hostFor(model.node) : null;
        final matches =
            owner?.localModels
                .where(
                  (local) =>
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
            searchAliases: [model.node, if (section.own) 'local'],
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
    final local = [
      for (final owner in [manager, ..._hosts.values])
        for (final model in owner.localModels) (owner: owner, model: model),
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
      final name = a.model.name.compareTo(b.model.name);
      if (name != 0) return name;
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
    final all = [
      for (final (:owner, :model) in local)
        ModelSearchEntry(
          id: _managedRowIds.putIfAbsent(
            _managedKey(owner, model),
            () => (identical(owner, manager)
                ? 'model:local:${model.id}'
                : 'model:machine:${_managedKey(owner, model)}'),
          ),
          name: model.displayName,
          source: 'Local',
          node: owner.machine?.machine.displayName,
          status: localStatus(model, controller: owner),
          local: model,
          own: true,
          controller: owner,
          gridModel: served[_managedKey(owner, model)],
          searchAliases: [?owner.machine?.machine.hostname],
        ),
      ...discovered.where((entry) => entry.own),
      ...discovered.where((entry) => !entry.own),
      for (final row in subscriptions.rows)
        ModelSearchEntry(
          id: 'model:subscription:${row['engine']}:${row['title']}:${row['account']}',
          name: [
            '${row['title'] ?? 'Subscription'}',
            if ('${row['account'] ?? ''}'.isNotEmpty) '${row['account']}',
          ].join(' · '),
          source: 'Subscription',
          status: '${row['status'] ?? 'Usage unavailable'}',
          subscription: row,
        ),
      for (final api in manager.apis.connections)
        ModelSearchEntry(
          id: 'model:api:${api.id}',
          name: api.name,
          source: 'API',
          status: api.host,
          api: api,
        ),
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
        : 'Available';
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
