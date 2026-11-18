// A talk in the demo: the recording's state and levels (the mic's, or made up), the send, and what the agent then does
// with the words (the mockup's SAY lines).
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';

import 'demo_support.dart';

Future<Demo> _started({FakeMic? mic}) async {
  final d = Demo(mic: mic);
  await d.start();
  d.run(0);
  d.forget();
  return d;
}

List<double> _levels(Iterable<Seen> seen) => [for (final s in seen) s['level'] as double];

void main() {
  test('a talk records, sends, and the agent works on what was said', () async {
    final d = await _started();
    d.link.startTalk('ag-sweep');
    d.run(0);
    expect(d.all('talk').map((s) => s.text), ['recording']);
    d.run(3000);
    expect(d.count('level'), greaterThan(0));

    final sentAt = d.now;
    d.link.sendTalk();
    d.run(0);
    expect(d.all('talk').last.text, 'sending');
    d.run(599);
    expect(d.all('talk').last.text, 'sending');
    expect(d.count('turn.started', agent: 'ag-sweep'), 0);
    d.run(1);
    expect(d.all('talk').last.text, 'idle');
    final started = d.first('turn.started', agent: 'ag-sweep')!;
    expect(started.at, sentAt + 600);
    expect(started.text, 'Sweep the setup docs for dead links');
    expect(d.all('level').last.at, lessThanOrEqualTo(sentAt));

    final done = d.runUntil('summary', agent: 'ag-sweep', ms: 15000);
    expect(done['recap'], 'The setup docs have no dead links');
    expect(done['tier'], SummaryTier.alert);
    expect(d.all('turn.verb', agent: 'ag-sweep'), isNotEmpty);
    expect(d.all('turn.step', agent: 'ag-sweep').first.text, 'Bash · npx check-links docs/setup');
  });

  test('with no mic the levels are made up at 20 Hz: speech for 2.2 s, then near silence until it ends', () async {
    final d = await _started();
    d.link.startTalk('ag-auth');
    d.run(0);
    final from = d.now;
    d.run(5000);
    final all = d.all('level').toList();
    expect(all.length, 100);
    final speech = _levels(all.where((s) => s.at - from < 2200));
    final quiet = _levels(all.where((s) => s.at - from >= 2200));
    expect(speech.length, 43);
    expect(speech.every((l) => l >= 0.3 && l <= 0.9), isTrue);
    // Speech-like: it moves, rather than holding one level.
    expect(speech.toSet().length, greaterThan(20));
    expect(quiet.every((l) => l > 0 && l <= 0.05), isTrue);

    d.link.cancelTalk();
    d.run(0);
    expect(d.all('talk').last.text, 'idle');
    final ended = d.count('level');
    d.run(2000);
    expect(d.count('level'), ended);
    expect(d.count('turn.started', agent: 'ag-auth'), 0);
  });

  test('a mic that opens gives its own levels, its recording is drained, and it closes when the talk ends', () async {
    final mic = FakeMic();
    final d = await _started(mic: mic);
    d.link.startTalk('ag-auth');
    d.run(0);
    await settle();
    expect(mic.opened, 1);
    mic.levelsIn.add(0.7);
    await settle();
    d.run(1000);
    expect(_levels(d.all('level')), [0.7]);
    expect(mic.pcmListening, isTrue);

    d.link.cancelTalk();
    d.run(0);
    await settle();
    expect(mic.closed, 1);
    expect(mic.pcmListening, isFalse);
    expect(d.all('talk').last.text, 'idle');
    mic.levelsIn.add(0.5);
    await settle();
    expect(_levels(d.all('level')), [0.7]);
  });

  test('a mic that does not open: the levels are made up instead', () async {
    final mic = FakeMic(opens: false);
    final d = await _started(mic: mic);
    d.link.startTalk('ag-auth');
    d.run(0);
    await settle();
    d.run(1000);
    expect(mic.opened, 1);
    expect(d.count('level'), 20);
  });

  test('a talk that ends before the mic opens closes it once it does', () async {
    final mic = FakeMic();
    final d = await _started(mic: mic);
    d.link.startTalk('ag-auth');
    d.run(0);
    d.link.cancelTalk();
    d.run(0);
    await settle();
    expect(mic.opened, 1);
    expect(mic.closed, 1);
    mic.levelsIn.add(0.6);
    await settle();
    expect(d.count('level'), 0);
  });

  test('words to a busy agent go when its turn ends, after a breath', () async {
    final d = Demo();
    await d.start();
    d.runTo(2000);
    d.link.startTalk('ag-auth');
    d.run(1000);
    d.link.sendTalk();
    d.run(600);
    expect(d.count('turn.started', text: 'Also cover the expired token case with a test'), 0);
    final done = d.runUntil('turn.done', agent: 'ag-auth');
    expect(done.at, 19500);
    final reply = d.runUntil('turn.started', agent: 'ag-auth', ms: 2000);
    expect([reply.at, reply.text], [20500, 'Also cover the expired token case with a test']);
    expect(d.runUntil('summary', agent: 'ag-auth')['recap'], 'Expired tokens are covered by a test');
  });

  test("an agent with no line of its own runs the suite again", () async {
    final d = await _started();
    d.link.startTalk('ag-hero');
    d.run(1500);
    d.link.sendTalk();
    d.run(600);
    expect(d.first('turn.started', agent: 'ag-hero')!.text, 'Run the suite again before you push');
    expect(d.runUntil('summary', agent: 'ag-hero')['recap'], 'The whole suite passes');
  });

  test("Say it answers the question with the option the words name; no new turn", () async {
    final d = Demo();
    await d.start();
    d.runUntil('question', agent: 'ag-cli');
    d.link.startTalk('ag-cli');
    d.run(2000);
    final sentAt = d.now;
    d.link.sendTalk();
    final closed = d.runUntil('question.close', agent: 'ag-cli', ms: 2000);
    expect(closed.at, sentAt + 600 + 1000);
    final done = d.runUntil('summary', agent: 'ag-cli');
    expect(done['recap'], 'The app list rides on proto 3');
    expect(d.count('turn.started', agent: 'ag-cli'), 1);
  });

  test('a permission prompt never takes words: they wait for the turn to end', () async {
    final d = Demo();
    await d.start();
    d.runUntil('question', agent: 'ag-fw');
    d.link.startTalk('ag-fw');
    d.run(2000);
    d.link.sendTalk();
    d.run(3000);
    expect(d.count('question.close', agent: 'ag-fw'), 0);
    final done = d.runUntil('summary', agent: 'ag-fw');
    expect(done['recap'], contains('flashed'));
    final reply = d.runUntil('turn.started', agent: 'ag-fw', ms: 2000);
    expect(reply.text, 'Flash it when the build is green');
  });

  test('an agent the bar cannot talk to is refused in the daemon\'s words', () async {
    final d = await _started();
    d.link.startTalk('ag-api');
    d.run(1000);
    expect(d.first('toast')!.text, 'This agent is in VS Code. Talking to it from the device comes in an update.');
    expect(d.all('talk').map((s) => s.text), ['idle']);
    expect(d.count('level'), 0);
    d.link.startTalk('ag-gone');
    d.run(0);
    expect(d.all('toast').last.text, 'Could not reach that harness. Check its connection and try again.');
  });

  test('a cancel sends nothing', () async {
    final d = await _started();
    d.link.startTalk('ag-sweep');
    d.run(1000);
    d.link.cancelTalk();
    d.run(0);
    expect(d.all('talk').map((s) => s.text), ['recording', 'idle']);
    d.run(5000);
    expect(d.count('turn.started', agent: 'ag-sweep'), 0);
    // A send with no recording open is nothing either.
    d.link.sendTalk();
    d.run(1000);
    expect(d.all('talk').map((s) => s.text), ['recording', 'idle']);
  });

  test('a new talk while the last is still being sent keeps both', () async {
    final d = await _started();
    d.link.startTalk('ag-sweep');
    d.run(1000);
    d.link.sendTalk();
    d.run(100);
    d.link.startTalk('ag-docs');
    d.run(1000);
    // The second recording is not told idle by the first send's end.
    expect(d.all('talk').map((s) => s.text), ['recording', 'sending', 'recording']);
    expect(d.first('turn.started', agent: 'ag-sweep')!.text, 'Sweep the setup docs for dead links');
    d.link.sendTalk();
    d.run(600);
    expect(d.all('talk').last.text, 'idle');
    expect(d.first('turn.started', agent: 'ag-docs')!.text, 'Add a picture of the menu-bar app');
  });
}
