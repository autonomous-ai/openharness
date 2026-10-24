import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart'
    show SharedTabsFailure, unreachableComputerFor;
import 'package:harness/agent_messages/tab_activity.dart';
import 'package:harness/ws/ws_conn.dart' show WsRequestFailure;

void main() {
  test('reads a tab\'s harnesses with state, summary and away', () async {
    final asked = <Map<String, dynamic>>[];
    final reader = TabActivityReader(
      request: (payload) async {
        asked.add(payload);
        return {
          'harnesses': [
            {'machineId': 'm1', 'agentId': 'a1', 'state': 'working', 'summary': 'fix the build'},
            {'machineId': 'm1', 'agentId': 'a2', 'state': 'idle'},
            {'machineId': 'm2', 'agentId': 'a3', 'state': 'unknown', 'away': true},
          ],
        };
      },
    );
    final rows = await reader.read('tab-1');
    expect(asked, [
      {'action': 'tab_activity', 'tabId': 'tab-1'},
    ]);
    expect([for (final r in rows) (r.machineId, r.agentId, r.state, r.summary, r.away)], [
      ('m1', 'a1', TabHarnessState.working, 'fix the build', false),
      ('m1', 'a2', TabHarnessState.idle, null, false),
      ('m2', 'a3', TabHarnessState.unknown, null, true),
    ]);
  });

  test('drops malformed rows; an unknown state or empty summary is unknown / none', () async {
    final reader = TabActivityReader(
      request: (_) async => {
        'harnesses': [
          'nope',
          {'machineId': '', 'agentId': 'a'},
          {'machineId': 'm', 'agentId': 5},
          {'machineId': 'm', 'agentId': 'ok', 'state': 'sleeping', 'summary': ''},
          {'machineId': 'm', 'agentId': 'x', 'state': 'idle', 'summary': 7, 'away': 'yes'},
        ],
      },
    );
    final rows = await reader.read('t');
    expect([for (final r in rows) (r.agentId, r.state, r.summary, r.away)], [
      ('ok', TabHarnessState.unknown, null, false),
      ('x', TabHarnessState.idle, null, false),
    ]);
  });

  test('an answer without a list is nothing', () async {
    expect(await TabActivityReader(request: (_) async => {}).read('t'), isEmpty);
    expect(await TabActivityReader(request: (_) async => {'harnesses': 3}).read('t'), isEmpty);
  });

  test('a refusal is a SharedTabsFailure with the daemon\'s code; other errors mean unreachable', () async {
    final refused = TabActivityReader(
      request: (_) => Future.error(
        const WsRequestFailure(
          responseType: 'agent_messages_result',
          code: 'NOT_A_TAB',
          detail: 'That tab is not on your desk.',
        ),
      ),
    );
    await expectLater(
      refused.read('t'),
      throwsA(
        isA<SharedTabsFailure>()
            .having((e) => e.code, 'code', 'NOT_A_TAB')
            .having((e) => e.message, 'message', 'That tab is not on your desk.'),
      ),
    );
    final bare = TabActivityReader(
      request: (_) => Future.error(
        const WsRequestFailure(responseType: 'x', code: 'MESSAGES_OFF'),
      ),
    );
    await expectLater(
      bare.read('t'),
      throwsA(isA<SharedTabsFailure>().having((e) => e.message, 'message', 'MESSAGES_OFF')),
    );
    final down = TabActivityReader(request: (_) => Future.error(StateError('closed')));
    await expectLater(
      down.read('t'),
      throwsA(isA<SharedTabsFailure>().having((e) => e.code, 'code', 'UNAVAILABLE')),
    );
    // On Desktop the daemon asked is this computer's, and the line says so, as it always has.
    await expectLater(
      down.read('t'),
      throwsA(isA<SharedTabsFailure>().having(
        (e) => e.message,
        'message',
        'Harness could not reach this computer. Check that it is online, then try again.',
      )),
    );
  });

  test('a browser is not a computer: it says your computer instead (P3)', () {
    expect(
      unreachableComputerFor(viewer: true),
      'Harness could not reach your computer. Check that it is online, then try again.',
    );
    expect(
      unreachableComputerFor(viewer: false),
      'Harness could not reach this computer. Check that it is online, then try again.',
    );
  });
}
