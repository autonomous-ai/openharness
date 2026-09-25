import 'package:flutter/foundation.dart';

import '../state/swarm_navigation.dart';
import '../usage/models_menu_controller.dart';
import 'api_connections_controller.dart';
import 'local_model.dart';
import 'model_manager_controller.dart';

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
  });
  final String id, name, source, status;
  final String? node;
  final LocalModel? local;
  final ApiConnection? api;
  final Map<String, Object?>? subscription;

  late final destination = SwarmDestination(
    id: id,
    modelId: id,
    title: name,
    detail: [source, node, status].whereType<String>().join(' · '),
    swarmId: null,
    current: false,
    searchFields: [source, node, status, local?.id, api?.host],
  );
}

class ModelSearchCatalog extends ChangeNotifier {
  ModelSearchCatalog(this.manager, this.subscriptions) {
    manager.addListener(_refresh);
    manager.apis.addListener(_refresh);
    subscriptions.addListener(_refresh);
    _refresh();
  }
  final ModelManagerController manager;
  final ModelsMenuController subscriptions;
  Map<String, ModelSearchEntry> entries = {};
  List<SwarmDestination> rows = const [];

  void _refresh() {
    final local = manager.localModels.toList();
    int rank(LocalModel model) => manager.operationFor(model)?.active == true
        ? 0
        : model.running
        ? 1
        : model.downloaded
        ? 2
        : 3;
    local.sort((a, b) {
      final state = rank(a).compareTo(rank(b));
      return state != 0 ? state : a.name.compareTo(b.name);
    });
    final all = [
      for (final model in local)
        ModelSearchEntry(
          id: 'model:local:${model.id}',
          name: model.name,
          source: 'Local',
          node: manager.machine?.machine.displayName,
          status: localStatus(model),
          local: model,
        ),
      for (final section in manager.sections.where((section) => !section.own))
        for (final model in section.models)
          ModelSearchEntry(
            id: 'model:shared:${section.name}:${model.node}:${model.id}',
            name: model.id,
            source: 'Shared · ${section.name}',
            node: model.node,
            status: manager.models?.reachable == false
                ? 'Unavailable'
                : 'Available',
          ),
      for (final row in subscriptions.rows)
        ModelSearchEntry(
          id: 'model:subscription:${row['engine']}:${row['title']}:${row['account']}',
          name: '${row['title'] ?? 'Subscription'}',
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
    entries = {for (final entry in all) entry.id: entry};
    rows = [for (final entry in all) entry.destination];
    notifyListeners();
  }

  String localStatus(LocalModel model) {
    final operation = manager.operationFor(model);
    if (operation?.active == true) {
      final progress = operation!.progress;
      return '${operation.label}${progress == null ? '' : ' ${(progress * 100).floor()}%'}';
    }
    if (manager.pendingId == model.id) {
      return manager.pendingStart ? 'Starting' : 'Stopping';
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
    manager.removeListener(_refresh);
    manager.apis.removeListener(_refresh);
    subscriptions.removeListener(_refresh);
    super.dispose();
  }
}
