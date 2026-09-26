import 'dart:async';

import 'local_daemon_transport.dart';
import 'relay_codec.dart';
import 'terminal_transport_plugin.dart';

import '../core/models.dart';
import 'ws_conn.dart';

/// Owns one SSO-authenticated [WsConn] per machine.
class WsPool {
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

  /// How local connections reach the daemon — its socket or the loopback
  /// port. Null keeps the port.
  final LocalDaemonTransport? localTransport;

  WsPool({
    this.localTransport,
    required this.wsBaseUrl,
    required this.autonomousEnv,
    this.relayCodecs,
    this.transportPlugins,
    required this.accessTokenProvider,
    required this.onAuthFailure,
    this.onLocalFailure,
    required this.onEvent,
    required this.onStatus,
  });

  WsConn connFor(
    String machineId, {
    WsTransportKind transportKind = WsTransportKind.cloudE2ee,
    Uri? localWsUri,
    String? localApiKey,
    int localProtocolVersion = 1,
    Duration? fixedReconnectDelay,
  }) {
    // The reconnect policy is part of the key: a row that turns out to be this computer's after its
    // socket was made gets a new socket with the flat delay, not the old backoff.
    final desiredKey = transportKind == WsTransportKind.localPlaintext
        ? 'local:${localWsUri.toString()}:${fixedReconnectDelay?.inMilliseconds ?? 'backoff'}'
        : 'cloud:$wsBaseUrl:$autonomousEnv';
    final current = _conns[machineId];
    if (current != null &&
        current.endpointKey == desiredKey &&
        !current.isClosed) {
      return current;
    }
    // Stop accepting callbacks before close yields. Its final disconnected
    // event must not mark a replacement connection offline.
    _conns.remove(machineId);
    if (current != null) unawaited(current.close());
    late final WsConn conn;
    bool ownsMachine() => identical(_conns[machineId], conn);
    conn = WsConn(
      wsBaseUrl: wsBaseUrl,
      autonomousEnv: autonomousEnv,
      relayCodecs: transportKind == WsTransportKind.cloudE2ee
          ? relayCodecs
          : null,
      transportPlugins: transportKind == WsTransportKind.cloudE2ee
          ? transportPlugins
          : null,
      machineId: machineId,
      accessTokenProvider: accessTokenProvider,
      onAuthFailure: (message) {
        if (ownsMachine()) onAuthFailure(message);
      },
      onLocalFailure: onLocalFailure == null
          ? null
          : (code, reason) {
              if (ownsMachine()) onLocalFailure!(machineId, code, reason);
            },
      onEvent: (event) {
        if (ownsMachine()) return onEvent(machineId, event);
      },
      onStatus: (status) {
        if (ownsMachine()) onStatus(machineId, status);
      },
      transportKind: transportKind,
      localWsUri: localWsUri,
      localTransport: localTransport,
      localApiKey: localApiKey,
      localProtocolVersion: localProtocolVersion,
      fixedReconnectDelay: fixedReconnectDelay,
    );
    _conns[machineId] = conn;
    unawaited(conn.connect());
    return conn;
  }

  WsConn? operator [](String machineId) => _conns[machineId];

  /// The machines this pool holds a socket for. A snapshot, so a caller can send
  /// on each without a concurrent connect mutating what it is walking.
  List<String> get machineIds => _conns.keys.toList(growable: false);
  bool has(String machineId) => _conns.containsKey(machineId);

  Future<void> closeMachine(String machineId) async {
    final conn = _conns.remove(machineId);
    if (conn != null) await conn.close();
  }

  Future<void> closeAll() async {
    final all = _conns.values.toList();
    _conns.clear();
    // A failed close must not leave the other transports connected.
    await Future.wait(all.map((conn) => conn.close()));
  }
}
