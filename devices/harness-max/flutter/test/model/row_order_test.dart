// The row's order of need (the owner's call, 19 Nov): waiting on the person first, then at work, failed, done, resting.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';

import 'bar_harness.dart';

List<String> ids(List<Agent> as) => [for (final a in as) a.id];

void put(BarModel m, Map<String, AgentState> states) {
  for (final e in states.entries) {
    m.agentById(e.key)!.state = e.value;
  }
}

void main() {
  test('the row lists asking, working, failed, done, then resting agents', () {
    final b = linked(abcde);
    put(b.model, {
      'a': AgentState.idle,
      'b': AgentState.done,
      'c': AgentState.failed,
      'd': AgentState.working,
      'e': AgentState.asking,
    });
    expect(ids(b.model.row), ['e', 'd', 'c', 'b', 'a']);
    // The ring itself keeps the daemon's order.
    expect(ids(b.model.agents), abcde);
  });

  test('agents in the same state keep the ring order', () {
    final b = linked(abcde);
    put(b.model, {'a': AgentState.done, 'b': AgentState.asking, 'c': AgentState.done, 'd': AgentState.asking});
    expect(ids(b.model.row), ['b', 'd', 'a', 'c', 'e']);
  });

  test('a state that changes moves its agent while no agent is open', () {
    final b = linked(abc);
    expect(ids(b.model.row), abc);
    put(b.model, {'c': AgentState.asking});
    expect(ids(b.model.row), ['c', 'a', 'b']);
  });

  test('while an agent is open the row holds the order it opened on', () {
    final b = linked(abcde);
    put(b.model, {'b': AgentState.working});
    b.model.tapCell('d');
    expect(b.model.page, BarPage.agent);
    expect(ids(b.model.row), ['b', 'a', 'c', 'd', 'e']);

    put(b.model, {'e': AgentState.asking, 'b': AgentState.done});
    expect(ids(b.model.row), ['b', 'a', 'c', 'd', 'e'], reason: 'the slivers beside the open agent stay put');

    // Another agent opened beside it keeps the same hold (the mic stopped first: while it listens a tap sends).
    b.model.cancelTalk();
    b.model.tapSliver('a');
    expect(b.model.selectedId, 'a');
    expect(ids(b.model.row), ['b', 'a', 'c', 'd', 'e']);

    b.model.closeAgent();
    expect(b.model.page, BarPage.overview);
    expect(ids(b.model.row), ['e', 'b', 'a', 'c', 'd'], reason: 'closed, the row takes the order of need again');
  });

  test('while held, an agent that leaves goes and one that comes is put at the end by need', () {
    final b = linked(abc);
    b.model.tapCell('a');
    expect(ids(b.model.row), abc);

    b.model.onAgents(rows(['a', 'c', 'n', 'w']));
    put(b.model, {'w': AgentState.working});
    expect(ids(b.model.row), ['a', 'c', 'w', 'n']);
  });
}
