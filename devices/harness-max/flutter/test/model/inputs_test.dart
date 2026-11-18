// What the computer's inputs do to the agents (test_max_model.c): the link, the ring, the apps, turns, questions and
// summaries, and Overview's pages of cells.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';

import 'bar_harness.dart';

void main() {
  test('a fresh bar is Ambient and says no computer is on the cable', () {
    final m = TestBar().model;
    expect(m.page, BarPage.ambient);
    expect(m.mood, AmbientMood.notConnected);
    expect(m.connected, isFalse);
    expect(m.talk, TalkPhase.off);
    expect(m.toast, isNull);
  });

  test('the link going down takes what the daemon said; Inbox stays', () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    expect(m.connected, isTrue);
    expect(m.page, BarPage.ambient, reason: 'no agents yet');
    expect(m.mood, AmbientMood.noAgents);
    var n = b.notes;
    m.onLink(true, computer: 'MacBook Pro');
    expect(b.notes, n, reason: 'the same welcome again is no change');
    m.onLink(true, computer: 'Mac Studio');
    expect(m.computer, 'Mac Studio');
    m.onApps('orca', const [AppInfo(id: 'orca', name: 'Orca', count: 5)]);
    m.onAgents(rows(abcde));
    expect(m.page, BarPage.overview);
    expect(m.mood, AmbientMood.quiet);
    m.onTurn('b', 'started', '');
    m.onTurn('c', 'error', 'boom');
    expect(m.page, BarPage.attention);
    expect(m.attention!.agentId, 'c');

    m.onLink(false);
    expect(m.connected, isFalse);
    expect(m.computer, '');
    expect(m.agents, isEmpty);
    expect(m.cellPage, 0);
    expect(m.page, BarPage.ambient);
    expect(m.mood, AmbientMood.notConnected);
    expect(m.attention, isNull);
    expect(m.apps, isEmpty);
    expect(m.appsKnown, isFalse);
    expect(m.inbox.single.agentId, 'c');
    n = b.notes;
    m.onLink(false);
    expect(b.notes, n);
  });

  test('a new ring keeps the agents that stay, with their turns; names, apps and caps follow the rows', () {
    final b = linked(abc), m = b.model;
    b.at(100);
    m.onTurn('b', 'activity', 'Editing touch.c', elapsedS: 12);
    final n = b.notes;
    m.onAgents(rows(abc));
    expect(b.notes, n, reason: 'the same ring is no change');
    final stays = m.agentById('b');
    b.at(300);
    m.onAgents(const [
      AgentRow(id: 'c', name: 'c', engine: 'codex', host: 'orca', caps: 'sv'),
      AgentRow(id: 'b', name: 'backend', engine: 'claude'),
      AgentRow(id: 'd', name: 'd', engine: 'claude', host: 'harness', caps: ''),
    ]);
    expect(m.agents.map((a) => a.id), ['c', 'b', 'd']);
    final c = m.agentById('c')!;
    expect([c.engine, c.host], ['codex', 'orca']);
    expect([c.caps.voice, c.caps.focus, c.caps.answer], [true, false, false]);
    final bb = m.agentById('b')!;
    expect(identical(bb, stays), isTrue);
    expect(bb.name, 'backend');
    expect(bb.state, AgentState.working);
    expect(bb.activity, 'Editing touch.c');
    expect([bb.caps.voice, bb.caps.focus, bb.caps.answer], [true, true, true], reason: 'left out: all of them');
    final d = m.agentById('d')!;
    expect(d.state, AgentState.idle);
    expect([d.caps.voice, d.caps.focus, d.caps.answer], [false, false, false]);
    expect(d.since, b.now);
    expect(m.agentById('a'), isNull);

    // The agent page's agent leaves the ring: its page goes, back to Overview.
    m.tapCell('d');
    expect(m.page, BarPage.agent);
    m.onAgents(rows(['c', 'b']));
    expect(m.page, BarPage.overview);
    expect(m.selectedId, isNull);

    // An absent name reads as the id; an empty id is nobody; a repeated id is kept once; rows past 32 are dropped.
    m.onAgents([
      const AgentRow(id: '', name: 'nobody'),
      for (var i = 0; i < 35; i++) AgentRow(id: i == 1 ? 'x0' : 'x$i', name: ''),
    ]);
    expect(m.agents.length, 32);
    expect(m.agents[0].name, 'x0');
    expect(m.agents[1].id, 'x2');

    // The ring empties: nothing to show but Ambient's "No agents yet".
    m.onAgents(const []);
    expect(m.agents, isEmpty);
    expect(m.page, BarPage.ambient);
    expect(m.mood, AmbientMood.noAgents);
  });

  test('turns: the clock, the spinner word, the activity, the steps and the end', () {
    final b = linked(abc), m = b.model;
    m.onTurn('zz', 'started', '');
    b.at(1000);
    m.onTurn('a', 'started', 'Reading the issue');
    final a = m.agentById('a')!;
    expect(a.state, AgentState.working);
    expect(a.since, at(1000));
    expect(a.activity, 'Reading the issue');
    expect(m.clockOf(a), 0);
    b.at(3999);
    expect(m.clockOf(a), 2);

    b.at(1100);
    m.onTurn('a', 'verb', 'Infusing…');
    expect(a.verb, 'Infusing');
    b.at(1200);
    m.onTurn('a', 'verb', 'Thinking...');
    expect(a.verb, 'Thinking');
    final n = b.notes;
    b.at(1300);
    m.onTurn('a', 'verb', 'Thinking...');
    expect(b.notes, n, reason: 'the same word is no change');

    // An activity rebases the clock on the daemon's count; an empty one says nothing new.
    b.at(5000);
    m.onTurn('a', 'activity', 'Editing pod_model.c', elapsedS: 125);
    expect(a.activity, 'Editing pod_model.c');
    expect(m.clockOf(a), 125);
    b.at(14000);
    expect(m.clockOf(a), 134);
    b.at(6000);
    m.onTurn('a', 'activity', '');
    expect(a.activity, 'Editing pod_model.c');
    expect(m.clockOf(a), 126);

    // Steps: oldest first, a repeat moves to the end, three kept; "Verb · detail", or a verb alone.
    for (final s in ['Read · a.c', 'Edit · b.c', 'Bash · make', 'Read · a.c', 'Grep · TODO']) {
      m.onTurn('a', 'step', s);
    }
    expect(a.steps.map((s) => '${s.verb}|${s.detail}'), ['Bash|make', 'Read|a.c', 'Grep|TODO']);
    m.onTurn('a', 'step', 'TodoWrite');
    expect([a.steps.last.verb, a.steps.last.detail], ['TodoWrite', '']);
    m.onTurn('a', 'step', '');
    expect(a.steps.length, 3);

    // done: the clock stops where it was.
    b.at(10000);
    m.onTurn('a', 'done', '');
    expect(a.state, AgentState.done);
    expect(m.clockOf(a), 130);
    b.at(99000);
    expect(m.clockOf(a), 130);
    expect(a.since, at(10000), reason: 'progress in between changed no state');

    // error: its words, the clock stopped; the next turn clears it.
    b.at(0);
    m.onTurn('b', 'started', '');
    b.at(61000);
    m.onTurn('b', 'error', 'pnpm test exited with 1');
    final bb = m.agentById('b')!;
    expect(bb.state, AgentState.failed);
    expect(bb.said, 'pnpm test exited with 1');
    b.at(90000);
    expect(m.clockOf(bb), 61);
    b.at(95000);
    m.onTurn('b', 'started', '');
    expect(bb.state, AgentState.working);
    expect([bb.said, bb.verb], ['', '']);
    expect(bb.steps, isEmpty);

    // An agent with no turn seen has no clock until the daemon gives one.
    b.at(100);
    m.onTurn('c', 'verb', 'Musing');
    expect(m.agentById('c')!.state, AgentState.working);
    expect(m.clockOf(m.agentById('c')!), isNull);
  });

  test('a question: progress waits while it asks, the clock runs on, its close lets the turn go on', () {
    final b = linked(abc), m = b.model;
    const migrate = 'Run the migration on the dev database now?';
    m.onTurn('b', 'started', '');
    b.at(1000);
    m.onQuestion('b', 'r1', migrate);
    final a = m.agentById('b')!;
    expect(a.state, AgentState.asking);
    expect(a.said, migrate);
    expect(m.asks['b']!.path, AskPath.computer);
    var n = b.notes;
    b.at(1100);
    m.onQuestion('b', 'r1', migrate);
    expect(b.notes, n, reason: 'the same question again keeps its place');
    expect(m.asks['b']!.since, at(1000));
    b.at(1200);
    m.onQuestion('b', 'r2', migrate);
    expect(m.asks['b']!.since, at(1200));

    b.at(2000);
    m.onTurn('b', 'activity', 'Migrating', elapsedS: 3);
    m.onTurn('b', 'step', 'Bash · migrate');
    expect(a.state, AgentState.asking);
    expect(a.activity, '');
    expect(a.steps, isEmpty);
    b.at(5000);
    expect(m.clockOf(a), 5);

    m.onQuestionClose('b');
    expect(a.state, AgentState.working);
    expect(a.said, '');
    expect(m.asks['b'], isNull);
    n = b.notes;
    m.onQuestionClose('b');
    expect(b.notes, n);
    m.onQuestion('zz', 'r', '?');
    expect(m.asks['zz'], isNull);

    // A turn that ends while it asks ends the question too.
    b.at(6000);
    m.onQuestion('b', 'r3', 'Push?');
    b.at(7000);
    m.onTurn('b', 'done', '');
    expect(a.state, AgentState.done);
    expect(a.said, '');
    expect(m.asks['b'], isNull);
  });

  test('summaries: alert and list end the turn with their words, silent without; restore is never news', () {
    final b = linked(abcde), m = b.model;
    m.onTurn('a', 'started', '');
    b.at(1000);
    m.onSummary('a', 'Fixed the login race', recap: 'Long recap');
    expect(m.agentById('a')!.state, AgentState.done);
    expect(m.agentById('a')!.said, 'Fixed the login race');
    m.onTurn('b', 'started', '');
    m.onSummary('b', 'Docs updated', tier: SummaryTier.list);
    expect([m.agentById('b')!.state, m.agentById('b')!.said], [AgentState.done, 'Docs updated']);
    m.onTurn('c', 'started', '');
    m.onSummary('c', 'Sub-agent finished', tier: SummaryTier.silent);
    expect([m.agentById('c')!.state, m.agentById('c')!.said], [AgentState.done, '']);

    final n = b.notes;
    m.onSummary('d', 'Old news', recap: 'Old recap', restore: true, tier: SummaryTier.silent);
    expect(b.notes, n);
    expect([m.agentById('d')!.state, m.agentById('d')!.said], [AgentState.idle, '']);

    // "done" is the daemon's placeholder: the recap speaks instead.
    m.onSummary('d', 'done', recap: 'The recap');
    expect(m.agentById('d')!.said, 'The recap');

    // A failed turn keeps its error; with none, the summary says what happened.
    m.onTurn('e', 'error', 'Build failed');
    m.onSummary('e', 'Gave up');
    expect([m.agentById('e')!.state, m.agentById('e')!.said], [AgentState.failed, 'Build failed']);
    m.onTurn('e', 'error', '');
    m.onSummary('e', 'Could not reach the API');
    expect(m.agentById('e')!.said, 'Could not reach the API');
    m.onSummary('zz', 'x');
  });

  test("Overview pages its cells five at a time, in the ring's order, within the pages there are", () {
    final b = linked(xs.sublist(0, 11)), m = b.model;
    expect(m.cellPages, 3);
    expect(m.cellPage, 0);
    expect(m.cells.map((a) => a.id), xs.sublist(0, 5));
    m.cellPage = 2;
    expect(m.cells.single.id, 'x10');
    m.onQuestion('x6', 'r1', 'Ok?');
    expect([m.pageWaits(0), m.pageWaits(1), m.pageWaits(2)], [false, true, false]);
    m.onAgents(rows(xs.sublist(0, 6)));
    expect([m.cellPages, m.cellPage], [2, 1]);
    m.onAgents(rows(xs.sublist(0, 2)));
    expect([m.cellPages, m.cellPage], [1, 0]);

    // Another app's ring starts on its first page; the same app keeps the page.
    m.onAgents(rows(xs.sublist(0, 11)));
    m.cellPage = 2;
    const apps = [AppInfo(id: 'orca', name: 'Orca', count: 11), AppInfo(id: 'vscode', name: 'VS Code', count: 2)];
    m.onApps('orca', apps);
    expect(m.cellPage, 0);
    m.cellPage = 2;
    m.onApps('orca', apps);
    expect(m.cellPage, 2);
    m.onApps('vscode', apps);
    expect(m.cellPage, 0);
    m.onAgents(const []);
    expect([m.cellPages, m.cellPage], [0, 0]);
  });

  test("apps: the shown app names the column, and only another app makes an Apps page", () {
    final b = linked(['a']), m = b.model;
    expect(m.appLabel, 'MacBook Pro');
    expect(m.hasOtherApps, isFalse);
    const bare = [AppInfo(id: 'orca', name: '', count: -2, waiting: -1)];
    m.onApps('orca', bare);
    expect([m.apps.single.name, m.apps.single.count, m.apps.single.waiting], ['orca', 0, 0]);
    expect(m.appLabel, 'orca');
    expect(m.hasOtherApps, isFalse);
    final n = b.notes;
    m.onApps('orca', bare);
    expect(b.notes, n, reason: 'the same list is no change');
    m.onApps('orca', const [AppInfo(id: 'orca', name: 'Orca', count: 1), AppInfo(id: 'vscode', name: 'VS Code')]);
    expect(m.appLabel, 'Orca');
    expect(m.appOf(m.agentById('a')), 'Orca');
    expect(m.hasOtherApps, isTrue);
  });

  test("the computer's window moving is not a person at the bar: no page changes", () {
    final b = linked(abc), m = b.model;
    final n = b.notes;
    m.onFocus('b');
    expect(m.page, BarPage.overview);
    expect(b.notes, n);
  });

  test("the daemon's toast is a line at the bar's foot for 3 s; an empty one clears it", () {
    final b = linked(abc), m = b.model;
    b.at(100);
    m.onToast('Permission prompts cannot be answered from here.');
    expect(m.toast!.text, 'Permission prompts cannot be answered from here.');
    expect(m.toast!.until, at(3100));
    expect(m.toast!.agentId, isNull);
    b.at(3099);
    m.tick();
    expect(m.toast, isNotNull);
    b.at(3100);
    m.tick();
    expect(m.toast, isNull);
    m.onToast('Voice failed');
    m.onToast('');
    expect(m.toast, isNull);
  });

  test('the computer turning the bar to another app says so, as the mockup; a pick on the bar or the first apps do not',
      () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    const both = [AppInfo(id: 'orca', name: 'Orca', count: 5), AppInfo(id: 'harness', name: 'Harness', count: 3)];
    m.onApps('orca', both);
    m.onAgents(rows(abcde));
    expect(m.toast, isNull, reason: 'the first app shown is no news');
    m.onApps('orca', both);
    expect(m.toast, isNull, reason: 'the same app again is no change');
    m.onApps('harness', both);
    expect(m.toast?.text, 'Following Harness on your Mac');

    m.toast = null;
    m.openApps();
    m.pickApp('orca');
    m.onApps('orca', both);
    expect(m.toast, isNull, reason: 'the person picked it on the bar');
  });
}
