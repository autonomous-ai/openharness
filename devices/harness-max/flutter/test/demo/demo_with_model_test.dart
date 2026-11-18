// The demo with the real BarModel, as the app runs it: the story reaches the pages' state. It needs BarModel's inputs
// and intents (implemented on feat/harness-max-v3-model); until they land, BarModel throws and this test fails.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/demo/demo_link.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';

import 'demo_support.dart';

void main() {
  test('the story on the real model: Orca, its shown question, Harness in front, an answer and a talk', () async {
    final clock = ManualDemoClock();
    final wall = DateTime(2026, 11, 18, 14, 32);
    final model = BarModel(clock: () => wall.add(Duration(milliseconds: clock.nowMs)));
    final demo = DemoLink(model, clock: clock);
    model.link = demo;
    // As main.dart: the model's clocks tick ten times a second.
    void runTo(int ms) {
      while (clock.nowMs < ms) {
        clock.advance(100);
        model.tick();
      }
    }

    await demo.start();
    runTo(500);
    expect(model.connected, isTrue);
    expect(model.computer, 'MacBook Pro');
    expect(model.shownApp, 'orca');
    expect(model.agents.map((a) => a.name),
        ['auth-refactor', 'landing-hero', 'flaky-e2e', 'rate-limiter', 'docs-sweep']);

    runTo(10500);
    final hero = model.askOf('ag-hero')!;
    expect(hero.path, AskPath.shown);
    expect(hero.app, 'Orca');
    expect(model.agentById('ag-hero')!.state, AgentState.asking);
    runTo(22500);
    expect(model.askOf('ag-hero'), isNull);

    runTo(71000);
    expect(model.shownApp, 'harness');
    expect(model.agents.map((a) => a.name), ['firmware-max', 'harness-cli', 'docs']);

    runTo(79000);
    final cli = model.askOf('ag-cli')!;
    expect(cli.path, AskPath.reviewed);
    expect(cli.phase, AskPhase.ready);
    expect(model.attention?.agentId, 'ag-cli');
    model.choose(1);
    runTo(90000);
    expect(model.agentById('ag-cli')!.said, contains('stays at 3'));

    // firmware-max's permission prompt has the glass now: Allow, and the bar goes back to Overview.
    expect(model.askOf('ag-fw')?.permission, isTrue);
    model.allow();
    runTo(90100);
    model.tapCell('ag-docs');
    runTo(90300);
    expect(model.talk, TalkPhase.listening);
    // The made-up speech, then the model's own send after the quiet, then the scripted reply turn.
    runTo(96000);
    expect(model.talk, isNot(TalkPhase.listening));
    expect(model.toast?.text, 'Sent to docs');
    expect(model.agentById('ag-docs')!.state, AgentState.working);
  });
}
