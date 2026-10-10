// Moving an agent in the window must reach the dial: every move re-sends `app_swarms` with the new
// member order and tile seating, even when the active tab and every count stay the same.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';

void main() {
  late AppNotifier app;
  late List<Map<String, dynamic>> sent;

  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    sent = [];
    app.dialAnnouncementSenderForTest = (type, payload) {
      if (type == 'app_swarms') sent.add(payload);
    };
    for (var i = 0; i < 4; i++) {
      app.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
    }
    app.persistLayoutForTest();
    sent.clear();
  });

  List<String> seats(Map<String, dynamic> p) => [
    for (final t in p['tiles'] as List) (t as Map)['agentId'] as String,
  ];

  test('reordering panes inside a tab re-sends the swarms with the new seating', () {
    app.reorderPane(0, 2);
    expect(sent, hasLength(1));
    expect(seats(sent.single), ['a2', 'a1', 'a0', 'a3']);
    final row = (sent.single['swarms'] as List).first as Map;
    expect(row['agentIds'], ['a2', 'a1', 'a0', 'a3']);
  });

  test('moving a pane to another tab re-sends both tabs\' members', () {
    final other = app.swarms.length;
    app.newSwarm(name: "Two");
    expect(app.swarms.length, other + 1);
    sent.clear();
    final from = app.swarms.first.id;
    final to = app.swarms.last.id;
    expect(app.movePaneToSwarm(0, to, sourceSwarmId: from, follow: false), isTrue);
    expect(sent, isNotEmpty);
    final rows = {
      for (final r in sent.last['swarms'] as List) (r as Map)['id']: r['agentIds'],
    };
    expect(rows[from], ['a1', 'a2', 'a3']);
    expect(rows[to], ['a0']);
  });
}
