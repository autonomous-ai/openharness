import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/models.dart';
import '../state/app_state.dart';
import '../ws/ws_conn.dart';

/// The UI retains public metadata only. Keys travel once to the selected daemon;
/// replies, preferences, and provider rows never contain them.
class ApiConnection {
  const ApiConnection(this.data);
  final Map<String, dynamic> data;
  String get id => data['id'] as String? ?? '';
  String get provider => data['provider'] as String? ?? 'custom';
  String get name => data['name'] as String? ?? '';
  String get baseUrl => data['baseUrl'] as String? ?? '';
  String get host => Uri.tryParse(baseUrl)?.host ?? baseUrl;
  String get keyEnv => data['keyEnv'] as String? ?? '';
  String get authHeader => data['authHeader'] as String? ?? 'Authorization';
  String get authPrefix => data['authPrefix'] as String? ?? 'Bearer';
  String? get keyUrl => data['keyUrl'] as String?;

  /// Coding agents authenticate to a custom endpoint only as `Authorization: Bearer <key>`, so only
  /// such an API can list models to run a harness on (the CLI's `servesModels`).
  bool get servesModels =>
      authHeader.toLowerCase() == 'authorization' &&
      authPrefix.toLowerCase() == 'bearer';
  bool matches(String query) =>
      '$name $baseUrl'.toLowerCase().contains(query.toLowerCase());

  factory ApiConnection.fromJson(Map<String, dynamic> json) => ApiConnection({
    for (final key in [
      'id',
      'provider',
      'name',
      'baseUrl',
      'keyEnv',
      'authHeader',
      'authPrefix',
      'keyUrl',
      'docsUrl',
    ])
      if (json[key] is String) key: json[key],
  });
}

/// One chat model a saved API lists — no key, only what the API says about the model.
class ApiModel {
  const ApiModel({required this.id, this.name, this.contextWindow});
  final String id;
  final String? name;
  final int? contextWindow;

  static ApiModel? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final id = json['id'];
    if (id is! String || id.trim().isEmpty) return null;
    final name = json['name'];
    final window = json['contextWindow'];
    return ApiModel(
      id: id,
      name: name is String && name.trim().isNotEmpty ? name : null,
      contextWindow: window is int && window > 0 ? window : null,
    );
  }
}

/// What reading one API's models answered: the list, or why there is none.
class ApiModels {
  const ApiModels({this.models = const [], this.loading = false, this.error});
  final List<ApiModel> models;
  final bool loading;
  final String? error;
}

class ApiConnectionsController extends ChangeNotifier {
  ApiConnectionsController(this.app, {String? machineId})
    : _machineId =
          machineId ??
          (app.viewer == null
              ? null
              : app.ownedActionMachine?.machine.machineId) {
    app.addListener(_observe);
    _owner = _target;
    _connected = available;
  }
  final AppNotifier app;
  String? _machineId;
  MachineState? get _target {
    if (_machineId != null) return app.stateOf(_machineId!);
    if (app.viewer == null) return app.localMachineState;
    final machine = app.ownedActionMachine;
    _machineId = machine?.machine.machineId;
    return machine;
  }

  /// The machine these APIs are saved on — the only one whose harnesses can run on their models.
  String? get machineId => _owner?.machine.machineId;

  String get hostLabel => app.viewer == null && _machineId == null
      ? 'this computer'
      : _owner?.machine.displayName ?? 'a connected machine';
  String get _connectMessage => 'Connect $hostLabel to manage APIs.';

  /// Called between panels, never while an API editor is open.
  void useMachine(String machineId) {
    if (_disposed || saving || machineId == _machineId) return;
    _machineId = machineId;
    _observe();
  }

  MachineState? _owner;
  bool _disposed = false;
  bool _connected = false;
  int _revision = 0;
  List<ApiConnection> connections = [], presets = [];
  bool loading = false, saving = false, loaded = false;
  String? error;

  /// Each saved API's chat models, by connection id, read while a model list is on screen
  /// ([loadModels]). An API that takes no Bearer key has no entry: it is for tools only.
  final Map<String, ApiModels> models = {};
  bool _modelsWanted = false;
  int _modelsRevision = 0;

  bool get available =>
      _owner != null &&
      !_owner!.machine.isShared &&
      !_owner!.needsLink &&
      _owner!.nodeOnline != false &&
      _owner!.connectionStatus == ConnectionStatus.connected;
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _observe() {
    if (identical(_owner, _target)) {
      if (_connected != available) {
        _connected = available;
        if (!_connected) error = _connectMessage;
        _changed();
        if (_connected) unawaited(refresh());
      }
      return;
    }
    _owner = _target;
    _connected = available;
    _revision++;
    _modelsRevision++;
    connections = [];
    presets = [];
    models.clear();
    loading = saving = loaded = false;
    error = null;
    unawaited(refresh());
  }

  /// Read the models of every saved API that can run a harness, and keep reading them as APIs are
  /// saved while [wanted] — a model list is on screen. Lists the CLI already holds come back at once.
  void loadModels({bool wanted = true, bool reread = false}) {
    _modelsWanted = wanted;
    if (!wanted) return;
    // The picker can open before anything read the saved APIs; that read loads models when it lands.
    if (!loaded) {
      if (!loading && available) unawaited(refresh());
      return;
    }
    for (final connection in connections) {
      if (!connection.servesModels) continue;
      final known = models[connection.id];
      if (!reread && known != null && (known.loading || known.error == null)) {
        continue;
      }
      unawaited(_loadModels(connection, reread: reread));
    }
  }

