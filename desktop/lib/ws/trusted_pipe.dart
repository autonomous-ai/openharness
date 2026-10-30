import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/dart.dart' show DartSha1;

import 'daemon_pipe_record.dart';
import 'windows_pipe.dart';
import 'windows_pipe_auth.dart';

/// The daemon's answer over its pipe, its proof checked.
class PipeHttpResponse {
  const PipeHttpResponse(this.status, this.headers, this.body);
  final int status;

  /// Lower-case names, as Dio's adapters hand them on.
  final Map<String, List<String>> headers;
  final Uint8List body;
}

/// The daemon's Windows pipe as the trusted callers use it (spec §1.6).
///
/// Every request looks the pipe up again ([lookup]): the record names a new pipe on
/// each daemon start, so a restart is found on the next request, and a name the record
/// no longer gives is never dialled. Every answer must prove the daemon's token; one
/// that does not is [PipeUnproven], and that pipe counts as no pipe. [unavailable] says
/// how the last request went, for the callers' fallback copy.
class TrustedPipe {
  TrustedPipe({
    required this.lookup,
    PipeDialer? dial,
    Random? random,
    this.timeout = const Duration(seconds: 15),
  }) : _dial = dial ?? WindowsPipeConnection.open,
       _random = random ?? Random.secure();

  /// The pipe of the daemon on [port], from its data folder
  /// ([defaultDaemonDataDir]).
  factory TrustedPipe.forPort(int port, {Map<String, String>? environment}) =>
      TrustedPipe(
        lookup: () {
          final dataDir = defaultDaemonDataDir(environment: environment);
          return dataDir == null
              ? null
              : readDaemonPipeRecord(dataDir: dataDir, port: port);
        },
      );

  /// The daemon's pipe and token as its data folder says now, or null.
  final DaemonPipeRecord? Function() lookup;

  /// How long one request may take, from the lookup to the last byte.
  final Duration timeout;
  final PipeDialer _dial;
  final Random _random;
  bool _unavailable = false;

  /// Whether the last request found no pipe that proved itself. False before any.
  bool get unavailable => _unavailable;

  /// One HTTP/1.1 request over its own pipe connection. Throws a [PipeFailure]
  /// when there is no proven pipe; any status the daemon answers is returned.
  Future<PipeHttpResponse> request(
    String method,
    String path, {
    Map<String, String> headers = const {},
    List<int> body = const [],
    Duration? timeout,
  }) => _attempt(timeout ?? this.timeout, (record, pipe) async {
    final reader = _HttpReader(pipe.input);
    try {
      if (body.isNotEmpty) {
        // The recorded name can be held by another process after the daemon
        // exits. Prove this very connection before sending a sign-in code or
        // any other request body; a separate probe would leave a rebind race.
        final preflightAuth = _auth(record);
        pipe.add(
          _head('GET /api/status', {
            'content-length': '0',
            'connection': 'keep-alive',
            pipeAuthHeader: preflightAuth,
          }),
        );
        final preflight = await reader.head();
        _prove(record, preflightAuth, preflight);
        if (preflight.status != 200) {
          throw PipeProtocolError(
            'The Harness daemon did not answer its private-pipe probe (HTTP ${preflight.status}).',
          );
        }
        await reader.body(preflight);
      }
      final auth = _auth(record);
      pipe.add(
        _head('${method.toUpperCase()} $path', {
          ...headers,
          'content-length': '${body.length}',
          'connection': 'close',
          pipeAuthHeader: auth,
        }),
      );
      if (body.isNotEmpty) pipe.add(body);
      final head = await reader.head();
      _prove(record, auth, head);
      return PipeHttpResponse(
        head.status,
        head.headers,
        await reader.body(head),
      );
    } finally {
      await reader.cancel();
      await pipe.close();
    }
  });

  /// A WebSocket to [path] over its own pipe connection: an HTTP/1.1 upgrade
  /// written by hand, its 101 proven, then dart:io's WebSocket on the pipe's
  /// bytes ([WebSocket.fromUpgradedSocket] over [PipeSocket]).
  Future<WebSocket> webSocket(
    String path, {
    Duration timeout = const Duration(seconds: 5),
  }) => _attempt(timeout, (record, pipe) async {
    final auth = _auth(record);
    final key = base64.encode(_randomBytes(16));
    pipe.add(
      _head('GET $path', {
        'upgrade': 'websocket',
        'connection': 'Upgrade',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        pipeAuthHeader: auth,
      }),
    );
    final reader = _HttpReader(pipe.input);
    try {
      final head = await reader.head();
      _prove(record, auth, head);
      if (head.status != 101 ||
          head.value('upgrade')?.toLowerCase() != 'websocket' ||
          head.value('sec-websocket-accept') != _acceptFor(key)) {
        throw PipeProtocolError(
          'The Harness daemon did not open its WebSocket (HTTP ${head.status}).',
        );
      }
      return WebSocket.fromUpgradedSocket(
        PipeSocket(reader.remaining(), pipe),
        serverSide: false,
        compression: CompressionOptions.compressionOff,
      );
    } catch (_) {
      await reader.cancel();
      await pipe.close();
      rethrow;
    }
  });

