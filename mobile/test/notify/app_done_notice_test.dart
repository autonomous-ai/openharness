import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/state/app_state.dart';

import '../agent_pager_fixture.dart';

/// The dial's rule, end to end: frames off the machine socket into the marks
/// the phone draws.
void main() {
  /// One whole turn of [agentId], as the machine streams it.
  Future<void> turn(
    AppNotifier app,
    String agentId, {
    String? reply = 'Fixed the login screen.',
    Map<String, dynamic> end = const {},
    Map<String, dynamic> endPayload = const {},
  }) async {
    Future<void> send(String type, [Map<String, dynamic> payload = const {}]) =>
        app.handleEventForTest('m', {
          'type': type,
          'agentId': agentId,
          ...(type == 'turn_ended' ? end : const {}),
          'payload': {...payload},
        });
    await send('turn_started', {'userMessage': 'fix it'});
    if (reply != null) await send('text_delta', {'content': reply});
    await send('turn_ended', endPayload);
  }

  bool unread(AppNotifier app, String agentId) =>
      app.doneNotices.unread.contains((machineId: 'm', agentId: agentId));

  late AppNotifier app;

  setUp(() async {
    app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    await liveAgent(app, 'a');
  });

  test('an agent finishing elsewhere is marked', () async {
    await turn(app, 'b');
    expect(unread(app, 'b'), isTrue);
    expect(app.doneNotices.unread.count, 1);
  });

  test('the agent on screen is never marked', () async {
    await turn(app, 'a');
    expect(unread(app, 'a'), isFalse);
  });

  test('what the dial stays quiet about, the phone does too', () async {
    await turn(app, 'b', reply: null);
    await turn(app, 'b', endPayload: {'aborted': true});
    await turn(app, 'b', end: {'subagent': true});
    await turn(app, 'b', end: {'replay': true});
    expect(app.doneNotices.unread.count, 0);
  });

  test('a turn with nothing to say does not borrow the last one', () async {
    await turn(app, 'b');
    app.doneNotices.unread.clearAll();
    await turn(app, 'b', reply: null);
    expect(unread(app, 'b'), isFalse);
  });

  test('going to the agent reads its news', () async {
    await turn(app, 'b');
    await liveAgent(app, 'b');
    expect(unread(app, 'b'), isFalse);
  });

  test('a deleted agent takes its mark with it', () async {
    await turn(app, 'b');
    await app.handleEventForTest('m', {
      'type': 'agent_deleted',
      'agentId': 'b',
      'payload': <String, dynamic>{},
    });
    expect(unread(app, 'b'), isFalse);
  });
}
