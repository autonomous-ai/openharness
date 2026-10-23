import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:harness/e2ee/primitives.dart' show hmacSha256;
import 'package:harness/ws/windows_pipe.dart';

String _hex(List<int> bytes) =>
    [for (final b in bytes) b.toRadixString(16).padLeft(2, '0')].join();

String _mac(Uint8List token, int separator, String nonce) =>
    _hex(hmacSha256(token, [separator, ...utf8.encode(nonce)]));

final _auth = RegExp(r'^([0-9a-f]{64})\.([0-9a-f]{64})$');

/// A stand-in daemon for the pipe tests, on a Unix socket off Windows, as the
/// CLI's own tests stand one in for its pipe.
///
/// [trusted] serves as the daemon's pipe does (CLI `localSocket.ts`
/// `listenAuthenticated`): a request without a valid `x-harness-auth` for its
/// id gets a 401 without a proof, an upgrade without one is dropped, and every
/// other answer, the 101 included, carries the proof. [lies] answers every
/// request with a proof that is not the token's: whatever took a dead daemon's
/// name. Neither is the loopback port, which takes no auth and refuses what
/// needs trust, as the CLI's does.
///
/// Its WebSocket answers `machine_select` with `connected`, and `daemon_act`
/// as `localWsServer.ts` does: `UNSUPPORTED` from a trusted connection,
/// `LOCAL_SOCKET_REQUIRED` from any other.
class PipeDaemon {
  PipeDaemon._(
    this.server,
    this.id,
    this.token,
    this.trusted,
    this.lies,
    this.status,
    this.hangStatus,
  ) {
    server.listen(_serve);
  }

  final HttpServer server;

  /// The 32 hex digits its name ends with; empty for the loopback port.
  final String id;
  final Uint8List token;
  final bool trusted;
  final bool lies;
  final Map<String, dynamic>? status;
  final bool hangStatus;
  final hits = <String>[];
  final bodies = <String>[];
  final refused = <String>[];
  final _seen = <String>{};
  final _sockets = <WebSocket>[];
  var selects = 0;

  /// Where it listens, as the record names it.
  String get path => server.address.address;

  /// The daemon's pipe, named `harness-<id>` in [dir].
  static Future<PipeDaemon> pipe(
    Directory dir,
    Uint8List token, {
    String? id,
    bool lies = false,
    Map<String, dynamic>? status,
    bool hangStatus = false,
  }) async {
    final pipeId = id ?? _newId();
    return PipeDaemon._(
      await HttpServer.bind(
        InternetAddress(
          '${dir.path}/harness-$pipeId',
          type: InternetAddressType.unix,
        ),
        0,
      ),
      pipeId,
      token,
      !lies,
      lies,
      status,
      hangStatus,
    );
  }

  /// The daemon's loopback port.
  static Future<PipeDaemon> tcp() async => PipeDaemon._(
    await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
    '',
    Uint8List(32),
    false,
    false,
    null,
    false,
  );

  static String _newId() {
    final random = Random.secure();
    return _hex(List.generate(16, (_) => random.nextInt(256)));
  }

  /// The nonce of a valid auth for this pipe, seen for the first time; or null.
  String? _admit(HttpRequest request) {
    final match = _auth.firstMatch(
      request.headers.value('x-harness-auth') ?? '',
    );
    if (match == null) return null;
    final nonce = match.group(1)!;
    if (!nonce.startsWith(id) || match.group(2) != _mac(token, 0x01, nonce)) {
      return null;
    }
    return _seen.add(nonce) ? nonce : null;
  }

  Future<void> _serve(HttpRequest request) async {
    final route = '${request.method} ${request.uri.path}';
    hits.add(route);
    String? nonce;
    if (trusted) {
      nonce = _admit(request);
      if (nonce == null) {
        refused.add(route);
        if (WebSocketTransformer.isUpgradeRequest(request)) {
          (await request.response.detachSocket()).destroy();
          return;
        }
        request.response
          ..statusCode = 401
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({'error': 'PIPE_AUTH_REQUIRED'}));
        await request.response.close();
        return;
      }
      request.response.headers.set('x-harness-proof', _mac(token, 0x00, nonce));
    } else if (lies) {
      request.response.headers.set('x-harness-proof', '0' * 64);
    }
    if (WebSocketTransformer.isUpgradeRequest(request)) {
      final ws = await WebSocketTransformer.upgrade(request);
      _sockets.add(ws);
      ws.listen((data) {
        final frame = jsonDecode(data as String) as Map<String, dynamic>;
        final payload = frame['payload'] as Map<String, dynamic>? ?? {};
        switch (frame['type']) {
          case 'machine_select':
            selects++;
            ws.add(jsonEncode({'type': 'connected', 'payload': payload}));
          case 'daemon_act':
            ws.add(
              jsonEncode({
                'type': 'daemon_act_result',
                'payload': {
                  'requestId': payload['requestId'],
                  'ok': false,
                  'error': trusted ? 'UNSUPPORTED' : 'LOCAL_SOCKET_REQUIRED',
                },
              }),
            );
          case 'pair':
            ws.add(
              jsonEncode({
                'type': 'pair_result',
                'payload': {'requestId': payload['requestId'], 'ok': true},
              }),
            );
        }
      });
      return;
    }
    bodies.add(await utf8.decodeStream(request));
    if (route == 'GET /api/status' && hangStatus) return;
    final response = request.response..headers.contentType = ContentType.json;
    switch (route) {
      case 'POST /api/auth/handoff' when !trusted && !lies:
        response.statusCode = 403;
        response.write(jsonEncode({'error': 'FORBIDDEN'}));
      case 'POST /api/auth/handoff':
        response.write(
          jsonEncode({
            'success': true,
            'data': {'code': lies ? 'squatted' : 'hnh_pipe', 'expiresIn': 90},
          }),
        );
      case 'GET /api/status':
        response.write(jsonEncode(status ?? {'pid': pid}));
      default:
        response.statusCode = 404;
        response.write(jsonEncode({'error': 'NOT_FOUND'}));
    }
    await response.close();
  }

  /// Stops, as a daemon that exits does: its WebSockets end with it.
  Future<void> close() async {
    for (final ws in _sockets) {
      await ws.close();
    }
    await server.close(force: true);
  }
}

/// A stand-in pipe, dialled: the Unix socket at a recorded path, as a
/// [PipeStream]. Nothing listening is [PipeAbsent], as on Windows.
Future<PipeStream> dialStandIn(String path) async {
  try {
    return _SocketPipe(
      await Socket.connect(
        InternetAddress(path, type: InternetAddressType.unix),
        0,
      ),
    );
  } on SocketException {
    throw PipeAbsent(path);
  }
}

class _SocketPipe implements PipeStream {
  _SocketPipe(this._socket);
  final Socket _socket;

  @override
  Stream<Uint8List> get input => _socket;

  @override
  void add(List<int> bytes) => _socket.add(bytes);

  @override
  Future<void> close() async => _socket.destroy();
}

/// Writes the record and token a core writes, naming [pipe].
void writeDaemonRecord(Directory dir, int port, String pipe, Uint8List token) {
  File('${dir.path}/daemon-$port.json')
      .writeAsStringSync(jsonEncode({'port': port, 'pipe': pipe, 'pid': pid}));
  File('${dir.path}/daemon-token').writeAsStringSync('${_hex(token)}\n');
}
