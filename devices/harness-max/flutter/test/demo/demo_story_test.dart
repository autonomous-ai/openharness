// The demo's story on its own: who starts what and when, the beats of a turn, and the loop (max_demo.c's STORY).
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';

import 'demo_support.dart';

/// The turns the story starts in one telling, by agent and time (max_demo.c STORY).
const _timeline = [
  ('ag-auth', 1000),
  ('ag-hero', 3000),
  ('ag-e2e', 6000),
  ('ag-rate', 24000),
  ('ag-rate', 48000),
  ('ag-cli', 72000),
  ('ag-fw', 75000),
  ('ag-docs', 80000),
  ('ag-auth', 135000),
];

List<(String, int)> _started(Demo d, {int from = 0}) =>
    [for (final s in d.all('turn.started')) if (s.at >= from) (s.agent, s.at - from)];

void main() {
  test('the computer comes up showing Orca: its apps, then its ring, then what each agent did last', () async {
    final d = Demo();
    await d.start();
    d.run(0);
    expect(d.seen.first.type, 'link');
    expect(d.seen.first['up'], isTrue);
    expect(d.seen.first.text, 'MacBook Pro');
    expect(d.seen.first['offersNew'], isTrue);

    final apps = d.first('apps')!;
    expect(apps.text, 'orca');
    final rows = apps['rows'] as List<AppInfo>;
    // The mockup's apps, in its order: those with no agents too, so the demo's Apps is as full as the mockup's.
    expect([for (final r in rows) '${r.id} ${r.name} ${r.count} ${r.waiting}'], [
      'harness Harness 3 0',
      'orca Orca 5 0',
      'herdr herdr 2 0',
      'vscode VS Code 1 0',
      'cursor Cursor 0 0',
      'claude Claude 0 0',
      'codex ChatGPT 0 0',
      'terminal-app Terminal 0 0',
      'ghostty Ghostty 0 0',
      'iterm iTerm2 0 0',
      'cmux cmux 0 0',
    ]);

    final ring = d.first('agents')!;
    expect(d.seen.indexOf(ring), d.seen.indexOf(apps) + 1);
    final agents = ring['rows'] as List<AgentRow>;
    expect([for (final a in agents) '${a.id} ${a.name} ${a.engine} ${a.host} ${a.caps}'], [
      'ag-auth auth-refactor claude orca sv',
      'ag-hero landing-hero codex orca sv',
      'ag-e2e flaky-e2e claude orca sv',
      'ag-rate rate-limiter codex orca sv',
      'ag-sweep docs-sweep muse orca sv',
    ]);

    // History, not news: one summary for each agent of the ring.
    final history = d.all('summary').toList();
    expect(history.map((s) => s.agent), ['ag-auth', 'ag-hero', 'ag-e2e', 'ag-rate', 'ag-sweep']);
    expect(history.every((s) => s['restore'] == true), isTrue);
    expect(history.first['recap'], 'Sign-in posts to the new auth API');
    expect(d.seen.indexOf(history.first), greaterThan(d.seen.indexOf(ring)));
    expect(d.count('turn.started'), 0);
  });

  test('the timeline starts each turn at its time, in order', () async {
    final d = Demo();
    await d.start();
    d.runTo(160000);
    expect(_started(d), _timeline);
  });

  test('a turn plays its beats: spinner words, the sentence, steps, the clock, then the summary', () async {
    final d = Demo();
    await d.start();
    d.runTo(25000);
    final auth = d.all('turn.verb', agent: 'ag-auth').map((s) => s.text).toList();
    expect(auth, containsAllInOrder(['Planning', 'Editing', 'Running tests']));
    expect(d.first('turn.activity', agent: 'ag-auth')!.text,
        'Splitting the auth middleware: the session lookup moves out of the request handler.');
    expect(d.all('turn.step', agent: 'ag-auth').map((s) => s.text),
        ['Read · middleware.ts', 'Read · session.ts', 'Edit · session.ts', 'Edit · middleware.ts', 'Bash · npm test -- auth']);
    // The footer's timer rides on the activity: the turn's clock in seconds, the sentence left as it was.
    final timed = d.all('turn.activity', agent: 'ag-auth').where((s) => s['elapsed'] as int >= 0).toList();
    expect(timed, isNotEmpty);
    expect(timed.first.text, '');
    expect(timed.first['elapsed'], (timed.first.at - 1000) ~/ 1000);

    final done = d.first('turn.done', agent: 'ag-auth')!;
    final summary = d.all('summary', agent: 'ag-auth').firstWhere((s) => s['restore'] == false);
    expect(d.seen.indexOf(summary), d.seen.indexOf(done) + 1);
    expect(summary.at, 19500);
    expect(summary['recap'], 'Session lookup split out of the auth middleware');
    expect(summary.text,
        'The session lookup lives in session.ts now and the middleware only calls it. 64/64 tests pass.');
    expect(summary['tier'], SummaryTier.list);
  });

  test('one telling: every kind of card, each question answered on the computer when nobody is at the bar', () async {
    final d = Demo();
    await d.start();
    d.run(0);
    d.forget();
    d.runTo(160000);
    expect(d.count('turn.started'), 9);
    expect(d.count('question'), 3);
    expect(d.count('question.close'), 3);
    expect(d.count('turn.error'), 1);
    expect(d.count('turn.done'), 8);
    final news = d.all('summary').where((s) => s['restore'] == false).toList();
    expect(news.where((s) => s['tier'] == SummaryTier.alert).length, 3);
    expect(news.where((s) => s['tier'] == SummaryTier.list).length, 4);
    expect(news.where((s) => s['tier'] == SummaryTier.silent).length, 1);
    // docs-sweep and api-client rest the whole time.
    expect(d.count('turn.started', agent: 'ag-sweep') + d.count('turn.started', agent: 'ag-api'), 0);
  });

  test('the story loops: the second telling is the first again, with Orca in front', () async {
    final d = Demo();
    await d.start();
    d.runTo(160000);
    final firstTelling = d.seen.where((s) => s.type != 'level').length;
    d.forget();
    d.runTo(320000);
    expect(_started(d, from: 160000), _timeline);
    expect(d.count('question'), 3);
    expect(d.count('question.close'), 3);
    expect(d.count('turn.error'), 1);
    // The front moves as in the first telling: Harness at 70 s, Orca at 130 s.
    final moves = <(String, int)>[];
    for (final a in d.all('apps')) {
      if (moves.isEmpty || moves.last.$1 != a.text) moves.add((a.text, a.at - 160000));
    }
    expect(moves, containsAllInOrder([('harness', 70000), ('orca', 130000)]));
    expect(d.seen.length, lessThanOrEqualTo(firstTelling));
  });

  test('a person at the bar holds the story for a quiet minute, then it goes on', () async {
    final d = Demo();
    await d.start();
    d.run(0);
    d.link.openAgent('ag-rate');
    d.runTo(55000);
    expect(d.count('turn.started'), 0);
    d.runTo(61000);
    // Story time counts again from the minute's end: auth-refactor's 1 s entry.
    expect(_started(d).first, ('ag-auth', 61000));
  });

  test('New Harness starts an agent in Harness, which comes to the front; it leaves when the story starts over',
      () async {
    final d = Demo();
    await d.start();
    d.run(0);
    d.forget();
    d.link.newHarness();
    d.run(1499);
    expect(d.count('agents'), 0);
    d.run(1);
    final apps = d.first('apps')!;
    expect(apps.text, 'harness');
    expect([for (final r in (apps['rows'] as List<AppInfo>).take(4)) '${r.id} ${r.count}'],
        ['harness 4', 'orca 5', 'herdr 2', 'vscode 1']);
    final ring = d.first('agents')!;
    expect(ring.text, 'firmware-max,harness-cli,docs,harness-web');
    final made = (ring['rows'] as List<AgentRow>).last;
    expect([made.id, made.engine, made.host, made.caps], ['ag-new-1', 'claude', 'harness', 'svfa']);
    final started = d.runUntil('turn.started', agent: 'ag-new-1', ms: 1000);
    expect(started.at, 2000);
    final setUp = d.runUntil('summary', agent: 'ag-new-1', ms: 20000);
    expect(setUp['recap'], 'Set up and ready');

    // A second gets the next project.
    d.link.newHarness();
    d.run(1500);
    expect(d.all('agents').last.text, 'firmware-max,harness-cli,docs,harness-web,harness-cli-2');

    // The story starts over a quiet minute after the last touch and a whole telling later: the made agents are gone.
    final lastTouch = setUp.at;
    d.forget();
    d.runTo(lastTouch + 60000 + 160000 + 1000);
    final harnessRow = (d.all('apps').last['rows'] as List<AppInfo>).firstWhere((r) => r.id == 'harness');
    expect(harnessRow.count, 3);
  });

  test('stop leaves no timer running', () async {
    final d = Demo();
    await d.start();
    d.runTo(12000);
    d.link.startTalk('ag-auth');
    d.run(100);
    await d.link.stop();
    expect(d.clock.pending, 0);
    d.forget();
    d.run(200000);
    expect(d.seen, isEmpty);
  });
}
