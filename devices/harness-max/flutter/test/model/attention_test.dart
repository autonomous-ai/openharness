// Who takes the glass (test_max_model.c): Attention for a question, a failure or an alert's summary, the oldest
// question first; only the toast and the bell while a person talks; Inbox; Ambient; and the pages told only of what
// changed.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/bar_link.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';

import 'bar_harness.dart';

void main() {
  test('a new question takes Attention; others wait their turn and take it oldest first', () {
    final b = linked(abcde), m = b.model;
    m.onTurn('a', 'started', '');
    b.at(1000);
    m.onQuestion('c', 'r1', 'Deploy?');
    expect(m.page, BarPage.attention);
    expect([m.attention!.agentId, m.attention!.kind, m.attention!.since], ['c', AttnKind.ask, at(1000)]);
    expect(m.toast, isNull);
    // Sent again: no news, and the page keeps its time.
    b.at(1500);
    m.onQuestion('c', 'r1', 'Deploy?');
    expect(m.attention!.since, at(1000));
    expect(m.inbox.length, 1);
    // c's is up: d's and b's wait, d's the older.
    b.at(2000);
    m.onQuestion('d', 'r2', 'Merge?');
    b.at(3000);
    m.onQuestion('b', 'r3', 'Push?');
    expect(m.attention!.agentId, 'c');
    expect(m.inbox.length, 3);
    // c's answered on the computer: the question that has waited longest takes the page.
    b.at(4000);
    m.onQuestionClose('c');
    expect([m.attention!.agentId, m.attention!.since], ['d', at(4000)]);
    // c asks again: it waits behind d's. d's own new one takes its page again, from its time.
    b.at(4500);
    m.onQuestion('c', 'r4', 'Deploy now?');
    expect(m.attention!.agentId, 'd');
    b.at(5000);
    m.onQuestion('d', 'r5', 'Merge now?');
    expect([m.attention!.agentId, m.attention!.since], ['d', at(5000)]);
    // d leaves the ring: b's (3000) has waited longer than c's (4500).
    b.at(6000);
    m.onAgents(rows(abc));
    expect(m.attention!.agentId, 'b');
    // None waits: Overview.
    m.onQuestionClose('b');
    expect(m.attention!.agentId, 'c');
    m.onQuestionClose('c');
    expect(m.page, BarPage.overview);
    expect(m.attention, isNull);
  });

  test('a failure and an alert summary take Attention and go back by themselves after 8 s; quieter ones do not', () {
    final b = linked(abcde), m = b.model;
    m.onTurn('a', 'started', '');
    b.at(1000);
    m.onTurn('a', 'error', 'pnpm test exited with 1');
    expect([m.page, m.attention!.agentId, m.attention!.kind], [BarPage.attention, 'a', AttnKind.failed]);
    b.at(8999);
    m.tick();
    expect(m.page, BarPage.attention);
    b.at(9000);
    m.tick();
    expect(m.page, BarPage.overview);
    expect(m.attention, isNull);

    // A list or a silent summary only shows on its agent; history is never news.
    b.at(10000);
    m.onTurn('b', 'started', '');
    b.at(11000);
    m.onSummary('b', 'Docs updated', tier: SummaryTier.list);
    m.onTurn('c', 'started', '');
    m.onSummary('c', 'Sub-agent finished', tier: SummaryTier.silent);
    b.at(12000);
    m.onSummary('d', 'Old news', recap: 'Old recap', restore: true);
    expect(m.page, BarPage.overview);
    expect(m.inbox.length, 1);

    // An alert's summary: done.
    m.onTurn('e', 'started', '');
    b.at(13000);
    m.onSummary('e', 'Fixed the login race');
    expect([m.page, m.attention!.agentId, m.attention!.kind], [BarPage.attention, 'e', AttnKind.done]);
    // One with nothing to say ends the turn, and is no news.
    m.onTurn('d', 'started', '');
    b.at(13500);
    m.onSummary('d', '');
    expect(m.agentById('d')!.state, AgentState.done);
    expect(m.attention!.agentId, 'e');
    expect(m.inbox.length, 2);

    // A question replaces a turn's end on the page.
    b.at(14000);
    m.onQuestion('b', 'r1', 'Push?');
    expect([m.attention!.agentId, m.attention!.kind, m.attention!.since], ['b', AttnKind.ask, at(14000)]);
    // A turn's end while another agent's question is up: Inbox only.
    b.at(14500);
    m.onTurn('c', 'started', '');
    b.at(15000);
    m.onTurn('c', 'error', 'boom');
    expect(m.attention!.agentId, 'b');
    expect([m.inbox.first.agentId, m.inbox.first.kind], ['c', AttnKind.failed]);

    // A done page whose agent starts again is over at once.
    m.onQuestionClose('b');
    expect(m.page, BarPage.overview);
    b.at(17000);
    m.onSummary('e', 'Fixed it again');
    expect(m.attention!.agentId, 'e');
    b.at(18000);
    m.onTurn('e', 'started', '');
    expect(m.page, BarPage.overview);
    // So is a failed page whose agent leaves the ring.
    b.at(19000);
    m.onTurn('e', 'error', 'boom');
    expect(m.attention!.agentId, 'e');
    m.onAgents(rows(['a', 'b', 'c', 'd']));
    expect(m.page, BarPage.overview);
  });

  test('Inbox: every event an unread notice, newest first, at most 12, kept after its agent leaves', () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    const ring = [AgentRow(id: 'a', name: 'alpha', engine: 'codex', host: 'orca'), AgentRow(id: 'b', name: 'b')];
    m.onAgents(ring);
    // No `apps` yet: a notice names the agent's own app (its host).
    b.at(1000);
    m.onQuestion('a', 'r1', 'Keep the dark gradient?');
    final n = m.inbox.single;
    expect([n.agentId, n.name, n.engine, n.app, n.kind, n.text, n.at, n.unread],
        ['a', 'alpha', 'codex', 'orca', AttnKind.ask, 'Keep the dark gradient?', at(1000), true]);
    expect(m.unread, 1);
    // With `apps`, the shown app's name.
    const apps = [AppInfo(id: 'orca', name: 'Orca', count: 2, waiting: 1)];
    m.onApps('orca', apps);
    b.at(2000);
    m.onTurn('b', 'error', 'boom');
    expect([m.inbox.length, m.inbox.first.agentId, m.inbox.first.kind], [2, 'b', AttnKind.failed]);
    expect([m.inbox.first.app, m.inbox.first.text, m.unread], ['Orca', 'boom', 2]);
    // Opened and left: read. Only leaving does it.
    m.openInbox();
    expect(m.unread, 2);
    m.closeList();
    expect(m.unread, 0);

    // The cable comes back and the daemon sends the same question again: on top, unread again, not twice.
    b.at(3000);
    m.onLink(false);
    m.onLink(true, computer: 'MacBook Pro');
    m.onApps('orca', apps);
    m.onAgents(ring);
    b.at(5000);
    m.onQuestion('a', 'r1', 'Keep the dark gradient?');
    expect([m.inbox.length, m.inbox.first.agentId, m.inbox.first.unread, m.inbox.first.at], [2, 'a', true, at(5000)]);
    expect([m.inbox[1].unread, m.unread], [false, 1]);
    // Its agent leaves the ring: the notice keeps who and where.
    b.at(6000);
    m.onAgents(const [AgentRow(id: 'b', name: 'b')]);
    expect([m.inbox.first.name, m.inbox.first.app], ['alpha', 'Orca']);

    // Twelve kept: the oldest goes.
    for (var i = 0; i < kInboxMax; i++) {
      m.onTurn('b', 'started', '');
      b.at(7000 + i);
      m.onTurn('b', 'error', 'boom $i');
    }
    expect([m.inbox.length, m.inbox.first.text, m.inbox.last.text], [kInboxMax, 'boom 11', 'boom 0']);
    // A failure with no words of its own: its summary's words are its notice's.
    b.at(8000);
    m.onTurn('b', 'started', '');
    b.at(8100);
    m.onTurn('b', 'error', '');
    expect(m.inbox.first.text, '');
    b.at(8200);
    m.onSummary('b', 'Could not reach the API');
    expect([m.inbox.length, m.inbox.first.text, m.inbox[1].text], [kInboxMax, 'Could not reach the API', 'boom 11']);
  });

  test('Ambient: no computer, no agents, or a quiet minute on Overview; a turn or a question leaves it', () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    expect([m.page, m.mood], [BarPage.ambient, AmbientMood.noAgents]);
    m.onAgents(rows(abc));
    expect([m.page, m.mood], [BarPage.overview, AmbientMood.quiet]);
    b.at(59999);
    m.tick();
    expect(m.page, BarPage.overview);
    b.at(60000);
    m.tick();
    expect([m.page, m.mood], [BarPage.ambient, AmbientMood.quiet]);

    // A turn that starts: Overview. While it works, no Ambient however long nobody touches.
    b.at(70000);
    m.onTurn('a', 'started', '');
    expect(m.page, BarPage.overview);
    b.at(700000);
    m.tick();
    expect(m.page, BarPage.overview);
    // It ends: the wait starts from then.
    b.at(800000);
    m.onTurn('a', 'done', '');
    b.at(859999);
    m.tick();
    expect(m.page, BarPage.overview);
    b.at(860000);
    m.tick();
    expect(m.page, BarPage.ambient);

    // A question: Attention.
    b.at(900000);
    m.onQuestion('b', 'r1', 'Push?');
    expect(m.page, BarPage.attention);
    m.onQuestionClose('b');
    m.onTurn('b', 'done', '');
    m.tick();
    expect(m.page, BarPage.overview);

    // A touch is a person at the bar: the wait starts from it.
    b.at(1000090);
    m.touched();
    b.at(1060089);
    m.tick();
    expect(m.page, BarPage.overview);
    b.at(1060090);
    m.tick();
    expect(m.page, BarPage.ambient);

    // Only Overview goes: another page stays, however long.
    m.wake();
    m.openInbox();
    b.at(2000000);
    m.tick();
    expect(m.page, BarPage.inbox);
    // Nor while words are on their way to an agent.
    m.closeList();
    m.onTalkLink(TalkLink.sending);
    b.at(3000000);
    m.tick();
    expect(m.page, BarPage.overview);
    m.onTalkLink(TalkLink.idle);
    m.tick();
    expect(m.page, BarPage.ambient);

    // The ring empties: Ambient at once. Agents again: Overview, waiting from then.
    m.wake();
    m.onAgents(const []);
    expect([m.page, m.mood], [BarPage.ambient, AmbientMood.noAgents]);
    b.at(4000000);
    m.onAgents(rows(['a']));
    expect(m.page, BarPage.overview);
    b.at(4059999);
    m.tick();
    expect(m.page, BarPage.overview);
    // The link goes: Ambient at once, from any page; a tap still opens Overview (and the bell's Inbox).
    m.openInbox();
    m.onLink(false);
    expect([m.page, m.mood], [BarPage.ambient, AmbientMood.notConnected]);
    m.wake();
    expect(m.page, BarPage.overview);
  });

  test('while a person talks, what needs them is only the toast and the bell; a tap on it opens it', () {
    final b = linked(abcde), m = b.model;
    m.tapCell('a');
    b.at(100);
    m.onQuestion('c', 'r1', 'Which database?', items: const [db]);
    expect(m.page, BarPage.agent);
    expect(m.attention, isNull);
    final t = m.toast!;
    expect([t.text, t.agentId, t.kind, t.until], ['c asks · Which database?', 'c', AttnKind.ask, at(5100)]);
    expect(m.unread, 1);
    // The tap sends what was said first (a tap never loses words), then its Attention.
    b.sent();
    b.at(200);
    m.tapToast();
    expect(b.sent(), ['send']);
    expect([m.page, m.attention!.agentId, m.attention!.kind], [BarPage.attention, 'c', AttnKind.ask]);
    expect(m.toast!.text, 'Sent to a');
  });

  test('the toast lasts 5 s, and only while its agent still is what it announced', () {
    final b = linked(abcde), m = b.model;
    m.onTalkLink(TalkLink.sending);
    b.at(100);
    m.onTurn('b', 'error', 'boom');
    expect(m.page, BarPage.overview);
    expect([m.toast!.text, m.toast!.agentId, m.toast!.kind], ['b failed · boom', 'b', AttnKind.failed]);
    b.at(5099);
    m.tick();
    expect(m.toast, isNotNull);
    b.at(5100);
    m.tick();
    expect(m.toast, isNull);
    // Answered on the computer before the tap: gone, and a tap opens nothing.
    b.at(6000);
    m.onQuestion('c', 'r1', 'Push?');
    expect(m.toast!.agentId, 'c');
    m.onQuestionClose('c');
    m.tick();
    expect(m.toast, isNull);
    m.tapToast();
    expect(m.page, BarPage.overview);
    // Once the words are sent, a tap on it opens its Attention, from then.
    b.at(7000);
    m.onQuestion('d', 'r2', 'Merge?');
    m.onTalkLink(TalkLink.idle);
    b.at(7100);
    m.tapToast();
    expect([m.page, m.attention!.agentId, m.attention!.since], [BarPage.attention, 'd', at(7100)]);
    expect(m.toast, isNull);
  });

  test('the pages are told only when something they draw changed', () {
    final b = linked(abc), m = b.model;
    var n = b.notes;
    m.tick();
    b.at(30000);
    m.tick();
    expect(b.notes, n, reason: 'a quiet Overview draws nothing that moves');
    // The agent page's turn clock: once a second.
    b.at(31000);
    m.onTurn('a', 'started', '');
    m.tapCell('a');
    m.cancelTalk();
    m.onToast('');
    m.tick();
    n = b.notes;
    b.at(31500);
    m.tick();
    expect(b.notes, n);
    b.at(32000);
    m.tick();
    expect(b.notes, n + 1);
    // Inbox's "ago": once a minute.
    m.onQuestion('b', 'r1', 'Push?');
    m.openInbox();
    m.tick();
    n = b.notes;
    b.at(32000 + 59999);
    m.tick();
    expect(b.notes, n);
    b.at(32000 + 60000);
    m.tick();
    expect(b.notes, n + 1);
  });
}
