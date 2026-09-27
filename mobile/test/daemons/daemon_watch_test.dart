// What the daemon watches on a phone, read off the app: open questions (the
// machine's, or a dialog read off the screen), turns under way, and harnesses
// that failed to start. An offline machine is not a failure.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/daemon_scope.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/state/terminal_pane.dart';

import '../agent_pager_fixture.dart';

void main() {
  test('the daemon watches questions, turns and failed starts', () {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    final first = machine.agents.first.id;
    final second = machine.agents[1].id;

    var seen = observeDaemon(app);
    expect(seen.watch.needs, isEmpty);
    expect(seen.watch.working, isEmpty);
    expect(seen.facts.harnesses, machine.agents.length);

    machine.processingAgentIds.add(first);
    machine.blockedAgents[second] = PendingQuestion(
      machineId: 'm',
      agentId: second,
      requestId: 'q1',
      answerKey: 'k',
      prompt: 'Run the migration?',
      options: const ['yes', 'no'],
      multi: false,
      since: DateTime(2026),
    );
    seen = observeDaemon(app);
    expect(seen.watch.working, {'m/$first'});
    expect(seen.watch.needs, {'m/$second#q1'});
    expect(seen.facts.waiting.single.q, 'Run the migration?');

    // A dialog read off the screen counts, unless the machine said so already.
    seen = observeDaemon(
      app,
      onScreen: {
        'm/$second#pane:x': (who: 'b', q: 'again?'),
        'm/$first#pane:y': (who: 'a', q: 'Proceed?'),
      },
    );
    expect(seen.watch.needs, {'m/$second#q1', 'm/$first#pane:y'});
    expect(seen.facts.waiting, hasLength(2));

    // An offline machine is not a failure: the face stays as it was.
    machine.nodeOnline = false;
    seen = observeDaemon(app);
    expect(seen.watch.failing, isEmpty);
  });

  test('a harness open here that failed to start is a failure', () {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    final agent = machine.agents.first;
    machine.agents = [
      Agent(
        id: agent.id,
        name: agent.name,
        engine: 'claude',
        launchState: 'failed',
      ),
      ...machine.agents.skip(1),
    ];
    app.activeSwarm.panes.add(
      TerminalPane(id: 901, machineId: 'm', agentId: agent.id),
    );
    final seen = observeDaemon(app);
    expect(seen.watch.failing, {'m/${agent.id}'});
    expect(seen.facts.failing, [agent.name]);
  });
}
