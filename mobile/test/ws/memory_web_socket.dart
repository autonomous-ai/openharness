import 'dart:async';

import 'package:web_socket_channel/web_socket_channel.dart';

/// Two asynchronous endpoints, including handshake and close metadata, with no sockets.
class MemoryWebSocket implements WebSocketChannel {
  MemoryWebSocket._(this.protocol);

  static (MemoryWebSocket, MemoryWebSocket) pair({String? protocol}) {
    final client = MemoryWebSocket._(protocol);
    final server = MemoryWebSocket._(protocol);
    client._peer = server;
    server._peer = client;
    server.accept();
    return (client, server);
  }

  final _incoming = StreamController<dynamic>();
  final _ready = Completer<void>();
  final _done = Completer<void>();
  late final MemoryWebSocket _peer;
  bool _closed = false;

  @override
  final String? protocol;
  @override
  int? closeCode;
  @override
  String? closeReason;
  @override
  Future<void> get ready => _ready.future;
  @override
  Stream<dynamic> get stream => _incoming.stream;
  @override
  late final WebSocketSink sink = _Sink(this);

  void accept() {
    if (!_ready.isCompleted) _ready.complete();
  }

  void reject() {
    if (!_ready.isCompleted) {
      _ready.completeError(WebSocketChannelException('upgrade refused'));
    }
  }

  Future<void> close([int? code, String? reason]) async {
    for (final endpoint in [this, _peer]) {
      if (endpoint._closed) continue;
      endpoint._closed = true;
      endpoint.closeCode = code;
      endpoint.closeReason = reason;
      unawaited(endpoint._incoming.close());
      endpoint._done.complete();
    }
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Sink implements WebSocketSink {
  _Sink(this.channel);
  final MemoryWebSocket channel;

  @override
  void add(dynamic data) {
    if (channel._closed) throw StateError('channel closed');
    channel._peer._incoming.add(data);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      channel._peer._incoming.addError(error, stackTrace);

  @override
  Future<void> addStream(Stream<dynamic> stream) async {
    await for (final event in stream) {
      add(event);
    }
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) =>
      channel.close(closeCode, closeReason);

  @override
  Future<void> get done => channel._done.future;
}