  /// Whether a pipe proves itself now: one `GET /api/status`. Never throws.
  Future<bool> probe() async {
    try {
      await request('GET', '/api/status');
      return true;
    } on PipeFailure {
      return false;
    }
  }

  /// Runs one [exchange] on a fresh pipe connection, within [limit]. A pipe that
  /// does not answer in time has its connection closed, so nothing is left
  /// blocked on it. Any failure marks the pipe [unavailable].
  Future<T> _attempt<T>(
    Duration limit,
    Future<T> Function(DaemonPipeRecord record, PipeStream pipe) exchange,
  ) async {
    PipeStream? opened;
    var late = false;
    try {
      final value =
          await () async {
            final record = lookup();
            if (record == null) throw const PipeRecordMissing();
            final pipe = opened = await _dial(record.pipePath);
            if (late) {
              await pipe.close();
              throw const PipeProtocolError(_tooLate);
            }
            return exchange(record, pipe);
          }().timeout(
            limit,
            onTimeout: () {
              late = true;
              final pipe = opened;
              if (pipe != null) unawaited(pipe.close());
              throw const PipeProtocolError(_tooLate);
            },
          );
      _unavailable = false;
      return value;
    } on PipeFailure {
      _unavailable = true;
      rethrow;
    } catch (_) {
      // Anything else that went wrong on the way (an isolate that would not
      // start, say) is still no pipe to trust.
      _unavailable = true;
      throw const PipeProtocolError(
        'The Harness daemon\'s private pipe could not be used.',
      );
    }
  }

  static const _tooLate =
      'The Harness daemon did not answer on its private pipe in time.';

  String _auth(DaemonPipeRecord record) =>
      pipeAuthHeaderValue(record.token, record.pipeId, _randomBytes(16));

  void _prove(DaemonPipeRecord record, String auth, _HttpHead head) {
    final proof = head.value(pipeProofHeader) ?? '';
    if (!pipeProofMatches(record.token, pipeNonceOf(auth), proof)) {
      throw PipeUnproven(record.pipePath);
    }
  }

  Uint8List _randomBytes(int length) =>
      Uint8List.fromList(List.generate(length, (_) => _random.nextInt(256)));
}

Uint8List _head(String requestLine, Map<String, String> headers) {
  final text = StringBuffer('$requestLine HTTP/1.1\r\nhost: localhost\r\n');
  headers.forEach((name, value) {
    if (name.toLowerCase() != 'host') text.write('$name: $value\r\n');
  });
  text.write('\r\n');
  return Uint8List.fromList(utf8.encode(text.toString()));
}

