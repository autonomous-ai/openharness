// What each tap does besides talking (test_max_touch.c, test_max_app.c): Overview's swipe, Inbox's cards, Apps,
// Ambient's wake, Attention's answers, Say it and the bring-up around them, and the idle clock.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/bar_link.dart';
import 'package:harness_max_bar/model/types.dart';

import 'bar_harness.dart';

void main() {
  test("a sideways swipe pages Overview's cells, within the pages there are", () {
    final b = linked(xs.sublist(0, 11)), m = b.model;
    m.swipeCells(1);
    expect(m.cellPage, 1);
    m.swipeCells(1);
    expect(m.cellPage, 2);
    final n = b.notes;
    m.swipeCells(1);
    expect([m.cellPage, b.notes], [2, n], reason: 'the last page: no further');
    m.swipeCells(-1);
    expect(m.cellPage, 1);
    final one = linked(abc).model;
    one.swipeCells(1);
    expect(one.cellPage, 0);
  });

  test('Inbox: a waiting agent the bar answers opens Attention; any other is brought up on the computer', () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    m.onApps('orca', const [AppInfo(id: 'orca', name: 'Orca', count: 3, waiting: 2)]);
    const ring = [
      AgentRow(id: 'a', name: 'a', engine: 'claude', host: 'orca'),
      AgentRow(id: 'b', name: 'b', engine: 'codex', host: 'orca', caps: 'sv'),
      AgentRow(id: 'c', name: 'c', engine: 'claude', host: 'orca'),
    ];
    m.onAgents(ring);
    m.onQuestion('a', 'r1', db.q, items: const [db]);
    b.at(10);
    m.onQuestion('b', 'r2', db.q, items: const [db]);
    b.at(20);
    m.onTurn('c', 'error', 'boom');
    m.back();
    expect(m.unread, 3);
    m.openInbox();
    expect([m.page, m.inbox[0].agentId, m.inbox[2].agentId], [BarPage.inbox, 'c', 'a']);
    b.sent();
    m.tapNotice(noteOf(m, 'a', AttnKind.ask));
    expect(b.sent(), isEmpty);
    expect([m.page, m.attention!.agentId, m.unread], [BarPage.attention, 'a', 0]);
    // b: answered on the computer only.
    b.at(30);
    m.onQuestion('c', 'r3', db.q, items: const [db]);
    m.openInbox();
    m.tapNotice(noteOf(m, 'b', AttnKind.ask));
    expect(b.sent(), ['open b']);
    expect([m.toast!.text, m.page, m.unread], ['b is up in Orca', BarPage.overview, 0]);
    // c's failure, with c asking since: c is answered on the bar, so its notice opens its question.
    m.openInbox();
    m.tapNotice(noteOf(m, 'c', AttnKind.failed));
    expect([b.sent(), m.page, m.attention!.agentId], [isEmpty, BarPage.attention, 'c']);
    // An agent gone from the ring: brought up on the computer by its id, under the name and app its notice kept.
    m.openInbox();
    m.onAgents(ring.sublist(1));
    m.tapNotice(noteOf(m, 'a', AttnKind.ask));
    expect(b.sent(), ['open a']);
    expect(m.toast!.text, 'a is up in Orca');
    // A card acts only while Inbox is up; Close: Overview.
    m.tapNotice(noteOf(m, 'a', AttnKind.ask));
    expect(b.sent(), isEmpty);
    m.openInbox();
    m.closeList();
    expect(m.page, BarPage.overview);
    // No computer: nothing to bring up, and the toast says so.
    m.onLink(false);
    m.wake();
    m.openInbox();
    m.tapNotice(noteOf(m, 'a', AttnKind.ask));
    expect([b.sent(), m.toast!.text, m.page], [isEmpty, 'Not connected', BarPage.inbox]);
  });

  test('Apps opens only with another app; a card picks its app; "+ New" opens New Harness on the computer', () {
    final b = linked(abc), m = b.model;
    m.openApps();
    expect(m.page, BarPage.overview, reason: 'no `apps`: no Apps page');
    m.onApps('orca', const [AppInfo(id: 'orca', name: 'Orca', count: 3, waiting: 1)]);
    m.openApps();
    expect(m.page, BarPage.overview, reason: 'no other app');
    m.onApps('orca', const [AppInfo(id: 'orca', name: 'Orca', count: 3), AppInfo(id: 'vscode', name: 'VS Code')]);
    m.openApps();
    expect(m.page, BarPage.apps);
    b.sent();
    m.pickApp('nope');
    expect([b.sent(), m.page], [isEmpty, BarPage.apps]);
    m.pickApp('vscode');
    expect(b.sent(), ['pick vscode']);
    expect([m.page, m.shownApp], [BarPage.overview, 'orca'], reason: 'until the daemon says otherwise');
    m.pickApp('vscode');
    expect(b.sent(), isEmpty, reason: 'a card acts only while Apps is up');
    m.openApps();
    m.closeList();
    expect(m.page, BarPage.overview);
    // "+ New" only when the computer offers it.
    m.openApps();
    m.newHarness();
    expect([b.sent(), m.page], [isEmpty, BarPage.apps]);
    m.onLink(true, computer: 'MacBook Pro', offersNew: true);
    expect(m.offersNew, isTrue);
    m.newHarness();
    expect(b.sent(), ['new']);
    expect([m.toast!.text, m.page], ['New Harness is up on MacBook Pro', BarPage.overview]);
  });

  test('a tap on Ambient is Overview, and a person at the bar', () {
    final b = linked(abc), m = b.model;
    b.at(60000);
    m.tick();
    expect(m.page, BarPage.ambient);
    b.at(70000);
    m.wake();
    expect(m.page, BarPage.overview);
    b.at(129999);
    m.tick();
    expect(m.page, BarPage.overview);
    b.at(130000);
    m.tick();
    expect(m.page, BarPage.ambient);
  });

  test('Attention: an option answers, Say it opens the mic on its page, anywhere else brings the agent up', () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    m.onApps('orca', const [AppInfo(id: 'orca', name: 'Orca', count: 5, waiting: 2)]);
    m.onAgents(rows(abcde));
    m.onQuestion('a', 'r1', db.q, items: const [db]);
    b.at(10);
    m.onQuestion('c', 'r2', db.q, items: const [db]);
    b.sent();
    m.choose(1);
    expect(b.sent(), ['answer a r1 {db: Staging}']);
    expect([m.page, m.attention!.agentId], [BarPage.attention, 'c']);
    // Say it: c's page with the mic on. The words are its answer: sent, and with none waiting, Overview.
    m.sayIt();
    expect(b.sent(), ['talk c']);
    expect([m.page, m.selectedId, m.talk], [BarPage.agent, 'c', TalkPhase.listening]);
    m.tapBody();
    expect(b.sent(), ['send']);
    expect(m.page, BarPage.overview);
    m.onTalkLink(TalkLink.idle);
    // A permission prompt: Say it does nothing. The rest of the page brings the agent up in its app.
    b.at(30);
    m.onQuestion('e', 'r3', deploy.q, items: const [deploy], permission: true);
    m.sayIt();
    expect([b.sent(), m.page], [isEmpty, BarPage.attention]);
    m.away();
    expect(b.sent(), ['open e']);
    expect([m.toast!.text, m.page], ['e is up in Orca', BarPage.overview]);
    // A turn's end: the same, anywhere on it.
    b.at(40);
    m.onTurn('b', 'error', 'boom');
    expect([m.page, m.attention!.kind], [BarPage.attention, AttnKind.failed]);
    m.away();
    expect([b.sent(), m.page], [['open b'], BarPage.overview]);
    // Its intents do nothing once Attention is down.
    m.choose(0);
    m.sayIt();
    m.away();
    m.allow();
    expect([b.sent(), m.page], [isEmpty, BarPage.overview]);
  });

  test('away from an agent with no app known says only that it is up', () {
    final b = linked(abc), m = b.model;
    m.onTurn('a', 'error', 'boom');
    b.sent();
    m.away();
    expect(b.sent(), ['open a']);
    expect(m.toast!.text, 'a is up');
  });

  test('a touch is a person at the bar: Ambient waits a minute from it', () {
    final b = linked(abc), m = b.model;
    b.at(50000);
    m.touched();
    b.at(109999);
    m.tick();
    expect(m.page, BarPage.overview);
    b.at(110000);
    m.tick();
    expect(m.page, BarPage.ambient);
  });
}
