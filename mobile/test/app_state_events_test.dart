import 'package:flutter_test/flutter_test.dart';

import 'agent_pager_fixture.dart';

/// What a machine's pushes do to the screens listening to the app.
void main() {
  test('live chat the app does not read redraws nothing', () async {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    var redraws = 0;
    app.addListener(() => redraws++);

    for (final type in ['text_delta', 'tool_start', 'tool_end']) {
      await app.handleEventForTest('m', {
        'type': type,
        'agentId': 'a',
        'payload': {'content': 'streaming'},
      });
    }

    expect(redraws, 0);
  });

  test('a push the app does read still redraws', () async {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    var redraws = 0;
    app.addListener(() => redraws++);

    await app.handleEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a',
      'payload': <String, dynamic>{},
    });

    expect(redraws, 1);
  });

  test('a phone tells no machine which agent it is looking at', () async {
    final conn = PagerConn();
    final app = pagerApp(conn);
    addTearDown(app.dispose);
    await liveAgent(app, 'b');

    app.focusPane(app.paneOfAgent('m', 'b')!.id);

    expect(
      [for (final (type, _) in conn.frames) type],
      isNot(anyOf(contains('app_focus'), contains('app_panes'))),
      reason: 'only the CLI\'s loopback reads these; the relay carries them in the clear',
    );
  });
}
