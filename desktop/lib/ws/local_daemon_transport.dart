import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import '../core/test_run.dart';
import 'daemon_pipe_record.dart';
import 'trusted_pipe.dart';
import 'windows_pipe.dart';

/// The daemon's Unix socket, beside its loopback port (CLI `lib/localSocket.ts`).
///
/// The loopback port takes requests from any process on this computer, any
/// user's; the socket file is 0600 in a 0700 directory, so only this user's
/// processes can open it. The app prefers it for both REST and the local
/// WebSocket and falls back to the port — for a daemon that predates the
/// socket, one that could not open it, or a moment when it is missing.
///
/// There is one socket per control port, `daemon-<port>.sock`, named for the
/// port the app would otherwise dial: the socket and the fallback always lead
/// to the same daemon, even with a second one on another port.
String daemonSocketName(int port) => 'daemon-$port.sock';

/// The daemon opens no socket path longer than this (`sockaddr_un.sun_path`
/// is 104 bytes on macOS, less the daemon's staging suffix), so neither does
/// the app look for one.
const _maxSocketPathBytes = 96;

/// Where the socket of the daemon on [port] would be —
/// `$ADAPTER_DATA_DIR/daemon-<port>.sock`, by default
/// `~/.harness/cli/data/daemon-<port>.sock` — or null where there is none
/// (Windows, or a path too long to be a socket).
String? defaultDaemonSocketPath(
  int port, {
  Map<String, String>? environment,
  bool? isWindows,
}) {
  if (isWindows ?? Platform.isWindows) return null;
  final env = environment ?? Platform.environment;
  final home = env['HOME'];
  final dataDir =
      env['ADAPTER_DATA_DIR'] ??
      (home == null || home.isEmpty ? null : '$home/.harness/cli/data');
  if (dataDir == null) return null;
  final path = '$dataDir/${daemonSocketName(port)}';
  return utf8.encode(path).length <= _maxSocketPathBytes ? path : null;
}

/// An [HttpClient] whose every connection goes to the socket at [path],
/// whatever host the URL names.
HttpClient unixHttpClient(String path) => HttpClient()
  ..connectionFactory = (uri, proxyHost, proxyPort) => Socket.startConnect(
    InternetAddress(path, type: InternetAddressType.unix),
    0,
  );

/// Which way the app currently reaches the daemon. One instance is shared by
/// discovery, REST and the local WebSocket so they agree.
class LocalDaemonTransport {
  LocalDaemonTransport({this.candidate, this.trustedPipe, this.recordedPort});

  /// The transport to the daemon at [daemonBase] (the loopback address the app
  /// would otherwise dial): the socket named for its port, or on Windows the
  /// daemon's pipe for the trusted routes — except under `flutter test`, where
  /// a real daemon's socket or pipe must never be reached.
  factory LocalDaemonTransport.detect(Uri daemonBase) => LocalDaemonTransport(
    candidate: kUnderTest ? null : defaultDaemonSocketPath(daemonBase.port),
    trustedPipe: kUnderTest || !Platform.isWindows
        ? null
        : TrustedPipe.forPort(daemonBase.port),
    recordedPort: kUnderTest || !Platform.isWindows
        ? null
        : () {
            final dataDir = defaultDaemonDataDir();
            return dataDir == null
                ? null
                : readDaemonTcpPort(dataDir: dataDir, port: daemonBase.port);
          },
  );

  /// Where the socket would be, or null when this app never uses one.
  final String? candidate;

  /// Windows: the daemon's authenticated pipe (CLI `listenAuthenticated`),
  /// which carries the trusted routes ([trustedDaemonRoutes]) and this
  /// computer's window connection, where the daemon takes its `daemon_*`
  /// frames. Null elsewhere: there the socket's file mode is the trust.
  final TrustedPipe? trustedPipe;

  /// Whether the trusted routes cannot be served right now: on Windows, the
  /// last look found no pipe that proved itself. Never true off Windows.
  bool get trustedRoutesUnavailable => trustedPipe?.unavailable ?? false;

  /// Windows: reads the loopback port the daemon actually bound from its
  /// record ([readDaemonTcpPort]). Null elsewhere, where the socket named for
  /// the configured port leads to this user's daemon whatever port it bound.
  /// Another OS user's daemon may hold the configured port; this user's daemon
  /// then binds another and records it (CLI `hookServer.ts`,
  /// `allowPortFallback`), and the CLI's own clients read it the same way
  /// (`savedDaemonPort`).
  final int? Function()? recordedPort;

  int? _tcpPort;

  /// [daemonBase] on the port discovery last read from the daemon's record
  /// ([refreshTcpBase]), or [daemonBase] itself.
  Uri tcpBase(Uri daemonBase) {
    final port = _tcpPort;
    return port == null || port == daemonBase.port
        ? daemonBase
        : daemonBase.replace(port: port);
  }

