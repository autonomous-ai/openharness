// ignore_for_file: avoid_print
// Times what opening Desktop waits for, against this computer's running daemon:
// the machine list, the local socket, and a cold relay dial to every other machine.
//
//   dart run tool/measure_connect.dart [rounds]
//
// It reads and selects only: each remote select takes the daemon's isolated relay path, which
// dials afresh and leaves the windows' live sessions alone. It prints short machine ids and
// timings, never names, tokens or anything a machine answers.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

const _protocol = 1;
const _givesUpAfter = Duration(seconds: 20);

Future<void> main(List<String> args) async {
  final rounds = args.isEmpty ? 1 : int.parse(args.first);
  final home = Platform.environment['HOME']!;
  final socket = '$home/.harness/cli/data/daemon-18473.sock';
  HttpClient client() => HttpClient()
    ..connectionFactory = (uri, proxyHost, proxyPort) => Socket.startConnect(
      InternetAddress(socket, type: InternetAddressType.unix),
      0,
    );

  final http = client();
  final status = await _getJson(http, '/api/status');
  final local = status.value['machineId'] as String?;
  print('status    ${status.ms} ms');
  final listed = await _getJson(http, '/api/machines');
  print('machines  ${listed.ms} ms');
  http.close();
  final raw = listed.value['data'];
  final rows = (raw is Map ? raw['machines'] : raw) as List;

  for (var round = 1; round <= rounds; round++) {
    print('round $round: every machine at once, as opening does');
    final clock = Stopwatch()..start();
    final results = await Future.wait([
      for (final row in rows)
        _select(
          client,
          row['machineId'] as String,
          row['status'] as String?,
          isLocal: row['machineId'] == local,
        ),
    ]);
    for (final result in results) {
      print(result);
    }
    print('all answered in ${clock.elapsedMilliseconds} ms');
  }
}

Future<({int ms, Map<String, dynamic> value})> _getJson(
  HttpClient http,
  String path,
) async {
  final clock = Stopwatch()..start();
  final request = await http.getUrl(Uri.parse('http://localhost$path'));
  final response = await request.close();
  final body = await response.transform(utf8.decoder).join();
  final decoded = jsonDecode(body) as Map<String, dynamic>;
  final data = decoded['data'];
  return (
    ms: clock.elapsedMilliseconds,
    value: path == '/api/status' && data is Map<String, dynamic>
        ? data
        : decoded,
  );
}

Future<String> _select(
  HttpClient Function() client,
  String machineId,
  String? status, {
  required bool isLocal,
}) async {
  final label =
      '${machineId.substring(0, 8)} ${isLocal ? 'this computer' : 'remote'} ($status)';
  final clock = Stopwatch()..start();
  final WebSocket ws;
  try {
    ws = await WebSocket.connect(
      'ws://localhost/api/local-ws',
      customClient: client(),
    );
  } catch (error) {
    return '$label: socket failed after ${clock.elapsedMilliseconds} ms (${error.runtimeType})';
  }
  final opened = clock.elapsedMilliseconds;
  final answered = Completer<String>();
  void finish(String text) {
    if (!answered.isCompleted) answered.complete(text);
  }

  final sub = ws.listen(
    (raw) {
      if (raw is! String) return;
      final frame = jsonDecode(raw) as Map<String, dynamic>;
      final payload = frame['payload'];
      if (frame['type'] == 'connected' &&
          payload is Map &&
          payload['machineId'] == machineId) {
        finish('connected ${clock.elapsedMilliseconds} ms');
      }
    },
    onDone: () => finish(
      'closed ${clock.elapsedMilliseconds} ms (${ws.closeCode} ${ws.closeReason})',
    ),
    onError: (_) => finish('error ${clock.elapsedMilliseconds} ms'),
  );
  ws.add(
    jsonEncode({
      'type': 'machine_select',
      'payload': {
        'machineId': machineId,
        'localProtocolVersion': _protocol,
        'tool': true,
        if (!isLocal) 'relayIsolation': true,
      },
    }),
  );
  final outcome = await answered.future.timeout(
    _givesUpAfter,
    onTimeout: () => 'no answer in ${_givesUpAfter.inSeconds} s',
  );
  await sub.cancel();
  await ws.close();
  return '$label: socket $opened ms, $outcome';
}
