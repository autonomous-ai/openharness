// One tap to talk (test_max_touch.c, test_max_app.c, and the owner's voice rules of 18 Nov): a cell opens its agent
// with the mic on; speech then 5 s of quiet sends, nothing heard in 5 s closes the mic, ten minutes is the longest; while
// the mic is open the glass is one Send and X cancels, a send is the Dial's tap and anything else is its dead zone; Back,
// the strip and a swipe send what was heard, else cancel; the talk follows the voice pipeline.
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

  test('speech, then 5 s of quiet: sent, "Sent to <name>", and back to Overview', () {
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
    b.at(3600);
    m.tick();
    expect(m.quiet, closeTo(0.5, 1e-9));
    b.at(6099);
    m.tick();
    expect(m.page, BarPage.agent);
    expect(b.sent(), isEmpty);
    b.at(6100);
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

  test('nothing heard in 5 s closes the mic; the page stays, and a tap on it opens the mic again', () {
    final b = linked(abcde), m = b.model;
    b.at(5000);
    m.tapCell('a');
    b.sent();
    b.at(6000);
    m.onLevel(0.3);
    b.at(9999);
    m.tick();
    expect(m.talk, TalkPhase.listening);
    b.at(10000);
    m.tick();
    expect(b.sent(), ['cancel']);
    // The open agent's band says it; a toast would sit over the band.
    expect([m.talk, m.toast?.text, m.page, m.selectedId], [TalkPhase.closed, null, BarPage.agent, 'a']);
    m.onTalkLink(TalkLink.idle);
    expect(m.talk, TalkPhase.closed, reason: 'the pipeline going idle keeps the page saying why');
    b.at(10500);
    m.tapBody();
    expect(b.sent(), ['talk a']);
    expect([m.talk, m.talkStarted, m.heard], [TalkPhase.listening, at(10500), false]);
    // Closed belongs to the page it closed on: Back forgets it.
    b.at(15500);
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
    b.at(15200);
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

  test('X on the open agent (App Detail): the recording is dropped, nothing sent, and the row comes back', () {
    final b = linked(abcde), m = b.model;
    m.tapCell('a');
    b.sent();
    m.onLevel(0.9);
    m.closeAgent();
    expect(b.sent(), ['cancel']);
    expect([m.page, m.talk, m.toast?.text], [BarPage.overview, TalkPhase.off, 'Cancelled, nothing sent']);

    // Nothing heard: no toast. The mic closed: nothing to drop.
    m.tapCell('b');
    b.sent();
    m.closeAgent();
    expect(b.sent(), ['cancel']);
    expect([m.page, m.talk], [BarPage.overview, TalkPhase.off]);
    b.at(1000);
    m.tapCell('c');
    b.sent();
    b.at(6000);
    m.tick();
    b.sent();
    expect(m.talk, TalkPhase.closed);
    m.closeAgent();
    expect(b.sent(), isEmpty);
    expect([m.page, m.talk], [BarPage.overview, TalkPhase.off]);
  });

  test('another agent beside the open one opens with the mic on; while the mic is open a sliver is glass: it sends', () {
    final b = linked(abcde), m = b.model;
    m.tapSliver('b');
    expect([b.sent(), m.page], [isEmpty, BarPage.overview], reason: 'only beside an open agent');
    // The mic off on the open agent: the sliver opens its agent with the mic on.
    m.tapCell('a');
    m.cancelTalk();
    b.sent();
    m.tapSliver('b');
    expect(b.sent(), ['open b', 'talk b']);
    expect([m.page, m.selectedId, m.talk, m.talkingTo], [BarPage.agent, 'b', TalkPhase.listening, 'b']);
    // The mic open: what is being said goes, heard or not, and no other agent opens.
    m.onLevel(0.9);
    m.tapSliver('c');
    expect(b.sent(), ['send']);
    expect([m.page, m.talk, m.talkingTo, m.toast?.text], [BarPage.overview, TalkPhase.sending, 'b', 'Sent to b']);
    m.onTalkLink(TalkLink.idle);
    m.tapCell('a');
    b.sent();
    m.tapSliver('c');
    expect([b.sent(), m.page], [
      ['send'],
      BarPage.overview
    ]);
    m.onTalkLink(TalkLink.idle);
    // A sliver whose agent left the ring: glass all the same.
    m.tapCell('a');
    b.sent();
    m.tapSliver('gone');
    expect(b.sent(), ['send']);
  });

  group("the Dial's touch while the mic is open", () {
    test('only its tap sends: 25..350 ms down, within 8 px; a press, a hold, a flick or a slide does nothing', () {
      final b = linked(abcde), m = b.model;
      m.tapCell('a');
      m.onLevel(0.9);
      b.sent();
      touch(b, 1000, 400, m.tapBody);
      touch(b, 2000, 1000, m.tapBody); // the Dial's draft hold: the bar has no draft
      touch(b, 3000, 20, m.tapBody);
      touch(b, 3500, 200, m.tapBody, moved: kTapSlop);
      touch(b, 4000, 200, () => m.tapSliver('b'), moved: 30, detector: true);
      expect(b.sent(), isEmpty);
      expect([m.page, m.selectedId, m.talk], [BarPage.agent, 'a', TalkPhase.listening]);
      // Anywhere on the glass: the bell is a send like the body.
      touch(b, 4500, kTapMax.inMilliseconds, m.openInbox, moved: kTapSlop - .1);
      expect(b.sent(), ['send']);
      expect([m.page, m.talk, m.toast!.text], [BarPage.overview, TalkPhase.sending, 'Sent to a']);
    });

    test('a slide sideways (a swipe) leaves the mic open; the 5 s quiet still sends', () {
      final b = linked(abcde), m = b.model;
      m.tapCell('a');
      m.onLevel(0.9);
      b.sent();
      touch(b, 1000, 150, m.tapBody, moved: 120);
      expect([b.sent(), m.talk], [isEmpty, TalkPhase.listening]);
      b.at(5000);
      m.tick();
      expect(b.sent(), ['send']);
    });

    test('the tap a GestureDetector calls (a sliver) reads the contact let go just before; older, a call is a tap', () {
      final b = linked(abcde), m = b.model;
      m.tapCell('a');
      b.sent();
      touch(b, 1000, 900, () => m.tapSliver('b'), detector: true);
      expect([b.sent(), m.talk], [isEmpty, TalkPhase.listening]);
      // No touch behind the call (the demo's script): a tap.
      b.at(1900 + kContactFresh.inMilliseconds + 1);
      m.tapBody();
      expect(b.sent(), ['send']);
    });

    test('a contact the system cancels sends nothing', () {
      final b = linked(abcde), m = b.model;
      m.tapCell('a');
      b.sent();
      b.at(1000);
      m.touchDown(1, 100, 100);
      b.at(1100);
      m.touchCancel(1);
      m.tapBody();
      expect([b.sent(), m.talk], [isEmpty, TalkPhase.listening]);
    });

    test('a touch that begins within 450 ms of the mic opening, a send or a cancel is part of it; X never waits', () {
      final b = linked(abcde), m = b.model;
      touch(b, 0, 100, () => m.tapCell('a')); // the mic opens at 100: held back until 550
      expect(b.sent(), ['open a', 'talk a']);
      touch(b, 500, 100, m.tapBody); // a double tap
      expect([b.sent(), m.talk], [isEmpty, TalkPhase.listening]);
      touch(b, 560, 100, m.tapBody); // sent at 660: held back until 1110
      expect(b.sent(), ['send']);
      m.onTalkLink(TalkLink.idle);
      touch(b, 1000, 100, () => m.tapCell('b'));
      expect([b.sent(), m.page], [isEmpty, BarPage.overview], reason: 'the tap after the send opens nothing');
      touch(b, 1200, 100, () => m.tapCell('b')); // the mic opens at 1300
      expect(b.sent(), ['open b', 'talk b']);
      touch(b, 1400, 100, m.closeAgent);
      expect(b.sent(), ['cancel'], reason: 'X cancels at once');
      expect([m.page, m.talk], [BarPage.overview, TalkPhase.off]);
      touch(b, 1700, 100, () => m.tapCell('c'));
      expect(b.sent(), isEmpty, reason: 'within 450 ms of the cancel');
      touch(b, 2000, 100, () => m.tapCell('c'));
      touch(b, 2200, 100, m.cancelTalk); // the band's X
      expect(b.sent(), ['open c', 'talk c', 'cancel']);
    });

    test('a touch held 650 ms or more opens no mic', () {
      final b = linked(abcde), m = b.model;
      touch(b, 0, kHoldFrom.inMilliseconds, () => m.tapCell('a'));
      expect([b.sent(), m.page], [isEmpty, BarPage.overview]);
      touch(b, 1000, kHoldFrom.inMilliseconds - 1, () => m.tapCell('a'));
      expect(b.sent(), ['open a', 'talk a']);
      m.cancelTalk();
      b.sent();
      touch(b, 3000, 700, m.tapBody);
      expect([b.sent(), m.talk], [isEmpty, TalkPhase.off]);
      touch(b, 4000, 300, m.tapBody);
      expect(b.sent(), ['talk a']);
    });

    test('the clock ending the talk under a finger: that touch acts on nothing when let go', () {
      final b = linked(abcde), m = b.model;
      m.tapCell('a');
      b.at(100);
      m.onLevel(0.9);
      b.sent();
      b.at(4000);
      m.touchDown(1, 100, 100);
      b.at(5100);
      m.tick(); // 5 s of quiet: sent while the finger is down
      expect([b.sent(), m.page], [
        ['send'],
        BarPage.overview
      ]);
      m.onTalkLink(TalkLink.idle);
      b.at(5200);
      m.touchUp(1, 100, 100);
      m.tapCell('c'); // the cell under the finger
      expect([b.sent(), m.page], [isEmpty, BarPage.overview]);
      touch(b, 5600, 100, () => m.tapCell('c'));
      expect(b.sent(), ['open c', 'talk c']);
    });
  });

  test('ten minutes of speech is the longest recording: then it is sent as a tap sends it', () {
    final b = linked(abcde), m = b.model;
    m.tapCell('a');
    b.sent();
    for (var s = 1; s < 600; s++) {
      b.at(s * 1000);
      m.onLevel(0.9);
      m.tick();
    }
    b.at(599999);
    m.tick();
    expect([b.sent(), m.talk], [isEmpty, TalkPhase.listening]);
    b.at(600000);
    m.tick();
    expect(b.sent(), ['send']);
    expect([m.page, m.toast!.text], [BarPage.overview, 'Sent to a']);
  });
}

/// A finger down at `from` ms and let go `held` ms later, `moved` px from where it went down, and the intent its tap
/// calls: as a Tap calls it, while it is let go, or ([detector]) as a GestureDetector does, just after.
void touch(TestBar b, int from, int held, void Function() intent, {double moved = 0, bool detector = false}) {
  final m = b.model;
  b.at(from);
  m.touchDown(1, 100, 100);
  if (moved > 0) m.touchMove(1, 100 + moved, 100);
  b.at(from + held);
  if (detector) m.touchUp(1, 100 + moved, 100);
  intent();
  if (!detector) m.touchUp(1, 100 + moved, 100);
}
