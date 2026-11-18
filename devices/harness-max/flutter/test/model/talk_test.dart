// One tap to talk (test_max_touch.c, test_max_app.c): a cell opens its agent with the mic on; speech then 1.6 s of
// quiet sends, nothing heard in 4 s closes the mic; the body sends at once or opens the mic again, X cancels; Back, the
// strip and a swipe send what was heard, else cancel; the talk follows the voice pipeline.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/bar_link.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';

import 'bar_harness.dart';

void main() {
  test('one tap on a cell opens its page with the mic on; a waiting agent opens Attention; no voice, the page alone',
      () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    m.onAgents(const [
      AgentRow(id: 'a', name: 'a', engine: 'claude'),
      AgentRow(id: 'b', name: 'b', engine: 'codex', host: 'orca', caps: 'sf'),
      AgentRow(id: 'c', name: 'c', engine: 'claude'),
      AgentRow(id: 'd', name: 'd', engine: 'claude'),
    ]);
    b.at(500);
    m.tapCell('a');
    expect(b.sent(), ['open a', 'talk a']);
    expect([m.page, m.selectedId, m.talk, m.talkStarted, m.heard], [BarPage.agent, 'a', TalkPhase.listening, at(500), false]);
    m.cancelTalk();
    m.back();
    b.sent();
    // No voice (caps without v): its page, and the computer opens it.
    m.tapCell('b');
    expect(b.sent(), ['open b']);
    expect([m.page, m.selectedId, m.talk], [BarPage.agent, 'b', TalkPhase.off]);
    m.back();
    // An agent that asks: its question on Attention, nothing recorded or sent.
    m.onQuestion('c', 'r1', db.q, items: const [db]);
    m.back();
    m.tapCell('c');
    expect(b.sent(), isEmpty);
    expect([m.page, m.attention!.agentId, m.attention!.kind, m.talk],
        [BarPage.attention, 'c', AttnKind.ask, TalkPhase.off]);
    m.back();
    // While the last words are still being sent the page opens with the mic closed.
    m.onTalkLink(TalkLink.sending);
    m.tapCell('d');
    expect(b.sent(), ['open d']);
    expect([m.page, m.selectedId], [BarPage.agent, 'd']);
    m.onTalkLink(TalkLink.idle);
    // A cell whose agent left the ring opens nothing.
    m.back();
    m.tapCell('zz');
    expect(b.sent(), isEmpty);
    expect(m.page, BarPage.overview);
  });

  test('speech, then 1.6 s of quiet: sent, "Sent to <name>", and back to Overview', () {
    final b = linked(abcde), m = b.model;
    b.at(1000);
    m.tapCell('a');
    b.sent();
    b.at(1100);
    m.onLevel(0.75);
    expect(m.heard, isTrue);
    expect(m.quiet, 0);
    b.at(1200);
    m.onLevel(0.1);
    expect(m.levels, [0.75, 0.1]);
    b.at(1900);
    m.tick();
    expect(m.quiet, closeTo(0.5, 1e-9));
    b.at(2699);
    m.tick();
    expect(m.page, BarPage.agent);
    expect(b.sent(), isEmpty);
    b.at(2700);
    m.tick();
    expect(b.sent(), ['send']);
    expect([m.toast!.text, m.page, m.talk], ['Sent to a', BarPage.overview, TalkPhase.sending]);
    m.onTalkLink(TalkLink.idle);
    expect(m.talk, TalkPhase.off);
  });

  test('speech is a level of 0.5 or more (MAX_SPEECH_LEVEL 2 of the C model 0..4); the waveform keeps 48', () {
    final b = linked(['a']), m = b.model;
    m.tapCell('a');
    m.onLevel(0.49);
    expect(m.heard, isFalse);
    m.onLevel(kSpeechLevel);
    expect(m.heard, isTrue);
    m.onLevel(7);
    expect(m.levels.last, 1.0, reason: 'past the scale: its top');
    for (var i = 0; i < kLevels + 5; i++) {
      m.onLevel(0);
    }
    expect(m.levels.length, kLevels);
    expect(m.levels.first, 0);
  });

  test('nothing heard in 4 s closes the mic; the page stays, and a tap on it opens the mic again', () {
    final b = linked(abcde), m = b.model;
    b.at(5000);
    m.tapCell('a');
    b.sent();
    b.at(6000);
    m.onLevel(0.3);
    b.at(8999);
    m.tick();
    expect(m.talk, TalkPhase.listening);
    b.at(9000);
    m.tick();
    expect(b.sent(), ['cancel']);
    expect([m.talk, m.toast!.text, m.page, m.selectedId],
        [TalkPhase.closed, 'Mic closed · tap to talk', BarPage.agent, 'a']);
    m.onTalkLink(TalkLink.idle);
    expect(m.talk, TalkPhase.closed, reason: 'the pipeline going idle keeps the page saying why');
    b.at(9500);
    m.tapBody();
    expect(b.sent(), ['talk a']);
    expect([m.talk, m.talkStarted, m.heard], [TalkPhase.listening, at(9500), false]);
    // Closed belongs to the page it closed on: Back forgets it.
    b.at(13500);
    m.tick();
    expect(m.talk, TalkPhase.closed);
    m.back();
    expect(m.talk, TalkPhase.off);
  });

  test("the page's body sends at once while listening; X cancels and the page stays", () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    m.onAgents(const [
      AgentRow(id: 'a', name: 'a', engine: 'claude'),
      AgentRow(id: 'b', name: 'b', engine: 'codex', host: 'orca', caps: 'f'),
      AgentRow(id: 'c', name: 'c', engine: 'claude'),
    ]);
    m.tapCell('a');
    b.sent();
    m.cancelTalk();
    expect(b.sent(), ['cancel']);
    expect([m.page, m.selectedId, m.talk, m.toast!.text], [BarPage.agent, 'a', TalkPhase.off, 'Mic closed']);
    m.tapBody();
    expect(b.sent(), ['talk a']);
    m.onLevel(0.9);
    m.cancelTalk();
    expect(m.toast!.text, 'Cancelled, nothing sent');
    // The mic again: a tap sends, whether or not the level said anything was heard.
    m.tapBody();
    b.sent();
    m.tapBody();
    expect(b.sent(), ['send']);
    expect([m.toast!.text, m.page, m.talk], ['Sent to a', BarPage.overview, TalkPhase.sending]);
    // While it is sent the page takes no voice: a tap there brings the agent up instead.
    m.tapCell('a');
    expect(b.sent(), ['open a']);
    m.tapBody();
    expect(b.sent(), ['open a']);
    m.onTalkLink(TalkLink.idle);
    // No voice: brought up on the computer. X does nothing when no recording is up.
    m.tapSegment('b');
    m.tapBody();
    expect(b.sent(), ['open b']);
    m.cancelTalk();
    expect(b.sent(), isEmpty);

    // A permission prompt takes Allow or Deny only, and an answer on its way no voice either.
    m.tapSegment('a');
    m.tapBody();
    m.onQuestion('a', 'r1', deploy.q, items: const [deploy], permission: true);
    expect(m.page, BarPage.agent, reason: 'a person talks: only the toast');
    m.cancelTalk();
    b.sent();
    m.tapBody();
    expect(b.sent(), ['open a']);
    m.onQuestion('a', 'r2', db.q, items: const [db]);
    expect(m.page, BarPage.attention);
    m.choose(0);
    expect(m.asks['a']!.phase, AskPhase.sent);
    m.tapCell('c');
    m.cancelTalk();
    m.tapSegment('a');
    b.sent();
    m.tapBody();
    expect(b.sent(), ['open a']);
  });

  test('Back, a segment and a sideways swipe send what was heard, else cancel; the strip shows its agent, mic off',
      () {
    final b = linked(abcde), m = b.model;
    m.tapCell('a');
    m.cancelTalk();
    b.sent();
    m.tapSegment('c');
    expect([m.page, m.selectedId, m.talk], [BarPage.agent, 'c', TalkPhase.off]);
    expect(b.sent(), isEmpty);
    m.swipeAgent(1);
    expect(m.selectedId, 'd');
    m.swipeAgent(1);
    m.swipeAgent(1);
    expect(m.selectedId, 'a', reason: 'round the ring');
    m.swipeAgent(-1);
    expect(m.selectedId, 'e');
    m.back();
    expect(m.page, BarPage.overview);

    // Back while listening: what was heard is sent, and says so.
    m.tapCell('b');
    m.onLevel(0.9);
    b.sent();
    m.back();
    expect(b.sent(), ['send']);
    expect([m.toast!.text, m.page, m.talk], ['Sent to b', BarPage.overview, TalkPhase.sending]);
    m.onTalkLink(TalkLink.idle);
    // Nothing heard: dropped, nothing said.
    m.tapCell('b');
    b.sent();
    final before = m.toast;
    m.back();
    expect(b.sent(), ['cancel']);
    expect([m.page, m.talk], [BarPage.overview, TalkPhase.off]);
    expect(identical(m.toast, before), isTrue);

    // The strip: sent, then that agent's page with the mic closed.
    m.tapCell('b');
    m.onLevel(0.9);
    b.sent();
    m.tapSegment('d');
    expect(b.sent(), ['send']);
    expect([m.toast!.text, m.page, m.selectedId], ['Sent to b', BarPage.agent, 'd']);
    m.onTalkLink(TalkLink.idle);
    m.back();
    m.tapCell('b');
    b.sent();
    m.tapSegment('d');
    expect(b.sent(), ['cancel']);
    expect([m.selectedId, m.talk], ['d', TalkPhase.off]);

    // A swipe the same.
    m.back();
    m.tapCell('b');
    m.onLevel(0.9);
    b.sent();
    m.swipeAgent(1);
    expect(b.sent(), ['send']);
    expect(m.selectedId, 'c');
    m.onTalkLink(TalkLink.idle);
    m.back();
    m.tapCell('b');
    b.sent();
    m.swipeAgent(-1);
    expect(b.sent(), ['cancel']);
    expect(m.selectedId, 'a');

    // A segment whose agent left since it was drawn is no segment: while listening, the tap sends as one on the page.
    m.back();
    m.tapCell('b');
    b.sent();
    m.onAgents(rows(['a', 'b', 'c', 'd']));
    m.tapSegment('e');
    expect(b.sent(), ['send']);
    expect(m.page, BarPage.overview);
  });

  test('a new ring while the person talks to an agent that left it sends what was said, then Overview', () {
    final b = linked(abcde), m = b.model;
    m.tapCell('d');
    m.onLevel(0.9);
    b.sent();
    m.onAgents(rows(abc));
    expect(m.page, BarPage.overview);
    m.tick();
    expect(b.sent(), ['send']);
    expect([m.toast!.text, m.talk], ['Sent', TalkPhase.sending]);
    m.onTalkLink(TalkLink.idle);
    // Nothing heard: dropped.
    m.onAgents(rows(abcde));
    m.tapCell('e');
    b.sent();
    m.onAgents(rows(abc));
    m.tick();
    expect(b.sent(), ['cancel']);
    expect([m.talk, m.page], [TalkPhase.off, BarPage.overview]);
  });

  test('the ring emptying while the person talks: Ambient stays, and what was heard is sent', () {
    final b = linked(abc), m = b.model;
    m.tapCell('a');
    m.onLevel(0.9);
    b.sent();
    m.onAgents(const []);
    expect([m.page, m.mood], [BarPage.ambient, AmbientMood.noAgents]);
    m.tick();
    expect(b.sent(), ['send']);
    expect([m.page, m.toast!.text], [BarPage.ambient, 'Sent']);
  });

  test('words to an agent that asked are its answer: the question waiting longest takes the glass', () {
    final b = linked(abcde), m = b.model;
    b.at(10000);
    m.onQuestion('b', 'r1', db.q, items: const [db]);
    b.at(10100);
    m.onQuestion('c', 'r2', db.q, items: const [db]);
    expect(m.attention!.agentId, 'b');
    b.sent();
    m.sayIt();
    expect(b.sent(), ['talk b']);
    expect([m.page, m.selectedId, m.talk], [BarPage.agent, 'b', TalkPhase.listening]);
    b.at(10200);
    m.onLevel(0.9);
    b.at(11800);
    m.tick();
    expect(b.sent(), ['send']);
    expect([m.page, m.attention!.agentId], [BarPage.attention, 'c']);
  });

  test('the talk follows the voice pipeline; levels count only while listening', () {
    final b = linked(['a']), m = b.model;
    b.at(1000);
    m.onTalkLink(TalkLink.recording);
    expect([m.talk, m.talkStarted], [TalkPhase.listening, at(1000)]);
    b.at(2000);
    m.onTalkLink(TalkLink.recording);
    expect(m.talkStarted, at(1000), reason: 'the same recording keeps its clock');
    m.onLevel(0.9);
    m.onTalkLink(TalkLink.sending);
    expect(m.talk, TalkPhase.sending);
    final n = b.notes;
    m.onLevel(0.9);
    expect([m.levels.length, b.notes], [1, n]);
    m.onTalkLink(TalkLink.idle);
    expect(m.talk, TalkPhase.off);
    b.at(3000);
    m.onTalkLink(TalkLink.recording);
    expect([m.talkStarted, m.heard, m.levels], [at(3000), false, isEmpty]);
  });

  test('while the mic is open, a swipe on Overview rests and any other tap sends it first', () {
    final b = linked(xs.sublist(0, 11)), m = b.model;
    m.tapCell('x0');
    m.onLevel(0.9);
    b.sent();
    m.swipeCells(1);
    expect(m.cellPage, 0);
    expect(b.sent(), isEmpty);
    m.openInbox();
    expect(b.sent(), ['send']);
    expect([m.page, m.talk], [BarPage.overview, TalkPhase.sending]);
  });

  test('the link going down ends the talk; the clock owes it nothing', () {
    final b = linked(['a']), m = b.model;
    m.tapCell('a');
    m.onLevel(0.9);
    b.sent();
    m.onLink(false);
    expect(m.talk, TalkPhase.off);
    b.at(99999);
    m.tick();
    expect(b.sent(), isEmpty);
  });
}
