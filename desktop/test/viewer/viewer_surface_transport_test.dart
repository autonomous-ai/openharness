import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/viewer_p2p.dart';
import 'package:harness/ws/ws_conn.dart';

import '../swarm_state_test.dart' show createApp;
import 'p2p_viewer_transport_test.dart' show FakeViewerP2p, flat, surface;

class _Conn extends WsConn {
  _Conn(this.channel)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final ViewerP2p? channel;
  final asked = <(String, Map<String, dynamic>)>[];

  @override
  bool get isReady => true;

  @override
  ViewerP2p? get viewerP2p => channel;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    asked.add((type, payload));
    return {'closed': true};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  AppNotifier app(_Conn conn) {
    final app = createApp(connectionForTest: (_) => conn, connected: true);
    addTearDown(app.dispose);
    return app;
  }

  final input = {
    'surfaceId': surface,
    'width': 800,
    'height': 600,
    'dark': true,
    'scale': 1.0,
    'mobile': false,
    'touch': false,
    'op': 'input',
    'events': <Map<String, dynamic>>[],
  };

  test('input rides the viewer channel while it pushes, and the machine\'s surface_state answers it', () async {
    final channel = FakeViewerP2p();
    final conn = _Conn(channel);
    final notifier = app(conn);
    final frame = notifier.viewerSurface('m', 'a0', {...input, 'op': 'frame'});
    await pumpEventQueue();
    channel.push(1);
    expect((await frame)['seq'], 1);
    final reply = notifier.viewerSurface('m', 'a0', input);
    final (type, sent) = channel.sent.last;
    expect(type, 'surface_input');
    expect(sent, containsPair('agentId', 'a0'));
    await notifier.handleEventForTest('m', {
      'type': 'surface_state',
      'payload': {
        'surfaceId': surface,
        'input': sent['input'],
        'seq': 2,
        'editable': true,
      },
    });
    expect(await reply, containsPair('editable', true));

    // Close goes over the channel too: it ends the push.
    await notifier.viewerSurface('m', 'a0', {
      'surfaceId': surface,
      'op': 'close',
    });
    expect(flat(channel.sent.last), [
      'surface_close',
      {'surfaceId': surface},
    ]);
    expect(conn.asked, isEmpty);
  });

  test('without a viewer channel (the native app) the request is the WS viewer_surface', () async {
    final conn = _Conn(null);
    await app(conn).viewerSurface('m', 'a0', input);
    expect(flat(conn.asked.single), [
      'viewer_surface',
      {...input, 'agentId': 'a0'},
    ]);
  });
}