  Future<void> _loadModels(
    ApiConnection connection, {
    required bool reread,
  }) async {
    final owner = _owner;
    if (_disposed || owner == null || !available) return;
    final revision = _modelsRevision;
    final previous = models[connection.id]?.models ?? const <ApiModel>[];
    models[connection.id] = ApiModels(models: previous, loading: true);
    _changed();
    ApiModels answer;
    try {
      final reply = await app.apiConnections(owner.machine.machineId, {
        'action': 'models',
        'id': connection.id,
        if (reread) 'refresh': true,
      }, timeout: const Duration(seconds: 25));
      final rows = reply['models'];
      answer = rows is List
          ? ApiModels(
              models: rows
                  .map(ApiModel.fromJson)
                  .whereType<ApiModel>()
                  .toList(),
            )
          : const ApiModels(
              error: 'Update Harness on this computer to use API models.',
            );
    } on WsRequestFailure catch (failure) {
      answer = ApiModels(
        models: previous,
        // An older CLI answers the unknown action with its generic failure.
        error: failure.code == 'API_CONNECTIONS_FAILED'
            ? 'Update Harness on this computer to use API models.'
            : failure.detail ?? 'Models are unavailable. Try again.',
      );
    } catch (_) {
      answer = ApiModels(
        models: previous,
        error: 'Models are unavailable. Try again.',
      );
    }
    if (_disposed ||
        revision != _modelsRevision ||
        !connections.any((row) => row.id == connection.id)) {
      return;
    }
    models[connection.id] = answer;
    _changed();
  }

  Future<bool> refresh() => _request({'action': 'list'});
  Future<bool> save(Map<String, dynamic> connection) =>
      _request({'action': 'save', 'connection': connection});
  Future<bool> remove(String id) => _request({'action': 'remove', 'id': id});

  Future<bool> _request(Map<String, dynamic> payload) async {
    if (_disposed || saving) return false;
    final owner = _owner;
    if (owner == null || !available) {
      error = _connectMessage;
      _changed();
      return false;
    }
    final revision = ++_revision;
    final mutation = payload['action'] != 'list';
    loading = true;
    saving = mutation;
    error = null;
    _changed();
    bool current() =>
        !_disposed && revision == _revision && identical(owner, _target);
    try {
      final answer = await app.apiConnections(owner.machine.machineId, payload);
      if (!current()) return false;
      if (answer['error'] != null) {
        error =
            answer['detail'] as String? ?? 'APIs are unavailable. Try again.';
        return false;
      }
      if (answer['connections'] is! List || answer['presets'] is! List) {
        error = 'Update Harness on $hostLabel to connect APIs.';
        return false;
      }
      List<ApiConnection> rows(String key) => (answer[key] as List)
          .whereType<Map<String, dynamic>>()
          .map(ApiConnection.fromJson)
          .toList();
      connections = rows('connections');
      presets = rows('presets');
      loaded = true;
      // A saved key or URL may list different models; the CLI answers unchanged APIs from memory.
      if (mutation) {
        _modelsRevision++;
        models.clear();
      } else {
        models.removeWhere(
          (id, _) =>
              !connections.any((row) => row.id == id && row.servesModels),
        );
      }
      // After this request settles: [_loadModels] waits for no request, but reads [connections].
      if (_modelsWanted) {
        scheduleMicrotask(() {
          if (!_disposed && _modelsWanted) loadModels();
        });
      }
      return true;
    } on WsRequestFailure catch (failure) {
      if (current()) {
        error = failure.detail ?? 'APIs are unavailable. Try again.';
      }
      return false;
    } catch (_) {
      if (current()) {
        error = mutation
            ? 'Could not confirm the change. Go back and refresh.'
            : 'APIs are unavailable. Try again.';
      }
      return false;
    } finally {
      if (current()) {
        loading = saving = false;
        _changed();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    app.removeListener(_observe);
    super.dispose();
  }
}

/// Whether [agent] already runs on [modelId] through [api]: its model, at that API's endpoint in
/// either form an engine is handed (with `/v1`, or without it for Claude Code).
bool agentOnApiModel(Agent? agent, ApiConnection api, String modelId) {
  final base = agent?.gridBaseUrl;
  if (agent?.gridModel != modelId || base == null) return false;
  String root(String url) =>
      url.replaceFirst(RegExp(r'/+$'), '').replaceFirst(RegExp(r'/v1$'), '');
  return root(base) == root(api.baseUrl);
}

/// A context window as people say it: `64K`, `128K` (binary sizes), `200K`, `1M`.
String contextWindowLabel(int tokens) {
  if (tokens >= 1000000) {
    final millions = (tokens / 1000000).toStringAsFixed(1);
    return '${millions.endsWith('.0') ? millions.substring(0, millions.length - 2) : millions}M';
  }
  return tokens % 1024 == 0
      ? '${tokens ~/ 1024}K'
      : '${(tokens / 1000).round()}K';
}

/// What is wrong with [text] as an API's URL, in words that say how to fix it, or null when it is
/// one: a full `http(s)` address with a host, and nothing the key or a request belongs in.
String? apiUrlProblem(String text) {
  final value = text.trim();
  if (value.isEmpty) return "Enter the API's URL.";
  final url = Uri.tryParse(value);
  if (url == null ||
      !['http', 'https'].contains(url.scheme) ||
      url.host.isEmpty) {
    return 'Enter the full URL, starting with https://, '
        'for example https://openrouter.ai/api/v1.';
  }
  if (url.userInfo.isNotEmpty) {
    return 'Take the username or password out of the URL. The key has its own field.';
  }
  if (url.hasQuery || url.hasFragment) {
    return 'Take the ? or # part off the end of the URL.';
  }
  return null;
}
