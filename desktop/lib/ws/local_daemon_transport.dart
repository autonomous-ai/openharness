import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import '../core/test_run.dart';

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

/// The daemon's data folder: `$ADAPTER_DATA_DIR`, by default
/// `~/.harness/cli/data` — or null with no home to put it in.
String? defaultDaemonDataDir({Map<String, String>? environment}) {
  final env = environment ?? Platform.environment;
  final home = env['HOME'] ?? env['USERPROFILE'];
  return env['ADAPTER_DATA_DIR'] ??
      (home == null || home.isEmpty ? null : '$home/.harness/cli/data');
}

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
  final dataDir = defaultDaemonDataDir(environment: environment);
  if (dataDir == null) return null;
  final path = '$dataDir/${daemonSocketName(port)}';
  return utf8.encode(path).length <= _maxSocketPathBytes ? path : null;
}

/// The header a call to the daemon's loopback PORT carries its local
/// credential in (CLI `lib/localCredential.ts`).
const daemonCredentialHeader = 'X-Harness-Local';

/// The daemon's local credential: its `hook-credential` file, 0600 and this
/// user's, in [defaultDaemonDataDir]. The loopback port takes any OS user's
/// process — another account's harness running as its own user on this
/// computer included — so every call over the port shows it; the socket needs
/// none. Null where it cannot be read.
String? readDaemonCredential({Map<String, String>? environment}) {
  final dataDir = defaultDaemonDataDir(environment: environment);
  if (dataDir == null) return null;
  try {
    final value = File('$dataDir/hook-credential').readAsStringSync().trim();
    return RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(value) ? value : null;
  } on FileSystemException {
    return null;
  }
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
  LocalDaemonTransport({this.candidate, this.credential});

  /// The transport to the daemon at [daemonBase] (the loopback address the app
  /// would otherwise dial): the socket named for its port, and the credential
  /// the port wants — except under `flutter test`, where a real daemon must
  /// never be reached.
  factory LocalDaemonTransport.detect(Uri daemonBase) => LocalDaemonTransport(
    candidate: kUnderTest ? null : defaultDaemonSocketPath(daemonBase.port),
    credential: kUnderTest ? null : readDaemonCredential,
  );

  /// Where the socket would be, or null when this app never uses one.
  final String? candidate;

  /// Reads the daemon's local credential, or null when this app never shows
  /// one (tests).
  final String? Function()? credential;

  /// What a call over the loopback PORT adds: the daemon's local credential,
  /// read each time so a daemon that made a new one is not refused. Empty when
  /// there is none to read.
  Map<String, String> tcpHeaders() {
    final value = credential?.call();
    return value == null ? const {} : {daemonCredentialHeader: value};
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
    // Over the port, the daemon wants its local credential.
    Future<ResponseBody> overPort() {
      if (toDaemon) options.headers.addAll(transport.tcpHeaders());
      return _tcp.fetch(options, requestStream, cancelFuture);
    }

    if (path == null || !toDaemon) return overPort();
    try {
      return await _unixFor(path).fetch(options, requestStream, cancelFuture);
    } catch (error) {
      if (!isConnectionFailure(error)) rethrow;
      // Nothing was sent: the socket could not be opened. The port can still
      // serve this request, and discovery will find the socket again later.
      transport.useTcp();
      return overPort();
    }
  }

  @override
  void close({bool force = false}) {
    _tcp.close(force: force);
    _unix?.close(force: force);
  }
}
