// `app_focus.visibleAgents`: which terminals a person can see in this window, so the daemon can tell
// "someone is looking at this agent" from "it is mounted somewhere nobody sees".
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        localWsUri: Uri.parse('ws://127.0.0.1:1/ws'),
      );

  final sent = <Map<String, dynamic>>[];

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (type == 'app_focus') sent.add(payload);
    return true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  late _Conn conn;
  var lifecycleState = AppLifecycleState.resumed;

  TerminalPane tile(int id, String agentId) =>
      TerminalPane(id: id, machineId: 'm', agentId: agentId);

  List<String>? lastList() =>
      (conn.sent.last['visibleAgents'] as List?)?.cast<String>();

  setUp(() async {
    lifecycleState = AppLifecycleState.resumed;
    conn = _Conn();
    app = createApp(connectionForTest: (_) => conn, connected: true)
      ..lifecycle = () => lifecycleState;
    addTearDown(app.dispose);
    app.adoptPoolConnectionForTest('m', conn);
    final first = app.activeSwarm;
    first.panes.addAll([tile(1, 'a1'), tile(2, 'a2')]);
    app.newSwarm(name: 'Second');
    app.activeSwarm.panes.addAll([tile(3, 'b1'), tile(4, 'b2')]);
    app.selectSwarm(first.id);
    conn.sent.clear();
  });

  test('app_focus carries the on-screen tiles', () {
    final first = app.swarms.first.id;
    final second = app.swarms.last.id;
    app.selectSwarm(second);
    expect(lastList(), ['b1', 'b2']);
    app.selectSwarm(first);
    expect(lastList(), ['a1', 'a2']);
  });

  test('a zoomed tile is the only one on screen', () {
    app.focusPane(1);
    app.toggleZoomPane();
    expect(lastList(), ['a1']);
  });

  test('minimizing sends an empty list, restoring sends the tiles back', () {
    lifecycleState = AppLifecycleState.hidden;
    app.announceWindowForeground();
    expect(lastList(), isEmpty);
    // Behind another app is still on screen.
    lifecycleState = AppLifecycleState.inactive;
    app.announceWindowForeground();
    expect(lastList(), ['a1', 'a2']);
  });

  test('the real lifecycle path re-announces on every state change', () {
    final binding = TestWidgetsFlutterBinding.instance;
    final listener = AppLifecycleListener(
      onStateChange: app.appLifecycleChanged,
    );
    addTearDown(listener.dispose);
    app.lifecycle = () => binding.lifecycleState;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    expect(lastList(), isEmpty);
    // hidden -> inactive fires onShow, not onInactive: a window brought back without focus.
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    expect(lastList(), ['a1', 'a2']);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });

  test('a repeat of the same list is not sent again', () {
    app.announceWindowForeground();
    app.announceWindowForeground();
    expect(conn.sent, isEmpty);
  });

  test('a super tab whose terminal canvas is not shown lists nothing', () {
    final superTab = Swarm(id: 'st', name: 'Super', kind: 'superTab')
      ..superTabId = 'st-remote'
      ..panes.add(tile(5, 's1'));
    app.swarms.add(superTab);
    app.selectSwarm('st');
    expect(lastList(), isEmpty);
    app.setSuperTabTerminalsShown('st', true);
    expect(lastList(), ['s1']);
    app.setSuperTabTerminalsShown('st', false);
    expect(lastList(), isEmpty);
  });
}
