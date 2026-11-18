// Answering from the bar (test_max_ask.c): how a question is answered (its path), permission prompts, the reviewed
// path's read with its retries and its receipt, the plain answer's words, what ends a question, the shown-only wait
// that survives its turn's line, and the tail Attention drops.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/model/words.dart';

import 'bar_harness.dart';

const shownItem = AskItem(key: 'shown', q: 'Allow Edit of src/auth/session.ts?', options: ['In Orca']);

void main() {
  test("a permission prompt's yes and no are the daemon's own words; its command follows the first colon", () {
    for (final o in ['Yes', "yes, and don't ask again", 'Allow', 'APPROVE', 'Accept', 'Proceed', 'Run it', 'Continue']) {
      expect(optionApproves(o), isTrue, reason: o);
    }
    for (final o in ['Yesterday', 'Running', '', 'Sure']) {
      expect(optionApproves(o), isFalse, reason: o);
    }
    for (final o in [
      'No', 'No, and tell Claude what to do differently', 'Reject', 'deny', 'Decline', 'Cancel', 'Skip', "Don't", //
      'dont', 'Stop', 'Tell Claude what to change',
    ]) {
      expect(optionRejects(o), isTrue, reason: o);
    }
    for (final o in ['Nothing', 'Notes', 'Tell me more', 'Stopwatch', 'Yes']) {
      expect(optionRejects(o), isFalse, reason: o);
    }
    expect(allowDeny(const AskItem(key: 'p', q: '', options: ['No', 'Yes, allow all edits', 'Yes']))?.allow, 1);
    expect(allowDeny(const AskItem(key: 'p', q: '', options: ['No', 'Yes']))?.deny, 0);
    expect(allowDeny(const AskItem(key: 'p', q: '', options: ['Maybe', 'Later'])), isNull);
    expect(commandOf('Approve Bash command: make flash'), 'make flash');
    expect(commandOf('Run it?'), 'Run it?');
    expect(commandOf('Edit: '), 'Edit: ');
  });

  test('how a question is answered: reviewed, plain, on the computer, or shown in its own app', () {
    final b = linked(abc), m = b.model;
    m.onQuestion('a', 'toolu_1', 'Which database?', items: const [db], review: true);
    expect([m.asks['a']!.path, m.asks['a']!.phase, m.agentById('a')!.state],
        [AskPath.reviewed, AskPhase.reading, AgentState.asking]);
    // Without question.review: a plain answer, when every key and option came whole.
    m.onQuestion('b', 'toolu_2', 'Which database?', items: const [db]);
    expect([m.asks['b']!.path, m.asks['b']!.phase], [AskPath.plain, AskPhase.ready]);
    m.onQuestion('b', 'toolu_3', 'Which database?',
        items: const [AskItem(key: 'db', q: 'Which database?', options: ['Dev', 'Staging'], whole: false)]);
    expect(m.asks['b']!.path, AskPath.computer);
    m.onQuestion('b', 'toolu_4', 'Which database?',
        items: const [AskItem(key: null, q: 'Which database?', options: ['Dev', 'Staging'])]);
    expect(m.asks['b']!.path, AskPath.computer, reason: 'a key too long to echo');
    // No questions the inbox would hold, or no request: only the computer answers.
    m.onQuestion('c', 'toolu_5', 'Proceed?', review: true);
    expect([m.asks['c']!.path, m.asks['c']!.items], [AskPath.computer, isEmpty]);
    m.onQuestion('c', '', 'Proceed?', items: const [db], review: true);
    expect(m.asks['c']!.path, AskPath.computer);
    // Shown only: answered in the agent's own app, named by its one option.
    m.onQuestion('c', 'shown:toolu_6', shownItem.q, items: const [shownItem], permission: true, review: true);
    expect([m.asks['c']!.path, m.asks['c']!.app, m.asks['c']!.permission], [AskPath.shown, 'Orca', true]);
    expect(m.takesAnswers(m.agentById('c')), isFalse);
    b.sent();
    m.tick();
    expect(b.sent(), ['read a toolu_1 q1'], reason: "the clock reads: a's only");
    // The permission mark is the daemon's; with no questions there is nothing to approve.
    m.onQuestion('b', 'toolu_7', deploy.q, items: const [deploy], permission: true);
    expect([m.asks['b']!.permission, m.asks['b']!.command], [true, 'npm run deploy:staging']);
    m.onQuestion('b', 'toolu_8', deploy.q, permission: true);
    expect(m.asks['b']!.permission, isFalse);
    m.onQuestion('b', 'toolu_9', deploy.q, items: const [deploy]);
    expect(m.asks['b']!.permission, isFalse);
    // The same question again is no change; an agent not in the ring is nobody's.
    final n = b.notes;
    m.onQuestion('b', 'toolu_9', deploy.q, items: const [deploy]);
    m.onQuestion('zz', 'toolu_1', deploy.q, items: const [deploy]);
    expect(b.notes, n);
    expect(m.asks['zz'], isNull);
  });

  test('the reviewed path reads the question: three tries 2 s apart, then the card says there was no reply', () {
    final b = linked(abc), m = b.model;
    b.at(1000);
    m.onQuestion('a', 'toolu_1', 'Which database?', items: const [db], review: true);
    b.sent();
    m.tick();
    expect(b.sent(), ['read a toolu_1 q1']);
    b.at(2999);
    m.tick();
    expect(b.sent(), isEmpty);
    b.at(3000);
    m.tick();
    b.at(5000);
    m.tick();
    expect(b.sent(), ['read a toolu_1 q1', 'read a toolu_1 q1']);
    b.at(7000);
    m.tick();
    expect(b.sent(), isEmpty);
    final k = m.asks['a']!;
    expect([k.phase, k.note], [AskPhase.failed, 'No reply. Check Harness on your computer.']);

    // A late state for that read is not taken; Reload reads again under a new name.
    m.onQuestionState('a', 'q1', ok: true, requestId: 'toolu_1', token: 'tok', items: const [db]);
    expect(k.phase, AskPhase.failed);
    b.at(9000);
    m.reload();
    expect(k.phase, AskPhase.reading);
    m.tick();
    expect(b.sent(), ['read a toolu_1 q2']);
    // A state for another read, or another agent, is not this card's.
    m.onQuestionState('a', 'q1', ok: true, requestId: 'toolu_1', token: 'tok', items: const [db]);
    m.onQuestionState('b', 'q2', ok: true, requestId: 'toolu_1', token: 'tok', items: const [db]);
    expect(k.phase, AskPhase.reading);
    // The daemon's refusal is the card's words; a state with nothing to answer, or no token, ours.
    m.onQuestionState('a', 'q2', ok: false, error: 'Question changed.');
    expect([k.phase, k.note], [AskPhase.failed, 'Question changed.']);
    m.reload();
    m.tick();
    m.onQuestionState('a', k.fetch, ok: true, requestId: 'toolu_1', token: 'tok');
    expect([k.phase, k.note], [AskPhase.failed, 'Could not load the question.']);
    m.reload();
    m.tick();
    m.onQuestionState('a', k.fetch, ok: true, requestId: 'toolu_1', items: const [db]);
    expect([k.phase, k.note], [AskPhase.failed, 'Could not load the question.']);
    // Answered already: shown as sent, never sent again.
    m.reload();
    m.tick();
    m.onQuestionState('a', k.fetch, ok: true, requestId: 'toolu_1', token: 'tok', submitted: true, items: const [db]);
    expect([k.phase, k.note], [AskPhase.sent, 'An answer was already sent. Check the terminal.']);
    b.sent();
    m.choose(0);
    m.reload();
    m.tick();
    expect(b.sent(), isEmpty);
    expect(k.phase, AskPhase.sent);
  });

  test("the reviewed answer goes under the read's token; its receipt ends it, refuses it, or never comes", () {
    final b = linked(abc), m = b.model;
    m.onTurn('a', 'started', '');
    reviewed(b, 'a', const [db]);
    // The daemon's own copy replaces the one the question carried.
    final k = m.asks['a']!;
    expect([k.phase, k.token, k.choices], [AskPhase.ready, 'tok', [0]]);
    // One tap on a single choice is the answer: the option's bit, under the read's token and name.
    m.choose(2);
    m.choose(-1);
    expect([k.phase, b.sent()], [AskPhase.ready, isEmpty]);
    m.choose(1);
    expect(k.phase, AskPhase.sending);
    expect(b.sent(), ['reviewed a tok q1 [2]']);
    m.choose(0);
    expect(b.sent(), isEmpty, reason: 'one answer at a time');
    // A receipt for another token or read is not this answer's.
    m.onAnswerReceipt('a', 'q1', ok: true, token: 'other');
    m.onAnswerReceipt('a', 'q99', ok: true, token: 'tok');
    expect(k.phase, AskPhase.sending);
    // Taken: "Sent", and the turn goes on.
    m.onAnswerReceipt('a', 'q1', ok: true, token: 'tok');
    expect([m.toast!.text, m.agentById('a')!.state, m.asks['a']], ['Sent', AgentState.working, isNull]);

    // Taken but the terminal not done with it: the card says sent until the question closes.
    reviewed(b, 'b', const [db]);
    m.choose(0);
    m.onAnswerReceipt('b', m.asks['b']!.fetch, ok: true, token: 'tok', pending: true);
    expect([m.asks['b']!.phase, m.asks['b']!.note], [AskPhase.sent, '']);
    m.onQuestionClose('b');
    expect([m.asks['b'], m.agentById('b')!.state], [isNull, AgentState.working]);

    // Refused: the daemon's words on the card and as the toast; Reload reads it again.
    reviewed(b, 'c', const [deploy]);
    m.choose(0);
    const refusal = 'Permission prompts cannot be answered from here.';
    m.onAnswerReceipt('c', m.asks['c']!.fetch, ok: false, token: 'tok', error: refusal);
    expect([m.asks['c']!.phase, m.asks['c']!.note, m.toast!.text], [AskPhase.failed, refusal, refusal]);
    m.tapCell('c');
    m.reload();
    expect(m.asks['c']!.phase, AskPhase.reading);
    // No receipt: the card says so, and nothing is sent again (the daemon takes one answer a token).
    m.tick();
    m.onQuestionState('c', m.asks['c']!.fetch, ok: true, requestId: 'toolu_1', token: 'tok2', items: const [deploy]);
    b.sent();
    b.at(1000);
    m.choose(1);
    expect(b.sent(), ['reviewed c tok2 ${m.asks['c']!.fetch} [2]']);
    b.at(10999);
    m.tick();
    expect(m.asks['c']!.phase, AskPhase.sending);
    b.at(11000);
    m.tick();
    expect([m.asks['c']!.phase, m.asks['c']!.note], [AskPhase.failed, 'No reply. Check the terminal.']);
    expect(b.sent(), isEmpty);
  });

  test('several questions step by step; several choices toggle, and Send needs one', () {
    final b = linked(abc), m = b.model;
    reviewed(b, 'a', two);
    final k = m.asks['a']!;
    // The first question's tap moves on to the second; Back returns to it with its choice kept.
    m.choose(1);
    expect([k.step, k.phase], [1, AskPhase.ready]);
    m.stepBack();
    expect([k.step, k.choices[0]], [0, 2]);
    m.stepBack();
    expect(k.step, 0);
    m.choose(0);
    expect([k.step, k.choices[0]], [1, 1]);
    // Several choices: each tap toggles; Send needs one.
    m.sendChoices();
    expect([k.step, k.phase], [1, AskPhase.ready]);
    m.choose(0);
    m.choose(2);
    m.choose(0);
    expect([k.choices[1], k.phase], [4, AskPhase.ready]);
    m.choose(1);
    expect(k.choices[1], 6);
    m.sendChoices();
    expect(k.phase, AskPhase.sending);
    expect(b.sent(), ['reviewed a tok q1 [1, 6]']);
  });

  test('a plain answer echoes each key with the chosen options, a multi-select joined as the daemon joins it', () {
    final b = linked(abc), m = b.model;
    m.onTurn('a', 'started', '');
    m.onQuestion('a', 'toolu_1', 'Which database?', items: two);
    m.choose(1);
    m.choose(0);
    m.choose(2);
    m.sendChoices();
    expect(b.sent(), ['answer a toolu_1 {db: Staging, checks: Lint, Tests}']);
    expect([m.asks['a']!.phase, m.toast!.text, m.page], [AskPhase.sent, 'Sent', BarPage.overview]);
    // Two answers: each its own.
    m.onQuestion('b', 'toolu_3', 'Which database?', items: const [db]);
    m.onQuestion('c', 'toolu_4', 'Which database?', items: const [db]);
    m.choose(0);
    m.choose(1);
    expect(b.sent(), ['answer b toolu_3 {db: Dev}', 'answer c toolu_4 {db: Staging}']);
  });

  test('only a ready question the bar answers takes a choice', () {
    final b = TestBar(), m = b.model;
    m.onLink(true, computer: 'MacBook Pro');
    m.onAgents(const [
      AgentRow(id: 'a', name: 'a'),
      AgentRow(id: 'b', name: 'b'),
      AgentRow(id: 'c', name: 'c'),
      AgentRow(id: 'd', name: 'd', caps: 'sv'),
    ]);
    // On the computer only, or in the agent's app: no option answers.
    m.onQuestion('a', 'toolu_1', 'Proceed?', review: true);
    m.onQuestion('b', 'shown:toolu_2', 'Allow?', items: const [shownItem], permission: true, review: true);
    m.onQuestion('c', 'toolu_3', 'Which?', items: const [db], review: true);
    m.onQuestion('d', 'toolu_4', 'Which?', items: const [db]);
    b.sent();
    expect(m.attention!.agentId, 'a');
    m.choose(0);
    m.sendChoices();
    m.onQuestionClose('a');
    expect(m.attention!.agentId, 'b');
    m.choose(0);
    m.allow();
    // Reading: not yet.
    m.onQuestionClose('b');
    expect(m.attention!.agentId, 'c');
    m.choose(0);
    // An agent without caps a: its question is answered on the computer.
    m.onQuestionClose('c');
    expect(m.attention!.agentId, 'd');
    expect(m.takesAnswers(m.agentById('d')), isFalse);
    m.choose(0);
    expect(b.sent().where((s) => !s.startsWith('read')), isEmpty);
    // Nobody asking: nothing.
    m.onQuestionClose('d');
    m.choose(0);
    m.reload();
    expect(b.sent(), isEmpty);
  });

  test('a turn that starts or ends, a failure, leaving the ring or the link going drop the question', () {
    final b = linked(abc), m = b.model;
    m.onQuestion('a', 'toolu_1', 'Which?', items: const [db], review: true);
    m.onTurn('a', 'done', '');
    expect(m.asks['a'], isNull);
    m.onQuestion('a', 'toolu_2', 'Which?', items: const [db], review: true);
    m.onTurn('a', 'started', '');
    expect([m.asks['a'], m.agentById('a')!.state], [isNull, AgentState.working]);
    m.onQuestion('a', 'toolu_3', 'Which?', items: const [db], review: true);
    m.onTurn('a', 'error', 'boom');
    expect([m.asks['a'], m.agentById('a')!.state, m.agentById('a')!.said], [isNull, AgentState.failed, 'boom']);
    m.onQuestion('b', 'toolu_4', 'Which?', items: const [db], review: true);
    m.onAgents(rows(['c']));
    expect(m.asks['b'], isNull);
    m.onAgents(rows(abc));
    m.onQuestion('b', 'toolu_5', 'Which?', items: const [db], review: true);
    m.onLink(false);
    expect(m.asks, isEmpty);
    b.sent();
    b.at(100000);
    m.tick();
    expect(b.sent(), isEmpty, reason: 'unlinked, the clock owes nothing');
  });

  // An agent in another app waits on its app's prompt: the daemon shows its question only (a `shown:` id) and tells the
  // wait as the line of a turn that starts (devices.ts showWaits, then `processing`). That start is the same wait, so
  // the question and its Attention stay; the daemon's close ends them (V2 fix 021bd765ab).
  test('a wait shown in its own app keeps its question when the daemon tells it as a turn that starts', () {
    final b = linked(abc), m = b.model;
    const wait = AskItem(key: 'prompt', q: 'npm test · answer in Orca', options: ['In Orca']);
    m.onQuestion('b', 'shown:w1', wait.q, items: const [wait], review: true);
    expect([m.page, m.attention!.agentId], [BarPage.attention, 'b']);
    b.at(10);
    m.onTurn('b', 'started', 'npm test · answer in Orca');
    expect([m.asks['b']?.path, m.agentById('b')!.state], [AskPath.shown, AgentState.asking]);
    expect([m.page, m.attention!.agentId], [BarPage.attention, 'b']);
    // A Harness question is still dropped by a turn that starts: its answer moved the agent on.
    b.at(20);
    m.onQuestion('a', 'toolu_9', 'Which?', items: const [db], review: true);
    b.at(30);
    m.onTurn('a', 'started', '');
    expect([m.asks['a'], m.agentById('a')!.state], [isNull, AgentState.working]);
    m.onQuestionClose('b');
    expect(m.asks['b'], isNull);
    expect(m.agentById('b')!.state, isNot(AgentState.asking));
  });

  test("Attention's words drop the daemon's \" · answer in <App>\" tail from a wait the bar only shows", () {
    final b = linked(abcde), m = b.model;
    const line = 'Keep the video? · answer in Orca';
    m.onQuestion('e', 'shown:w1', line, items: const [AskItem(key: 'prompt', q: line, options: ['In Orca'])]);
    final k = m.asks['e']!;
    expect([k.text, k.items.single.q, k.app], ['Keep the video?', 'Keep the video?', 'Orca']);
    // The agent page and Inbox keep the daemon's words.
    expect([m.agentById('e')!.said, m.inbox.first.text], [line, line]);
    // A question the bar answers keeps its words.
    const pick = AskItem(key: 'db', q: 'Pick one · answer in Orca', options: ['Dev']);
    m.onQuestion('a', 'toolu_1', pick.q, items: const [pick]);
    expect([m.asks['a']!.text, m.asks['a']!.items.single.q], [pick.q, pick.q]);
    // A line that is only the tail keeps it; of two tails, the last goes.
    m.onQuestion('b', 'shown:w2', ' · answer in Orca');
    expect(m.asks['b']!.text, ' · answer in Orca');
    m.onQuestion('c', 'shown:w3', 'Keep a · answer in X? · answer in Orca');
    expect(m.asks['c']!.text, 'Keep a · answer in X?');
  });

  test('an answer from Attention moves it to the question waiting longest, else Overview', () {
    final b = linked(abc), m = b.model;
    b.at(1000);
    m.onQuestion('a', 'toolu_1', db.q, items: const [db]);
    b.at(2000);
    reviewed(b, 'c', two);
    b.at(3000);
    m.onQuestion('b', 'toolu_3', deploy.q, items: const [deploy], permission: true);
    expect(m.attention!.agentId, 'a');
    // One tap on a single choice: the answer goes, and c's question has waited longest.
    b.at(4000);
    m.choose(0);
    expect(m.asks['a']!.phase, AskPhase.sent);
    expect([m.attention!.agentId, m.attention!.since], ['c', at(4000)]);
    // A step on is not the answer; Send on several choices is.
    m.choose(1);
    expect(m.attention!.agentId, 'c');
    m.choose(2);
    expect(m.attention!.agentId, 'c');
    m.sendChoices();
    expect(m.attention!.agentId, 'b');
    // Allow on the permission prompt, and nothing else waits (a's and c's answers are on their way): Overview.
    m.allow();
    expect([m.asks['b']!.phase, m.page], [AskPhase.sent, BarPage.overview]);
    expect(b.sent(), ['answer a toolu_1 {db: Dev}', 'reviewed c tok q1 [2, 4]', 'answer b toolu_3 {perm: Yes}']);
  });

  test('a permission prompt: Allow and Deny pick its yes and no, it takes no voice, and its command shows', () {
    final b = linked(abc), m = b.model;
    final ask = AskItem(key: 'perm', q: deploy.q, options: const ['No, and tell Claude what to do differently', 'Yes']);
    m.onQuestion('a', 'toolu_1', deploy.q, items: [ask], permission: true);
    expect([m.asks['a']!.permission, m.asks['a']!.command], [true, 'npm run deploy:staging']);
    b.sent();
    m.sayIt();
    expect([m.page, b.sent()], [BarPage.attention, isEmpty]);
    m.deny();
    expect(b.sent(), ['answer a toolu_1 {perm: No, and tell Claude what to do differently}']);
    m.onQuestion('b', 'toolu_2', deploy.q, items: const [deploy], permission: true);
    m.allow();
    expect(b.sent(), ['answer b toolu_2 {perm: Yes}']);
    // Without both a yes and a no there are no Allow and Deny: its options answer as they are.
    const odd = AskItem(key: 'perm', q: 'Approve: x', options: ['Maybe', 'Later']);
    m.onQuestion('c', 'toolu_3', odd.q, items: const [odd], permission: true);
    m.allow();
    m.deny();
    expect(b.sent(), isEmpty);
    m.choose(1);
    expect(b.sent(), ['answer c toolu_3 {perm: Later}']);
    // A permission prompt's agent is never recorded for: its cell opens the prompt.
    m.onQuestion('a', 'toolu_4', deploy.q, items: const [deploy], permission: true);
    m.back();
    m.tapCell('a');
    expect([m.page, m.talk, b.sent()], [BarPage.attention, TalkPhase.off, isEmpty]);
  });
}