String _acceptFor(String key) => base64.encode(
  const DartSha1()
      .hashSync(ascii.encode('${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))
      .bytes,
);

class _HttpHead {
  _HttpHead(this.status, this.headers);
  final int status;
  final Map<String, List<String>> headers;
  String? value(String name) => headers[name]?.join(', ');
}

/// Reads an HTTP/1.1 answer off the pipe's bytes: its head, then its body by
/// Content-Length, chunked, or to the end; for an upgrade, the bytes after it.
class _HttpReader {
  _HttpReader(Stream<Uint8List> input) : _chunks = StreamIterator(input);

  static const _maxHeadBytes = 64 * 1024;
  static const _maxBodyBytes = 16 * 1024 * 1024;
  final StreamIterator<Uint8List> _chunks;
  Uint8List _buffer = Uint8List(0);
  int _at = 0;
  bool _ended = false;

  int get _left => _buffer.length - _at;

  Future<bool> _more() async {
    if (_ended || !await _chunks.moveNext()) {
      _ended = true;
      return false;
    }
    _buffer = Uint8List.fromList([..._buffer.sublist(_at), ..._chunks.current]);
    _at = 0;
    return true;
  }

  Future<String> _line() async {
    for (;;) {
      for (var i = _at; i + 1 < _buffer.length; i++) {
        if (_buffer[i] == 13 && _buffer[i + 1] == 10) {
          if (i - _at > _maxHeadBytes) {
            throw const PipeProtocolError(
              'The Harness daemon sent too long a line.',
            );
          }
          final line = latin1.decode(_buffer.sublist(_at, i));
          _at = i + 2;
          return line;
        }
      }
      if (_left > _maxHeadBytes) {
        throw const PipeProtocolError(
          'The Harness daemon sent too long a line.',
        );
      }
      if (!await _more()) {
        throw const PipeBroken();
      }
    }
  }

  Future<Uint8List> _take(int count) async {
    while (_left < count) {
      if (!await _more()) throw const PipeBroken();
    }
    final bytes = _buffer.sublist(_at, _at + count);
    _at += count;
    return bytes;
  }

  Future<_HttpHead> head() async {
    final status = RegExp(r'^HTTP/1\.[01] (\d{3})').firstMatch(await _line());
    if (status == null) {
      throw const PipeProtocolError(
        'The Harness daemon did not answer in HTTP.',
      );
    }
    final headers = <String, List<String>>{};
    var size = 0;
    for (;;) {
      final line = await _line();
      if (line.isEmpty) break;
      size += line.length;
      final colon = line.indexOf(':');
      if (colon <= 0 || size > _maxHeadBytes) {
        throw const PipeProtocolError(
          'The Harness daemon sent a malformed answer.',
        );
      }
      headers
          .putIfAbsent(line.substring(0, colon).trim().toLowerCase(), () => [])
          .add(line.substring(colon + 1).trim());
    }
    return _HttpHead(int.parse(status.group(1)!), headers);
  }

  Future<Uint8List> body(_HttpHead head) async {
    if (head.status == 101 || head.status == 204 || head.status == 304) {
      return Uint8List(0);
    }
    final out = BytesBuilder(copy: false);
    void keep(Uint8List bytes) {
      if (bytes.length > _maxBodyBytes - out.length) {
        throw const PipeProtocolError(
          'The Harness daemon\'s answer is too large.',
        );
      }
      out.add(bytes);
    }

    if (head.value('transfer-encoding')?.toLowerCase().contains('chunked') ??
        false) {
      for (;;) {
        final text = (await _line()).split(';').first.trim();
        final size = int.tryParse(text, radix: 16);
        if (!RegExp(r'^[0-9a-fA-F]+$').hasMatch(text) ||
            size == null ||
            size < 0) {
          throw const PipeProtocolError(
            'The Harness daemon sent a malformed chunk.',
          );
        }
        if (size == 0) {
          var trailerBytes = 0;
          for (;;) {
            final trailer = await _line();
            if (trailer.isEmpty) break;
            trailerBytes += trailer.length + 2;
            if (trailerBytes > _maxHeadBytes) {
              throw const PipeProtocolError(
                'The Harness daemon sent too long a trailer.',
              );
            }
          }
          return out.takeBytes();
        }
        if (size > _maxBodyBytes - out.length) {
          throw const PipeProtocolError(
            'The Harness daemon\'s answer is too large.',
          );
        }
        keep(await _take(size));
        final end = await _take(2);
        if (end[0] != 13 || end[1] != 10) {
          throw const PipeProtocolError(
            'The Harness daemon sent a malformed chunk.',
          );
        }
      }
    }
    final text = head.value('content-length');
    if (text != null) {
      final length = int.tryParse(text);
      if (!RegExp(r'^[0-9]+$').hasMatch(text) || length == null || length < 0) {
        throw const PipeProtocolError(
          'The Harness daemon sent a malformed body length.',
        );
      }
      if (length > _maxBodyBytes) {
        throw const PipeProtocolError(
          'The Harness daemon\'s answer is too large.',
        );
      }
      return _take(length);
    }
    // Neither: the answer runs to the end of the connection.
    if (_left > 0) keep(_buffer.sublist(_at));
    _at = _buffer.length;
    while (await _chunks.moveNext()) {
      keep(_chunks.current);
    }
    _ended = true;
    return out.takeBytes();
  }

  /// Whatever follows the head: the start of a WebSocket's frames.
  Stream<Uint8List> remaining() async* {
    if (_left > 0) {
      final first = _buffer.sublist(_at);
      _at = _buffer.length;
      yield first;
    }
    try {
      while (!_ended && await _chunks.moveNext()) {
        yield _chunks.current;
      }
    } finally {
      _ended = true;
      await _chunks.cancel();
    }
  }

  Future<void> cancel() => _chunks.cancel();
}

/// A [PipeStream] as the [Socket] that [WebSocket.fromUpgradedSocket] takes. The
/// WebSocket reads the stream and writes and closes the sink; nothing else of a
/// Socket applies to a pipe.
class PipeSocket extends Stream<Uint8List> implements Socket {
  PipeSocket(this._input, this._pipe);

  final Stream<Uint8List> _input;
  final PipeStream _pipe;
  final _done = Completer<void>();

  @override
  Encoding encoding = utf8;

  @override
  StreamSubscription<Uint8List> listen(
    void Function(Uint8List event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _input.listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );

  @override
  void add(List<int> data) => _pipe.add(data);

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.forEach(_pipe.add);

  @override
  Future<void> flush() async {}

  @override
  Future<void> close() async {
    await _pipe.close();
    if (!_done.isCompleted) _done.complete();
  }

  @override
  Future<void> get done => _done.future;

  @override
  void destroy() => unawaited(close());

  @override
  void write(Object? object) => add(encoding.encode('$object'));

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) =>
      write(objects.join(separator));

  @override
  void writeln([Object? object = '']) => write('$object\n');

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  bool setOption(SocketOption option, bool enabled) => false;

  @override
  Uint8List getRawOption(RawSocketOption option) =>
      throw UnsupportedError('A pipe has no socket options.');

  @override
  void setRawOption(RawSocketOption option) =>
      throw UnsupportedError('A pipe has no socket options.');

  @override
  int get port => 0;

  @override
  int get remotePort => 0;

  @override
  InternetAddress get address => InternetAddress.loopbackIPv4;

  @override
  InternetAddress get remoteAddress => InternetAddress.loopbackIPv4;
}
