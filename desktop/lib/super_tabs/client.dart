import 'dart:async';
import 'dart:convert';

import '../core/local_key_value_store.dart';
import 'attachment_upload.dart';
import 'controller.dart';
import 'model.dart';
import 'notifications.dart';

typedef SuperTabTransport = Future<Object?> Function(
  String method,
  String path, {
  Map<String, dynamic>? body,
});

typedef SuperTabListing = ({String id, String name});

/// Account-scoped client state. Backend membership never comes from the saved
/// layout, and a late response cannot cross an account change.
class SuperTabClient {
  SuperTabClient({
    required this.transport,
    required this.storage,
    this.onSnapshot,
    this.onTabs,
    this.onSelection,
    this.onMention,
    this.upload = refuseUpload,
    this.discoveryInterval = const Duration(seconds: 15),
  });
  final SuperTabTransport transport;
  final LocalKeyValueStore storage;
  final void Function(SuperTabController)? onSnapshot;
  final void Function(List<SuperTabListing>, Set<String> hidden)? onTabs;

  /// A tab's selected conversation changed, by a click here or by a device.
  final void Function(SuperTabController)? onSelection;

  /// A Lead tagged this account in an open Swarm while the app was open.
  final void Function(SuperTabMention)? onMention;
  final SuperTabUpload upload;
  final Duration discoveryInterval;
  String? _account;
  int _generation = 0;
  Timer? _discoveryTimer;
  Future<void>? _discovering, _loadingHidden;
  Future<void> _savingHidden = Future.value();
  Set<String> _hidden = {};
  final _creating = <String>{};
  final _visibility = <String, bool>{};
  Object? discoveryError;
  final _controllers = <String, Future<SuperTabController>>{};
  final _loaded = <String, SuperTabController>{};
  SuperTabController? peek(String id) => _loaded[id];
  Iterable<SuperTabController> get loadedControllers => _loaded.values;

  /// Native close actions name the machine's harness id, not the Swarm agent id.
  String? leadProtectionReasonForHarness(String machineId, String harnessId) {
    for (final controller in loadedControllers) {
      final snapshot = controller.snapshot;
      if (snapshot == null) continue;
      for (final agent in snapshot.agents) {
        if (agent.machineId != machineId || agent.harnessId != harnessId) {
          continue;
        }
        if (snapshot.leadProtectionReason(agent.id) case final reason?) {
          return reason;
        }
      }
    }
    return null;
  }

  /// The tabs closed on this computer. Only discovery says which of them the
  /// account still belongs to.
  Set<String> get hiddenIds => Set.unmodifiable(_hidden);

  void bind(String? account) {
    if (_account == account) return;
    _account = account;
    _generation++;
    _discoveryTimer?.cancel();
    _discovering = null;
    _loadingHidden = null;
    _hidden = {};
    _creating.clear();
    _visibility.clear();
    discoveryError = null;
    for (final controller in _loaded.values) {
      controller.revokeAccess('The account changed. Open this Swarm again.');
    }
    for (final future in _controllers.values) {
      unawaited(
        future
            .then((c) async {
              c.dispose();
              await c.flush();
            })
            .catchError((Object _) {}),
      );
    }
    _controllers.clear();
    _loaded.clear();
    if (account != null &&
        onTabs != null &&
        discoveryInterval > Duration.zero) {
      unawaited(refreshTabs());
      _discoveryTimer = Timer.periodic(
        discoveryInterval,
        (_) => unawaited(refreshTabs()),
      );
    }
  }

  Future<void> _readHidden(String account, int generation) =>
      _loadingHidden ??= () async {
        final raw = await storage.read('super_tab.hidden.$account');
        if (generation != _generation) return;
        _hidden = raw == null
            ? <String>{}
            : (jsonDecode(raw) as List).whereType<String>().toSet();
        for (final entry in _visibility.entries) {
          if (entry.value) {
            _hidden.remove(entry.key);
          } else {
            _hidden.add(entry.key);
          }
        }
      }();

