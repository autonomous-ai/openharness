// The app in front and the bar's pick (max_demo.c FRONT, app.pick, agent.open): which app's ring the bar is shown.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/demo/demo_link.dart';
import 'package:harness_max_bar/model/types.dart';

import 'demo_support.dart';

void main() {
  test('Harness comes to the front at 70 s, Orca at 130 s: each its apps, its ring, its agents\' history', () async {
    final d = Demo();
    await d.start();
    d.runTo(69999);
    expect(d.all('apps').map((a) => a.text).toSet(), {'orca'});
    d.forget();
    d.runTo(70000);
    final apps = d.first('apps')!;
    expect(apps.text, 'harness');
    final ring = d.seen[d.seen.indexOf(apps) + 1];
    expect(ring.type, 'agents');
    expect(ring.text, 'firmware-max,harness-cli,docs');
    expect((ring['rows'] as List<AgentRow>).map((r) => '${r.host} ${r.caps}').toSet(), {'harness svfa'});
    expect(d.all('summary').map((s) => (s.agent, s['restore'])),
        [('ag-fw', true), ('ag-cli', true), ('ag-docs', true)]);

    d.forget();
    d.runTo(130000);
    expect(d.first('apps', text: 'orca')!.at, 130000);
    expect(d.all('agents').map((a) => (a.text, a.at)),
        [('auth-refactor,landing-hero,flaky-e2e,rate-limiter,docs-sweep', 130000)]);
  });

  test('a pick shows its app until the next front change, after the quiet minute', () async {
    final d = Demo();
    await d.start();
    d.runTo(10000);
    d.forget();
    d.link.pickApp('vscode');
    d.run(0);
    expect(d.first('apps')!.text, 'vscode');
    expect(d.first('agents')!.text, 'api-client');

    // The story waits a minute for the person, then reaches Harness's front change 60 s of story later.
    final front = d.runUntil('apps', text: 'harness');
    expect(front.at, 10000 + 60000 + 60000);
    expect(d.all('apps').where((a) => a.at < front.at).map((a) => a.text).toSet(), {'vscode'});
    expect(d.first('agents', text: 'firmware-max,harness-cli,docs'), isNotNull);
  });

  test('a pick holds through the story starting over, as the app in front does not change there', () async {
    final d = Demo();
    await d.start();
    d.runTo(140000);
    d.link.pickApp('harness');
    d.run(0);
    d.forget();
    // Orca is in front from 130 s and at the next telling's start: only its move back at 130 s ends the pick. Story
    // time stands for the quiet minute, then reaches the start over at 160 s and the next 130 s.
    // The story time between the demo's last tick and the touch (under a second) is not counted, as in max_demo.c.
    final orca = d.runUntil('apps', text: 'orca', ms: 300000);
    expect(orca.at, inInclusiveRange(140000 + 60000 + 20000 + 130000, 140000 + 60000 + 20000 + 130000 + kTickMs));
    expect(d.all('apps').where((a) => a.at < orca.at).map((a) => a.text).toSet(), {'harness'});
  });

  test('a pick of the app already shown changes nothing; one of an app with no agents is told the list again',
      () async {
    final d = Demo();
    await d.start();
    d.runTo(2000);
    d.forget();
    d.link.pickApp('orca');
    d.run(0);
    expect(d.count('apps') + d.count('agents'), 0);
    d.link.pickApp('herdr');
    d.run(0);
    expect(d.count('agents'), 0);
    expect(d.all('apps').map((a) => a.text), ['orca']);
  });

  test("opening another app's agent turns the bar to that app's ring", () async {
    final d = Demo();
    await d.start();
    d.runTo(5000);
    d.forget();
    d.link.openAgent('ag-cli');
    d.run(0);
    expect(d.first('apps')!.text, 'harness');
    expect(d.first('agents')!.text, 'firmware-max,harness-cli,docs');
    // The bar is on it already: the computer's focus is not said back.
    expect(d.count('focus'), 0);
  });

  test("the agent's app is brought to the front: the story's next front change, to Orca at its start, ends it",
      () async {
    final d = Demo();
    await d.start();
    d.runTo(140000);
    d.link.openAgent('ag-cli');
    d.run(0);
    expect(d.all('apps').last.text, 'harness');
    d.forget();
    // The quiet minute, then the story's start over puts Orca in front again (to the tick, as with a pick).
    final orca = d.runUntil('apps', text: 'orca', ms: 300000);
    expect(orca.at, inInclusiveRange(140000 + 60000 + 20000, 140000 + 60000 + 20000 + kTickMs));
  });

  test('a ring that comes back brings what its agents were doing: the turn, its words and clock, the question',
      () async {
    final d = Demo();
    await d.start();
    final asked = d.runUntil('question', agent: 'ag-hero');
    d.runTo(12000);
    d.link.pickApp('harness');
    d.run(0);
    d.forget();
    d.link.pickApp('orca');
    d.run(0);

    expect(d.first('agents')!.text, 'auth-refactor,landing-hero,flaky-e2e,rate-limiter,docs-sweep');
    final e2e = d.seen.where((s) => s.agent == 'ag-e2e').toList();
    expect([for (final s in e2e) s.type], ['summary', 'turn.started', 'turn.verb', 'turn.activity']);
    expect(e2e[0]['restore'], isTrue);
    expect(e2e[1].text, 'Working…');
    expect(e2e[2].text, 'Running tests');
    expect(e2e[3].text, 'Running the checkout test 20 times to catch the flake.');
    expect(e2e[3]['elapsed'], 6);

    final hero = d.seen.where((s) => s.agent == 'ag-hero').toList();
    expect(hero.last.type, 'question');
    expect(hero.last['id'], asked['id']);
    expect(hero.last.text, asked.text);
    // Resting agents bring only their history.
    expect(d.seen.where((s) => s.agent == 'ag-sweep').map((s) => s.type), ['summary']);
  });
}
