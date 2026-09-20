import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:isolate';

/// Optional sampling of the current synthetic benchmark, using its own VM's
/// loopback service. No dependency on a user's running app or DevTools session.
class BenchmarkCpuProfile {
  BenchmarkCpuProfile._(this._client, this._socket, this._isolate);

  final HttpClient _client;
  final WebSocket _socket;
  final String _isolate;
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  var _id = 0;
  var _started = 0;
  var _closed = false;

  static Future<BenchmarkCpuProfile> start() async {
    final info = await developer.Service.controlWebServer(enable: true);
    final uri = info.serverUri;
    if (uri == null) {
      throw StateError(
        'Run this benchmark with flutter test --enable-vmservice',
      );
    }
    if (!['127.0.0.1', 'localhost', '::1'].contains(uri.host)) {
      throw StateError(
        'Benchmark profiling requires its own loopback VM service',
      );
    }
    final client = _ServiceHttp().createHttpClient(null);
    final WebSocket socket;
    try {
      socket = await WebSocket.connect(
        uri.replace(scheme: 'ws', path: '${uri.path}ws').toString(),
        customClient: client,
      ).timeout(const Duration(seconds: 10));
    } catch (_) {
      client.close(force: true);
      rethrow;
    }
    final profile = BenchmarkCpuProfile._(
      client,
      socket,
      developer.Service.getIsolateId(Isolate.current)!,
    );
    socket.listen(
      (raw) {
        final event = jsonDecode(raw as String) as Map<String, dynamic>;
        final pending = profile._pending.remove(event['id']);
        if (pending == null) return;
        if (event['error'] case final error?) {
          pending.completeError(StateError('$error'));
        } else {
          pending.complete(Map<String, dynamic>.from(event['result'] as Map));
        }
      },
      onError: profile._failPending,
      onDone: () => profile._failPending(StateError('VM service closed')),
    );
    try {
      await profile._call('setFlag', {'name': 'profiler', 'value': 'true'});
      await profile._call('clearCpuSamples', {'isolateId': profile._isolate});
      profile._started =
          (await profile._call('getVMTimelineMicros'))['timestamp'] as int;
      return profile;
    } catch (_) {
      await profile.close();
      rethrow;
    }
  }

  void _failPending(Object error) {
    final pending = _pending.values.toList();
    _pending.clear();
    for (final call in pending) {
      call.completeError(error);
    }
  }

  Future<Map<String, dynamic>> _call(
    String method, [
    Map<String, Object> params = const {},
  ]) async {
    if (_closed) throw StateError('Benchmark profiling has finished');
    final id = '${_id++}';
    final result = Completer<Map<String, dynamic>>();
    _pending[id] = result;
    try {
      _socket.add(
        jsonEncode({
          'jsonrpc': '2.0',
          'id': id,
          'method': method,
          'params': params,
        }),
      );
      return await result.future.timeout(const Duration(seconds: 10));
    } finally {
      _pending.remove(id);
    }
  }

  Future<void> save(String path) async {
    try {
      final end = (await _call('getVMTimelineMicros'))['timestamp'] as int;
      final samples = await _call('getCpuSamples', {
        'isolateId': _isolate,
        'timeOriginMicros': _started,
        'timeExtentMicros': end - _started,
      });
      await File(path).writeAsString(jsonEncode(samples));
    } finally {
      await close();
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _failPending(StateError('Benchmark profiling has finished'));
    try {
      await _socket.close();
    } finally {
      _client.close(force: true);
    }
  }
}

// Widget tests replace HTTP globally. Only the loopback VM connection above
// uses this real client; product network requests remain under their test fakes.
class _ServiceHttp extends HttpOverrides {}