  /// Reads the daemon's record again and returns the loopback address to ask,
  /// as [tcpBase] then gives it. Discovery calls it before each loopback
  /// probe, so a daemon that restarted on another port is followed. Null on
  /// Windows while the daemon has recorded no port: the configured port may be
  /// another user's daemon then, so nothing is asked there.
  Uri? refreshTcpBase(Uri daemonBase) {
    final read = recordedPort;
    if (read == null) return daemonBase;
    final port = read();
    if (port == null) return null;
    _tcpPort = port;
    return tcpBase(daemonBase);
  }

  String? _active;

  /// The socket to use now, or null for the loopback port. Set by discovery
  /// once the daemon answered over it; dropped when a connection to it fails.
  String? get socketPath => _active;

  /// Whether a socket file is there to try.
  bool get socketPresent {
    final path = candidate;
    return path != null &&
        FileSystemEntity.typeSync(path, followLinks: false) ==
            FileSystemEntityType.unixDomainSock;
  }

  void useSocket() => _active = candidate;

  void useTcp() => _active = null;
}

/// Whether [error] means nothing could be reached — as opposed to a daemon
/// that answered badly, which a retry elsewhere would not fix.
bool isConnectionFailure(Object error) {
  if (error is SocketException) return true;
  if (error is DioException) {
    return error.type == DioExceptionType.connectionError ||
        error.type == DioExceptionType.connectionTimeout ||
        error.error is SocketException;
  }
  return false;
}

/// Sends daemon REST over [transport]'s socket when there is one, and over the
/// loopback port otherwise — including, once, when the socket cannot be
/// reached: the request is retried on the port and the transport falls back
/// until discovery finds the socket again.
class LocalDaemonHttpAdapter implements HttpClientAdapter {
  LocalDaemonHttpAdapter(this.transport, {required this.daemonBase});

  final LocalDaemonTransport transport;

  /// The daemon's loopback address. Only requests to it take the socket; one
  /// the same client sends anywhere else (a loopback override for another
  /// local service) goes where its URL says.
  final Uri daemonBase;
  final IOHttpClientAdapter _tcp = IOHttpClientAdapter();
  IOHttpClientAdapter? _unix;
  String? _unixPath;

  IOHttpClientAdapter _unixFor(String path) {
    if (_unix == null || _unixPath != path) {
      _unix?.close(force: true);
      _unixPath = path;
      _unix = IOHttpClientAdapter(createHttpClient: () => unixHttpClient(path));
    }
    return _unix!;
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final path = transport.socketPath;
    final uri = options.uri;
    final toDaemon =
        uri.scheme == daemonBase.scheme &&
        uri.host == daemonBase.host &&
        uri.port == daemonBase.port;
    final pipe = transport.trustedPipe;
    if (pipe != null &&
        toDaemon &&
        isTrustedDaemonRoute(options.method, uri.path)) {
      return _overPipe(pipe, options, requestStream);
    }
    if (path == null || !toDaemon) {
      return _tcp.fetch(
        toDaemon ? _onTcpPort(options) : options,
        requestStream,
        cancelFuture,
      );
    }
    try {
      return await _unixFor(path).fetch(options, requestStream, cancelFuture);
    } catch (error) {
      if (!isConnectionFailure(error)) rethrow;
      // Nothing was sent: the socket could not be opened. The port can still
      // serve this request, and discovery will find the socket again later.
      transport.useTcp();
      return _tcp.fetch(options, requestStream, cancelFuture);
    }
  }

  /// [options] aimed at the loopback port the daemon recorded, when that is
  /// not [daemonBase]'s ([LocalDaemonTransport.tcpBase]; Windows only).
  RequestOptions _onTcpPort(RequestOptions options) {
    final port = transport.tcpBase(daemonBase).port;
    final uri = options.uri;
    if (port == uri.port) return options;
    // The whole address goes in the path: Dio then ignores baseUrl, and the
    // query is already part of it.
    return options.copyWith(
      path: uri.replace(port: port).toString(),
      queryParameters: <String, dynamic>{},
    );
  }

  /// A trusted route on Windows: over the daemon's pipe, never the port, where
  /// the daemon would refuse it. No proven pipe is a connection error, which
  /// the caller already treats as an older daemon's missing route.
  Future<ResponseBody> _overPipe(
    TrustedPipe pipe,
    RequestOptions options,
    Stream<Uint8List>? requestStream,
  ) async {
    final body = BytesBuilder(copy: false);
    if (requestStream != null) {
      await for (final chunk in requestStream) {
        body.add(chunk);
      }
    }
    final headers = <String, String>{
      for (final MapEntry(:key, :value) in options.headers.entries)
        if (value != null && key.toLowerCase() != 'content-length')
          key.toLowerCase(): '$value',
    };
    final uri = options.uri;
    try {
      final answer = await pipe.request(
        options.method,
        uri.hasQuery ? '${uri.path}?${uri.query}' : uri.path,
        headers: headers,
        body: body.takeBytes(),
      );
      return ResponseBody.fromBytes(
        answer.body,
        answer.status,
        headers: answer.headers,
      );
    } on PipeFailure catch (failure) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: failure.message,
        error: failure,
      );
    }
  }

  @override
  void close({bool force = false}) {
    _tcp.close(force: force);
    _unix?.close(force: force);
  }
}
