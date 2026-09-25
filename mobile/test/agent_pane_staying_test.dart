import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/phone/agent_pane_prune.dart';
import 'package:harness_mobile/state/terminal_pane.dart';

/// What a pager's cap counts: the streams that STAY, not the ones its pending prune is about to
/// close. Counted, those left the ring's far side unattached after a swipe — see
/// [stayingAgentPanes].
void main() {
  AgentRef ref(String agentId) => (machineId: 'm', agentId: agentId);

  List<TerminalPane> panesFor(List<String?> agentIds) => [
    for (final (i, agentId) in agentIds.indexed)
      TerminalPane(id: i, machineId: 'm', agentId: agentId),
  ];

  int count(
    List<String?> open, {
    required Set<String> keeping,
    required Set<String> attached,
    Set<String> heldElsewhere = const {},
  }) => stayingAgentPanes(
    panesFor(open),
    keeping: {for (final id in keeping) ref(id)},
    attached: {for (final id in attached) ref(id)},
    heldElsewhere: (agent) => heldElsewhere.contains(agent.agentId),
  );

  test('leaves out what the pager attached and no longer keeps', () {
    // Landed on d: b was attached for the page before and falls out of d's keep-set.
    expect(
      count(
        ['b', 'c', 'd', 'e'],
        keeping: {'c', 'd', 'e'},
        attached: {'b', 'c', 'd', 'e'},
      ),
      3,
    );
  });

  test('counts a pane this pager never attached — someone else closes it', () {
    expect(
      count(['x', 'd'], keeping: {'d'}, attached: {'d'}),
      2,
      reason: 'x belongs to another pager or the desk, and stays open',
    );
  });

  test('counts a pane the prune spares for another pager', () {
    expect(
      count(
        ['b', 'd'],
        keeping: {'d'},
        attached: {'b', 'd'},
        heldElsewhere: {'b'},
      ),
      2,
    );
  });

  test('never counts a machine tile', () {
    expect(count([null, 'd'], keeping: {'d'}, attached: {'d'}), 1);
  });
}
