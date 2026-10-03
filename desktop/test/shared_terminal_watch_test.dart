import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/sharing/shared_harness_bar.dart';
import 'package:harness/sharing/shared_terminal_watch.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';

void main() {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';

  ({TerminalSession session, List<Map<String, dynamic>> sent}) observer() {
    final sent = <Map<String, dynamic>>[];
    final session = TerminalSession(
      machineId: 'shared',
      agentId: 'agent',
      agentName: 'Demo',
      engineId: 'codex',
      readOnly: true,
      send: (type, payload) async {
        sent.add({'type': type, ...payload});
        return true;
      },
      sendBinary: (_) async => false,
    );
    return (session: session, sent: sent);
  }

  List<Map<String, dynamic>> opens(List<Map<String, dynamic>> sent) =>
      sent.where((frame) => frame['type'] == 'terminal_open').toList();

  Future<void> attach(TerminalSession session, Object? requestId) async {
    await session.handleFrame('terminal_ready', {
      'requestId': requestId,
      'protocolVersion': 3,
      'streamId': streamId,
      'agentId': 'agent',
    });
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: streamId,
        seq: 0,
        bytes: Uint8List.fromList(utf8.encode('back again')),
        compressed: false,
        cols: 80,
        rows: 24,
      ),
    );
  }

  testWidgets(
    'a refused open reads as stopped, retries until the harness is back, then stops retrying',
    (tester) async {
      final (:session, :sent) = observer();
      var changes = 0;
      final watch = SharedTerminalWatch(
        session,
        canRetry: () => true,
        onChanged: () => changes++,
      );
      await session.open();
      await session.handleFrame('terminal_error', {
        'requestId': opens(sent).single['requestId'],
        'code': 'TERMINAL_RUNTIME_UNAVAILABLE',
      });
      expect(watch.stopped, isTrue);
      expect(changes, 1);

      await tester.pump(const Duration(seconds: 10));
      expect(opens(sent), hasLength(2));
      // The retry passes through `opening`; the reader keeps seeing why.
      expect(session.status, TerminalSessionStatus.opening);
      expect(watch.stopped, isTrue);

      await attach(session, opens(sent).last['requestId']);
      expect(watch.stopped, isFalse);
      expect(changes, 2);
      await tester.pump(const Duration(seconds: 30));
      expect(opens(sent), hasLength(2));

      watch.dispose();
      session.dispose();
    },
  );

  testWidgets('a stream the owner daemon closes reads as stopped', (
    tester,
  ) async {
    final (:session, :sent) = observer();
    final watch = SharedTerminalWatch(
      session,
      canRetry: () => false,
      onChanged: () {},
    );
    await session.open();
    await attach(session, opens(sent).single['requestId']);
    expect(watch.stopped, isFalse);
    await session.handleFrame('terminal_closed', {
      'streamId': streamId,
      'reason': 'tmux pane/control client closed',
    });
    expect(watch.stopped, isTrue);
    // Not while the pane cannot reach the owner: no retry goes out.
    await tester.pump(const Duration(seconds: 30));
    expect(opens(sent), hasLength(1));
    watch.dispose();
    session.dispose();
  });

  testWidgets('a lost relay is not a stopped harness', (tester) async {
    final (:session, :sent) = observer();
    final watch = SharedTerminalWatch(
      session,
      canRetry: () => true,
      onChanged: () {},
    );
    await session.open();
    await attach(session, opens(sent).single['requestId']);
    session.transportLost('Waiting for the owner to reconnect.');
    expect(session.errorCode, TerminalSession.disconnectedCode);
    expect(watch.stopped, isFalse);
    await tester.pump(const Duration(seconds: 30));
    expect(opens(sent), hasLength(1));
    watch.dispose();
    session.dispose();
  });

  test('pane status puts the most urgent state first', () {
    SharedPaneStatus of(bool ended, bool connected, bool stopped) =>
        SharedPaneStatus.of(
          ended: ended,
          connected: connected,
          terminalStopped: stopped,
        );
    expect(of(true, true, true), SharedPaneStatus.ended);
    expect(of(false, false, true), SharedPaneStatus.reconnecting);
    expect(of(false, true, true), SharedPaneStatus.notRunning);
    expect(of(false, true, false), SharedPaneStatus.live);
    expect(SharedPaneStatus.notRunning.notice, isNotNull);
    expect(SharedPaneStatus.live.notice, isNull);
  });
}