  /// Closing a tab hides its view on this computer. Membership and running
  /// agents stay on the backend; another computer still discovers that tab.
  Future<void> setTabVisible(String id, bool visible) async {
    final account = _account;
    final generation = _generation;
    if (account == null) return;
    if (visible) _creating.remove(id);
    _visibility[id] = visible;
    if (visible) {
      _hidden.remove(id);
    } else {
      _hidden.add(id);
    }
    await _readHidden(account, generation);
    if (generation != _generation) return;
    final saved = jsonEncode(_hidden.toList()..sort());
    final write = _savingHidden
        .catchError((Object _) {})
        .then((_) => storage.write('super_tab.hidden.$account', saved));
    _savingHidden = write;
    await write;
  }

  /// The lead form already represents a creation in flight on this computer.
  /// Its backend row can arrive through discovery before the lead is ready.
  void deferTabDiscovery(String id) => _creating.add(id);

  /// Discovery is account membership, independent of this computer's saved
  /// layout. Read every page before applying; a failed page cannot drop tabs.
  Future<void> refreshTabs() {
    if (_account == null || onTabs == null) return Future.value();
    if (_discovering case final active?) return active;
    final generation = _generation;
    final account = _account!;
    final read = () async {
      try {
        await _readHidden(account, generation);
        if (generation != _generation) return;
        final tabs = <String, SuperTabListing>{};
        final cursors = <String>{};
        String? after;
        do {
          final page = await map(
            'GET',
            '/api/super-tabs${after == null ? '' : '?after=${Uri.encodeComponent(after)}'}',
          );
          if (generation != _generation) return;
          if (page['tabs'] is! List) {
            throw const FormatException('Missing tabs');
          }
          for (final raw in page['tabs'] as List) {
            final row = superTabMap(raw);
            if (row['id'] is! String || row['name'] is! String) {
              throw const FormatException('Invalid tab');
            }
            final id = row['id'] as String;
            tabs[id] = (id: id, name: row['name'] as String);
          }
          after = page['next'] as String?;
          if (after != null && !cursors.add(after)) {
            throw const FormatException('Repeated tab cursor');
          }
        } while (after != null);
        discoveryError = null;
        onTabs!(
          tabs.values.toList(),
          Set.unmodifiable({..._hidden, ..._creating}),
        );
      } catch (error) {
        if (generation == _generation) {
          discoveryError = error;
          _loadingHidden = null;
        }
      }
    }();
    _discovering = read;
    return read.whenComplete(() {
      if (identical(_discovering, read)) _discovering = null;
    });
  }

  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (_account == null) {
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to use Swarm.');
    }
    final generation = _generation;
    final result = await transport(method, path, body: body);
    if (generation != _generation) {
      throw const SuperTabFailure(
        'ACCOUNT_CHANGED',
        'The account changed. Open this Swarm again.',
      );
    }
    return result;
  }

  Future<Map<String, dynamic>> map(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async => superTabMap(await request(method, path, body: body));

  Future<SuperTabController> open(String id) =>
      _controllers.putIfAbsent(id, () {
        final generation = _generation;
        return _open(id).catchError((Object failure, StackTrace stack) {
          if (_generation == generation) _controllers.remove(id);
          Error.throwWithStackTrace(failure, stack);
        });
      });

  Future<SuperTabController> _open(String id) async {
    final account = _account;
    final generation = _generation;
    if (account == null) {
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to use Swarm.');
    }
    final key = 'super_tab.$account.$id';
    final raw = await storage.read(key);
    if (generation != _generation) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
    final saved = raw == null
        ? <String, dynamic>{}
        : superTabMap(jsonDecode(raw));
    final controller = SuperTabController(
      tabId: id,
      accountId: account,
      initial: saved,
      request: (method, path, {body}) {
        if (generation != _generation) {
          throw const SuperTabFailure('FORBIDDEN', 'The account changed.');
        }
        return map(method, path, body: body);
      },
      save: (state) => storage.write(key, jsonEncode(state)),
      upload: upload,
    );
    var seenRevision = -1;
    var seenSelected = controller.selectedId;
    controller.addListener(() {
      if (controller.selectedId != seenSelected) {
        seenSelected = controller.selectedId;
        onSelection?.call(controller);
      }
      if (controller.snapshot != null && controller.revision != seenRevision) {
        seenRevision = controller.revision;
        onSnapshot?.call(controller);
      }
    });
    if (onMention case final notify?) {
      SuperTabMentions.of(controller).onArrived = notify;
    }
    _loaded[id] = controller;
    controller.start();
    return controller;
  }

  void dispose() => bind(null);
}
