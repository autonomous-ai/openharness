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
    // The made-up speech (2.2 s), then the model's own send after 5 s of quiet, then the scripted reply turn.
    runTo(97000);
    expect(model.talk, TalkPhase.listening);
    runTo(99000);
    expect(model.talk, isNot(TalkPhase.listening));
    expect(model.toast?.text, 'Sent to docs');
    expect(model.agentById('ag-docs')!.state, AgentState.working);
  });

  test('the manual demo on the real model: it opens at rest, a tap opens Apps, words to rate-limiter make it fail',
      () async {
    final clock = ManualDemoClock();
    final wall = DateTime(2026, 11, 18, 14, 32);
    final model = BarModel(clock: () => wall.add(Duration(milliseconds: clock.nowMs)));
    final demo = DemoLink(model, clock: clock, manual: true);
    model.link = demo;
    void runFor(int ms) {
      final end = clock.nowMs + ms;
      while (clock.nowMs < end) {
        clock.advance(100);
        model.tick();
      }
    }

    await demo.start();
    runFor(500);
    expect([model.page, model.mood], [BarPage.ambient, AmbientMood.quiet]);
    // The first tap on that Ambient opens Apps, every app of the mockup on it; a card brings its ring up.
    model.wake();
    runFor(500);
    expect([model.page, model.apps.length], [BarPage.apps, 11]);
    model.pickApp('orca');
    runFor(500);
    expect([model.page, model.shownApp], [BarPage.overview, 'orca']);

    model.tapCell('ag-rate');
    runFor(3000); // the made-up speech, then its quiet sends it
    final rate = model.agents.firstWhere((a) => a.name == 'rate-limiter');
    for (var waited = 0; waited < 20000 && rate.state != AgentState.failed; waited += 100) {
      runFor(100);
    }
    expect(rate.state, AgentState.failed);
    expect([model.page, model.attention?.kind], [BarPage.attention, AttnKind.failed]);
    runFor(10000);
    expect(model.page, BarPage.overview, reason: 'a failure\'s page goes after 8 s');
    runFor(60000);
    expect(model.page, BarPage.ambient, reason: 'nothing at work: a quiet minute rests it again');
  });
}
