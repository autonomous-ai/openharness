import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// A relay socket with nothing behind it but the test: frames the phone sends land in [sent] (and
/// [onFrame]), and the test says what comes back with [emit]. Nothing leaves the process.
class FakeRelaySocket implements WebSocketChannel {
  FakeRelaySocket({Future<void>? ready, this.onFrame})
    : ready = ready ?? Future<void>.value();

  /// What the phone sent, decoded.
  final sent = <Map<String, dynamic>>[];

  /// Called with each frame the phone sends, after it is recorded.
  void Function(Map<String, dynamic> frame)? onFrame;

  /// The URL and protocols the phone dialled with, when built through [factory].
  Uri? dialled;
  List<String>? protocols;

  final _down = StreamController<dynamic>();
  late final _FakeSink _sink = _FakeSink(this);

  /// Whether the phone closed its end.
  bool get closedByPhone => _sink.closed;

  @override
  final Future<void> ready;

  @override
  Stream<dynamic> get stream => _down.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  String? get protocol => null;

  @override
  int? closeCode;

  @override
  String? closeReason;

  /// A frame from the relay (or the machine behind it), as JSON text.
  void emit(String type, Map<String, Object?> payload) =>
      _down.add(jsonEncode({'type': type, 'payload': payload}));

  /// Anything at all, as the socket would hand it over.
  void emitRaw(Object? raw) => _down.add(raw);

  void fail(Object error) => _down.addError(error);

  /// The far end hanging up.
  Future<void> hangUp([int? code]) {
    closeCode = code;
    return _down.close();
  }

  /// A [RelaySocketFactory]-shaped function that hands out this socket.
  WebSocketChannel factory(Uri uri, Iterable<String> protocols) {
    dialled = uri;
    this.protocols = protocols.toList();
    return this;
  }

  // The StreamChannel conveniences (pipe, transform…) are never called on a relay socket.
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this._socket);

  final FakeRelaySocket _socket;
  bool closed = false;
  final _done = Completer<void>();

  @override
  void add(dynamic data) {
    if (closed) throw StateError('sink closed');
    final frame = jsonDecode(data as String) as Map<String, dynamic>;
    _socket.sent.add(frame);
    _socket.onFrame?.call(frame);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<dynamic> stream) async {
    await for (final data in stream) {
      add(data);
    }
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    closed = true;
    if (!_done.isCompleted) _done.complete();
  }

  @override
  Future<void> get done => _done.future;
}
