import 'dart:async';
import 'dart:convert';

import '../core/local_key_value_store.dart';
import 'controller.dart';
import 'model.dart';

typedef SuperTabTransport = Future<Object?> Function(
  String method,
  String path, {
  Map<String, dynamic>? body,
});

/// Account-scoped client state. Backend membership never comes from the saved
/// layout, and a late response cannot cross an account change.
class SuperTabClient {
  SuperTabClient({
    required this.transport,
    required this.storage,
    this.onSnapshot,
  });
  final SuperTabTransport transport;
  final LocalKeyValueStore storage;
  final void Function(SuperTabController)? onSnapshot;
  String? _account;
  int _generation = 0;
  final _controllers = <String, Future<SuperTabController>>{};
  final _loaded = <String, SuperTabController>{};
  SuperTabController? peek(String id) => _loaded[id];

  void bind(String? account) {
    if (_account == account) return;
    _account = account;
    _generation++;
    for (final controller in _loaded.values) {
      controller.revokeAccess(
        'The account changed. Open this Super Tab again.',
      );
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
  }

  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (_account == null) {
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to use Super Tab.');
    }
    final generation = _generation;
    final result = await transport(method, path, body: body);
    if (generation != _generation) {
      throw const SuperTabFailure(
        'ACCOUNT_CHANGED',
        'The account changed. Open this Super Tab again.',
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
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to use Super Tab.');
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
    );
    var seenRevision = -1;
    controller.addListener(() {
      if (controller.snapshot != null && controller.revision != seenRevision) {
        seenRevision = controller.revision;
        onSnapshot?.call(controller);
      }
    });
    _loaded[id] = controller;
    controller.start();
    return controller;
  }

  void dispose() => bind(null);
}
