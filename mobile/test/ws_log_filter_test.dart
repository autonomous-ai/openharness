import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// What the socket writes to the app's log file — every line a synchronous,
/// flushed write on the UI thread.
void main() {
  test('an agent\'s live chat never reaches the log', () {
    // `SessionEvent`/`LiveEvent` in cli/src/lib/normalize.ts: the words typed
    // and answered, streamed several frames a second.
    for (final type in const [
      'user_message',
      'thinking_delta',
      'thinking_title',
      'text_delta',
      'tool_start',
      'tool_end',
      'context_compact',
      'done',
      'turn_started',
      'turn_heartbeat',
      'subagent_finished',
    ]) {
      expect(WsConn.worthLogging(type), isFalse, reason: type);
    }
  });

  test('the frames a log is read for still are', () {
    for (final type in const ['node_status', 'agent_created', 'turn_ended']) {
      expect(WsConn.worthLogging(type), isTrue, reason: type);
    }
  });
}
