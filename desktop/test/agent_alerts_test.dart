// The banners an agent's news appears in: when one is raised, which one it replaces, when it goes
// away on its own, and what clicking it does.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String?>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  late DateTime clock;

  ScreenAlertStore store({bool on = true}) {
    final made = ScreenAlertStore(storage: _Memory());
    made.value = on;
    return made;
  }

  AgentAlerts alerts({ScreenAlertStore? on, int visible = 3}) {
    clock = DateTime(2026, 9, 23, 12);
    return AgentAlerts(
      store: on ?? store(),
      now: () => clock,
      life: const Duration(seconds: 7),
      visible: visible,
    );
  }

  AgentAlert alert(String agentId, {AlertKind kind = AlertKind.done, String? title}) =>
      AgentAlert(
        machineId: 'm1',
        agentId: agentId,
        title: title ?? agentId,
        kind: kind,
        at: clock,
      );

  test('the banner is ON by default — it is the half that says WHICH agent', () {
    expect(ScreenAlertStore(storage: _Memory()).value, isTrue);
  });

  test('newest first, because that is the order they are read in', () {
    final queue = alerts();
    queue.post(alert('a'));
    clock = clock.add(const Duration(seconds: 1));
    queue.post(alert('b'));
    expect(queue.alerts.map((a) => a.agentId), ['b', 'a']);
  });

  test('one banner per agent: a busy one replaces its own last message', () {
    // Otherwise a single chatty agent fills the stack and every other agent's news falls off it.
    final queue = alerts();
    queue.post(alert('a', kind: AlertKind.done));
    clock = clock.add(const Duration(seconds: 1));
    queue.post(alert('a', kind: AlertKind.needsYou));
    expect(queue.alerts, hasLength(1));
    expect(queue.alerts.single.kind, AlertKind.needsYou);
  });

  test('past the cap the OLDEST goes, not the newest', () {
    final queue = alerts(visible: 2);
    for (final id in ['a', 'b', 'c']) {
      queue.post(alert(id));
      clock = clock.add(const Duration(seconds: 1));
    }
    expect(queue.alerts.map((a) => a.agentId), ['c', 'b']);
  });

  test('a banner withdraws on its own once its life is up', () {
    final queue = alerts();
    queue.post(alert('a'));
    expect(queue.alerts, hasLength(1));
    clock = clock.add(const Duration(seconds: 8));
    queue.post(alert('b'));
    // Posting sweeps: the one that has outlived its welcome goes with it.
    expect(queue.alerts.map((a) => a.agentId), ['b']);
  });

  test('the newer banner does not inherit the older one’s clock', () {
    // A stack that expired as one would take a fresh notice down with a stale one.
    final queue = alerts();
    queue.post(alert('a'));
    clock = clock.add(const Duration(seconds: 6));
    queue.post(alert('b'));
    clock = clock.add(const Duration(seconds: 2));
    queue.post(alert('c'));
    expect(queue.alerts.map((a) => a.agentId), ['c', 'b']);
  });

  test('dismissing takes one down and leaves the rest', () {
    final queue = alerts();
    queue.post(alert('a'));
    queue.post(alert('b'));
    queue.dismiss(alert('a'));
    expect(queue.alerts.map((a) => a.agentId), ['b']);
  });

  test('nothing is raised while the switch is off', () {
    final queue = alerts(on: store(on: false));
    queue.post(alert('a'));
    expect(queue.alerts, isEmpty);
  });

  test('each kind says what it is, and they do not say the same thing', () {
    expect(alerts().runtimeType, AgentAlerts);
    final done = AgentAlert(
      machineId: 'm', agentId: 'a', title: 'A', kind: AlertKind.done, at: clock,
    );
    final waiting = AgentAlert(
      machineId: 'm', agentId: 'a', title: 'A', kind: AlertKind.needsYou, at: clock,
    );
    expect(done.sentence, isNotEmpty);
    expect(waiting.sentence, isNotEmpty);
    expect(done.sentence, isNot(waiting.sentence));
  });

  test('two agents with the same name are still two banners', () {
    // The key is the machine and the agent, never the title — a swarm of "Codex" panes is the
    // ordinary case, and collapsing them would hide every one but the last.
    final queue = alerts();
    queue.post(alert('a', title: 'Codex'));
    queue.post(alert('b', title: 'Codex'));
    expect(queue.alerts, hasLength(2));
  });
}
