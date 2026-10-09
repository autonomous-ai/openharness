import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/open_in_browser.dart';
import '../state/app_state.dart';

/// One service on Settings ▸ Connectors, as this computer's daemon reports it
/// (`connectors` `list`, cli/src/lib/connectors/connect.ts `cards`).
@immutable
class ConnectorCard {
  const ConnectorCard({
    required this.code,
    required this.name,
    required this.description,
    required this.state,
    this.account = '',
    this.auth = 'dcr',
    this.custom = false,
    this.reason = '',
    this.tools = false,
  });

  factory ConnectorCard.fromJson(Map<String, dynamic> json) => ConnectorCard(
    code: json['connector'] as String? ?? '',
    name: json['name'] as String? ?? '',
    description: json['description'] as String? ?? '',
    state: json['state'] as String? ?? 'not_connected',
    account: json['account'] as String? ?? '',
    auth: json['auth'] as String? ?? 'dcr',
    custom: json['custom'] == true,
    reason: json['reason'] as String? ?? '',
    tools: json['tools'] == true,
  );

  final String code;
  final String name;
  final String description;

  /// `not_connected`, `connected` or `reconnect`.
  final String state;
  final String account;

  /// `dcr` (signs in from this computer), `app` (through the Harness account) or `custom`.
  final String auth;
  final bool custom;

  /// Why it cannot be connected now ("Needs harness login"), or empty.
  final String reason;

  /// Whether agents get it as MCP tools (else only `harness connections call`).
  final bool tools;

  bool get connected => state != 'not_connected';
}

/// Settings ▸ Connectors: this computer's connected services, through its
/// daemon. A sign-in opens the service's consent page in the browser and is
/// followed until it finishes; the list itself never leaves the app.
class ConnectorsController extends ChangeNotifier {
  ConnectorsController(this.app, {this.machineId});

  final AppNotifier app;

  /// The computer whose connections these are; this one by default.
  final String? machineId;

  /// How often a sign-in in progress is asked about, and for how long.
  @visibleForTesting
  static Duration pollEvery = const Duration(seconds: 1);
  static const _signInFor = Duration(minutes: 6);

  List<ConnectorCard> cards = const [];
  bool signedIn = true;
  bool loading = false;
  String? error;
  String notice = '';
  final Set<String> pending = {};
  bool _disposed = false;

  String? get _target => machineId ?? app.localMachineState?.machine.machineId;

  Future<Map<String, dynamic>> _ask(Map<String, dynamic> payload) async {
    final target = _target;
    if (target == null) throw StateError('This computer is not connected yet.');
    final answer = await app.connectors(target, payload);
    final failure = answer['error'];
    if (failure != null) {
      throw _Refused(
        answer['detail'] as String? ??
            (failure == 'SERVICE_UNAVAILABLE' || failure == 'UNSUPPORTED'
                ? 'Update Harness on this computer to use Connectors.'
                : 'Connections are unavailable. Try again.'),
      );
    }
    return answer;
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> refresh() async {
    loading = true;
    _changed();
    try {
      final answer = await _ask({'action': 'list'});
      cards = [
        for (final row in (answer['connections'] as List? ?? const []))
          if (row is Map) ConnectorCard.fromJson(row.cast<String, dynamic>()),
      ]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      signedIn = answer['signed_in'] != false;
      error = null;
    } catch (e) {
      error = _message(e);
    } finally {
      loading = false;
      _changed();
    }
  }

  Future<void> connect(ConnectorCard card) async {
    notice = '';
    pending.add(card.code);
    _changed();
    try {
      final started = await _ask({'action': 'connect', 'connector': card.code});
      await _follow(card.name, started);
    } catch (e) {
      notice = '${card.name}: ${_message(e)}';
    } finally {
      pending.remove(card.code);
      await refresh();
      // Back from the browser, the link to the computer may still be coming back: the card shows the
      // new connection as soon as it answers, not on the next manual refresh.
      for (var i = 0; error != null && !_disposed && i < 5; i++) {
        await Future<void>.delayed(pollEvery);
        await refresh();
      }
    }
  }

  Future<void> _follow(String name, Map<String, dynamic> started) async {
    final url = started['authorize_url'] as String?;
    if (url != null && !await openInBrowser(Uri.parse(url))) {
      notice = 'Open this address to sign in to $name: $url';
      _changed();
    }
    final flow = started['flow'] as String?;
    if (flow == null) return;
    final deadline = DateTime.now().add(_signInFor);
    Object? lastError;
    while (!_disposed && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(pollEvery);
      final Map<String, dynamic> status;
      try {
        status = await _ask({'action': 'flow', 'flow': flow});
      } on _Refused {
        rethrow;
      } catch (e) {
        // The link to the computer can drop for a moment while the person is in the browser signing in;
        // the sign-in goes on in the daemon all the same. Ask again rather than give up on it.
        lastError = e;
        continue;
      }
      if (status['state'] == 'connected') {
        notice = '$name connected. Your agents can use it now.';
        return;
      }
      if (status['state'] == 'failed') {
        // `reason`, not `error`: a reply carrying `error` never reaches here (WsConn reads it as a failure).
        notice = '$name: ${status['reason'] ?? 'The sign-in did not finish.'}';
        return;
      }
    }
    if (lastError != null) throw lastError;
  }

  Future<void> disconnect(ConnectorCard card) async {
    try {
      await _ask({'action': 'disconnect', 'connector': card.code});
      notice = '${card.name} disconnected on this computer.';
    } catch (e) {
      notice = _message(e);
    }
    await refresh();
  }

  /// Add custom: null when added (or its sign-in started), else why not.
  Future<String?> addCustom(
    String name,
    String url,
    Map<String, String> headers,
  ) async {
    try {
      final started = await _ask({
        'action': 'custom',
        'name': name,
        'url': url,
        'headers': headers,
      });
      if (started['flow'] != null) {
        unawaited(
          _follow(name, started)
              .catchError((Object e) {
                notice = '$name: ${_message(e)}';
              })
              .whenComplete(refresh),
        );
      } else {
        notice = '$name added. Your agents can use it now.';
        await refresh();
      }
      return null;
    } catch (e) {
      return _message(e);
    }
  }

  static String _message(Object e) => switch (e) {
    _Refused(:final message) => message,
    StateError(:final message) => message,
    _ => 'Connections are unavailable. Try again.',
  };

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// The computer answered, and said no: a reason to stop, unlike a request that did not get through.
class _Refused implements Exception {
  const _Refused(this.message);

  final String message;

  @override
  String toString() => message;
}
