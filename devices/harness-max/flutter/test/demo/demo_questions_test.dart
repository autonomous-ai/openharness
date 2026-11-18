// The demo's questions: shown-only ones in Orca, the bar's own in Harness, the permission prompt, and who answers them
// when nobody is at the bar (max_demo.c's questions and unattended waits).
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';

import 'demo_support.dart';

AskItem _item(Seen s) => (s['items'] as List<AskItem>).single;

void main() {
  test('Orca\'s question is shown only, counted as waiting, and answered in Orca after 12 s; the turn goes on',
      () async {
    final d = Demo();
    await d.start();
    final q = d.runUntil('question', agent: 'ag-hero');
    expect(q.at, 10000);
    expect(q['id'] as String, startsWith('shown:'));
    expect(q.text, 'Use the new image in the hero, or keep the video? · answer in Orca');
    expect(q['permission'], isFalse);
    expect(q['review'], isTrue);
    final item = _item(q);
    expect([item.key, item.q, item.options, item.multi],
        ['prompt', 'Use the new image in the hero, or keep the video? · answer in Orca', ['In Orca'], false]);

    final count = d.all('apps').firstWhere((a) => a.at >= q.at);
    expect((count['rows'] as List<AppInfo>).firstWhere((r) => r.id == 'orca').waiting, 1);

    d.runTo(21999);
    expect(d.count('question.close'), 0);
    d.runTo(22000);
    expect(d.first('question.close', agent: 'ag-hero')!.at, 22000);
    expect((d.all('apps').last['rows'] as List<AppInfo>).firstWhere((r) => r.id == 'orca').waiting, 0);

    final hero = d.runUntil('summary', agent: 'ag-hero');
    expect(hero['recap'], 'Hero uses the new image');
    // The turn goes on after the answer: a turn.started would drop the bar's open question.
    expect(d.count('turn.started', agent: 'ag-hero'), 1);
    // rate-limiter's failure comes after the question closed, so each takes the glass in turn.
    final failed = d.runUntil('turn.error', agent: 'ag-rate');
    expect(failed.text, 'npm test failed: 3 rate-limit tests time out');
    expect(failed.at, greaterThan(22000));
  });

  test("Harness's question waits 40 s for the bar, then is answered on the computer with its first option", () async {
    final d = Demo();
    await d.start();
    final q = d.runUntil('question', agent: 'ag-cli');
    expect(q.at, 78500);
    expect(q['id'] as String, startsWith('q-'));
    expect(q.text, 'Bump the cable protocol to 4, or keep 3 and add a field?');
    expect(q['permission'], isFalse);
    expect(q['review'], isTrue);
    expect([_item(q).key, _item(q).options], [q.text, ['Bump to 4', 'Keep 3']]);
    d.runTo(118499);
    expect(d.count('question.close', agent: 'ag-cli'), 0);
    d.runTo(118500);
    expect(d.count('question.close', agent: 'ag-cli'), 1);
    final done = d.runUntil('summary', agent: 'ag-cli');
    expect(done['recap'], 'Cable protocol bumped to 4');
    expect(done['tier'], SummaryTier.alert);
    expect(d.count('turn.started', agent: 'ag-cli'), 1);
  });

  test('a reviewed answer: read, refused in the daemon\'s words, taken once, closed, and the turn goes on with it',
      () async {
    final d = Demo();
    await d.start();
    final q = d.runUntil('question', agent: 'ag-cli');
    d.link.questionRead('ag-cli', q['id'] as String, 'f1');
    d.run(0);
    final st = d.first('question.state')!;
    expect([st.agent, st.text, st['ok'], st['id'], st['submitted']], ['ag-cli', 'f1', true, q['id'], false]);
    final token = st['token'] as String;
    expect(token, isNotEmpty);
    expect(_item(st).options, ['Bump to 4', 'Keep 3']);

    d.forget();
    d.link.answerReviewed('ag-cli', 'stale', 'f2', [1]);
    d.link.answerReviewed('ag-cli', token, 'f3', [1, 1]);
    d.link.answerReviewed('ag-cli', token, 'f4', [4]);
    d.run(0);
    expect([for (final r in d.all('answer.receipt')) (r.text, r['ok'], r['error'])], [
      ('f2', false, 'This question changed. Open it again.'),
      ('f3', false, 'Review every answer first.'),
      ('f4', false, 'Choose an answer from this question.'),
    ]);
    expect(d.first('answer.receipt')!['token'], 'stale');
    expect(d.count('question.close'), 0);

    d.forget();
    final answeredAt = d.now;
    d.link.answerReviewed('ag-cli', token, 'f5', [2]);
    d.run(0);
    // Sent twice, taken once: the same receipt again.
    d.link.answerReviewed('ag-cli', token, 'f6', [2]);
    d.run(0);
    expect([for (final r in d.all('answer.receipt')) (r.text, r['ok'], r['pending'], r['token'])],
        [('f5', true, false, token), ('f6', true, false, token)]);
    final closed = d.runUntil('question.close', agent: 'ag-cli', ms: 1000);
    expect(closed.at, answeredAt + 1000);
    final done = d.runUntil('summary', agent: 'ag-cli');
    expect(done['recap'], 'The app list rides on proto 3');
    expect(done.text, contains('stays at 3'));
    expect(d.count('question.close', agent: 'ag-cli'), 1);

    d.forget();
    d.link.questionRead('ag-cli', q['id'] as String, 'f7');
    d.run(0);
    expect([d.first('question.state')!['ok'], d.first('question.state')!['error']],
        [false, 'No readable question. Check the terminal.']);
  });

  test('a plain answer by its label, for its own request only', () async {
    final d = Demo();
    await d.start();
    final q = d.runUntil('question', agent: 'ag-cli');
    final key = _item(q).key!;
    d.forget();
    d.link.answer('ag-cli', 'old', {key: 'Keep 3'});
    d.run(3000);
    expect(d.count('question.close'), 0);
    d.link.answer('ag-cli', q['id'] as String, {key: 'Keep 3'});
    d.runUntil('question.close', agent: 'ag-cli', ms: 1000);
    expect(d.count('answer.receipt') + d.count('toast'), 0);
    expect(d.runUntil('summary', agent: 'ag-cli').text, contains('stays at 3'));
  });

  test('the permission prompt: Allow flashes the Max', () async {
    final d = Demo();
    await d.start();
    final q = d.runUntil('question', agent: 'ag-fw');
    expect(q.at, 84000);
    expect(q.text, 'Bash: idf.py -p /dev/ttyACM0 flash');
    expect(q['permission'], isTrue);
    expect(q['id'] as String, isNot(startsWith('shown:')));
    expect(_item(q).options, ['Allow', 'Deny']);
    d.link.questionRead('ag-fw', q['id'] as String, 'p1');
    d.run(0);
    final token = d.first('question.state')!['token'] as String;
    d.link.answerReviewed('ag-fw', token, 'p2', [1]);
    d.run(0);
    expect(d.first('answer.receipt')!['ok'], isTrue);
    d.runUntil('question.close', agent: 'ag-fw', ms: 1000);
    final done = d.runUntil('summary', agent: 'ag-fw');
    expect(done['recap'], contains('flashed'));
    expect(done['tier'], SummaryTier.alert);
    expect(d.count('turn.error', agent: 'ag-fw'), 0);
  });

  test('the permission prompt: Deny stops before flashing, and the turn does no more', () async {
    final d = Demo();
    await d.start();
    final q = d.runUntil('question', agent: 'ag-fw');
    d.link.answer('ag-fw', q['id'] as String, {_item(q).key!: 'Deny'});
    final done = d.runUntil('summary', agent: 'ag-fw');
    expect(done['recap'], 'Stopped before flashing');
    expect(done['tier'], SummaryTier.list);
    final ended = d.all('turn.done', agent: 'ag-fw').last;
    expect(d.seen.indexOf(ended), d.seen.indexOf(done) - 1);
    d.forget();
    d.run(30000);
    expect(d.seen.where((s) => s.agent == 'ag-fw' && s.type.startsWith('turn.')), isEmpty);
  });

  test("Orca's question is refused at the bar, and answered in Orca 6 s after the bar opens it there", () async {
    final d = Demo();
    await d.start();
    final q = d.runUntil('question', agent: 'ag-hero');
    d.link.questionRead('ag-hero', q['id'] as String, 'r1');
    d.run(0);
    final token = d.first('question.state', agent: 'ag-hero')!['token'] as String;
    d.forget();
    d.link.answerReviewed('ag-hero', token, 'r2', [1]);
    d.link.answer('ag-hero', q['id'] as String, {'prompt': 'In Orca'});
    d.run(0);
    expect([d.first('answer.receipt')!['ok'], d.first('answer.receipt')!['error']], [false, 'Answer it in Orca.']);
    expect(d.first('toast')!.text, 'Answer it in Orca.');
    expect(d.count('question.close'), 0);

    final openedAt = d.now;
    d.link.openAgent('ag-hero');
    d.run(5999);
    expect(d.count('question.close'), 0);
    d.run(1);
    expect(d.first('question.close', agent: 'ag-hero')!.at, openedAt + 6000);
    expect(d.runUntil('summary', agent: 'ag-hero')['recap'], 'Hero uses the new image');
  });

  test('an open question waits for a person however long they stay; left alone, the computer answers it', () async {
    final d = Demo();
    await d.start();
    d.runUntil('question', agent: 'ag-cli');
    // The bar reads every question as it arrives: that is nobody at the bar.
    d.link.questionRead('ag-cli', 'any', 'k0');
    for (var i = 0; i < 6; i++) {
      d.link.openAgent('ag-cli');
      d.run(20000);
    }
    expect(d.count('question.close', agent: 'ag-cli'), 0);
    d.run(120000);
    expect(d.count('question.close', agent: 'ag-cli'), 1);
  });
}
