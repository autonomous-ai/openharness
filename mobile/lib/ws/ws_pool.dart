import 'dart:async';

import 'relay_codec.dart';
import 'terminal_transport_plugin.dart';

import '../core/models.dart';
import '../logging/app_log.dart';
import 'ws_conn.dart';

/// Owns one SSO-authenticated [WsConn] per machine.
class WsPool {
  final WsChannelFactory? connectChannel;
  final String wsBaseUrl;
  final String autonomousEnv;

  /// Handed to every relay connection — a viewer build's E2EE sessions (see [RelayCodec]).
  final RelayCodecFactory? relayCodecs;

  /// Handed to every relay connection beside [relayCodecs] — a viewer build's second
  /// wire to the machine (see [TerminalTransportPlugin]).
  final TerminalTransportPluginFactory? transportPlugins;
  final AccessTokenProvider accessTokenProvider;
  final void Function(String message) onAuthFailure;
  final void Function(String machineId, int code, String reason)?
  onLocalFailure;
  final FutureOr<void> Function(String machineId, Map<String, dynamic> event)
  onEvent;
  final void Function(String machineId, ConnectionStatus status) onStatus;

  final Map<String, WsConn> _conns = {};

  WsPool({
    required this.wsBaseUrl,
    this.connectChannel,
    required this.autonomousEnv,
    this.relayCodecs,
    this.transportPlugins,
    required this.accessTokenProvider,
    required this.onAuthFailure,
    this.onLocalFailure,
    required this.onEvent,
    required this.onStatus,
  });

  WsConn connFor(String machineId) {
    final desiredKey = 'cloud:$wsBaseUrl:$autonomousEnv';
    final current = _conns[machineId];
    if (current != null &&
        current.endpointKey == desiredKey &&
        !current.isClosed) {
      return current;
    }
    if (current != null) {
      // Replacing a live connection is a real event — it closes a socket and
      // starts a fresh handshake — and it used to leave no trace at all, which
      // made a launch that did it twice impossible to read in the log.
      appLog.warn(
        'ws',
        'replacing connection $machineId '
            '(was ${current.endpointKey}, now $desiredKey)',
      );
      unawaited(current.close());
    }
    // ⚠️ Once another connection holds this machine, this one speaks for nothing. A connection's
    // last word — the `disconnected` from its socket closing — can land after its successor has
    // come up, and it marked that working connection's machine as lost ("Connection lost.
    // Reconnecting…"). The desktop's pool shuts a replaced connection up the same way. One that
    // was only closed, with nothing in its place yet, still reports its end: the app reads it.
    late final WsConn conn;
    bool replaced() {
      final owner = _conns[machineId];
      return owner != null && !identical(owner, conn);
    }

    conn = WsConn(
      wsBaseUrl: wsBaseUrl,
      connectChannel: connectChannel,
      autonomousEnv: autonomousEnv,
      relayCodecs: relayCodecs,
      transportPlugins: transportPlugins,
      machineId: machineId,
      accessTokenProvider: accessTokenProvider,
      onAuthFailure: (message) {
        if (!replaced()) onAuthFailure(message);
      },
      onLocalFailure: onLocalFailure == null
          ? null
          : (code, reason) {
              if (!replaced()) onLocalFailure!(machineId, code, reason);
            },
      onEvent: (event) {
        if (!replaced()) return onEvent(machineId, event);
      },
      onStatus: (status) {
        if (!replaced()) onStatus(machineId, status);
      },
    );
    _conns[machineId] = conn;
    unawaited(conn.connect());
    return conn;
  }

  WsConn? operator [](String machineId) => _conns[machineId];
  bool has(String machineId) => _conns.containsKey(machineId);

  /// Dials every machine that is not currently connected, without waiting out its backoff — see
  /// [WsConn.reconnectNow], which decides per connection whether there is anything to do.
  ///
  /// The whole pool, not just the machine on screen: a phone comes back to a list of machines, and
  /// one that reconnects only when tapped reads as broken until it is.
  void reconnectAll() {
    for (final conn in _conns.values) {
      conn.reconnectNow();
    }
  }

  Future<void> closeMachine(String machineId) async {
    final conn = _conns.remove(machineId);
    if (conn != null) {
      // Closing a machine's socket is deliberate and rare — a machine leaving
      // the account, a re-link, a sign-out — so it is worth a line. A close that
      // lands mid-dial looks, from inside `connect()`, exactly like being
      // superseded, and without this there was no way to tell the two apart.
      appLog.warn('ws', 'closeMachine $machineId');
      await conn.close();
    }
  }

  Future<void> closeAll() async {
    final all = _conns.values.toList();
    _conns.clear();
    for (final conn in all) {
      await conn.close();
    }
  }
}
