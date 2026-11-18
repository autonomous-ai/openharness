// The demo a person drives (HARNESS_MAX_DEMO=manual): the computer starts with every state standing, then does nothing
// by itself. No story, no app in front changing, no question answered for the person, no telling again; each case
// comes from what the person does at the bar.
import 'package:flutter_test/flutter_test.dart';

import 'demo_support.dart';

Future<Demo> _manual() async {
  final d = Demo(manual: true);
  await d.start();
  d.run(0);
  return d;
}

/// Talks to [agent] (made-up speech) and sends it once the speech is over.
void _talk(Demo d, String agent) {
  d.link.startTalk(agent);
  d.run(2500);
  d.link.sendTalk();
  d.run(0);
}

void main() {
  test('it opens on Orca with work standing: two agents at work, one asking, the rest done', () async {
    final d = await _manual();
    expect(d.first('apps')!.text, 'orca');
    expect(d.all('turn.verb', agent: 'ag-auth').last.text, 'Editing');
    expect(d.all('turn.verb', agent: 'ag-rate').last.text, 'Running tests');
    final hero = d.first('question', agent: 'ag-hero')!;
    expect(hero.text, 'Use the new image in the hero, or keep the video? · answer in Orca');
    expect(d.count('turn.error'), 0);
    expect(d.count('summary', agent: 'ag-e2e'), 1, reason: 'its last work, restored');
  });

  test('nothing happens by itself: no new work, no front change, no answer, no new telling', () async {
    final d = await _manual();
    d.forget();
    d.run(10 * 60 * 1000);
    expect(d.seen.where((s) => s.type != 'level'), isEmpty);
  });

  test('Harness, when the person picks it, has its own standing work: a build, and a question the bar answers', () async {
    final d = await _manual();
    d.forget();
    d.link.pickApp('harness');
    d.run(0);
    expect(d.first('apps')!.text, 'harness');
    expect(d.all('turn.verb', agent: 'ag-fw').last.text, 'Building');
    final cli = d.first('question', agent: 'ag-cli')!;
    expect(cli.text, 'Bump the cable protocol to 4, or keep 3 and add a field?');
    expect(cli['permission'], isFalse);
  });

  test('talking to an agent at standing work lets it go on: rate-limiter fails, nothing else queued', () async {
    final d = await _manual();
    d.forget();
    _talk(d, 'ag-rate');
    final failed = d.runUntil('turn.error', agent: 'ag-rate', ms: 15000);
    expect(failed.text, 'npm test failed: 3 rate-limit tests time out');
    d.run(60000);
    expect(d.count('turn.started', agent: 'ag-rate'), 0, reason: 'the words moved its work on; no turn of their own');
  });

  test('talking to firmware-max lets its build go on to the flash, which asks for the person\'s yes', () async {
    final d = await _manual();
    d.link.pickApp('harness');
    d.run(0);
    d.forget();
    _talk(d, 'ag-fw');
    final ask = d.runUntil('question', agent: 'ag-fw', ms: 15000);
    expect(ask['permission'], isTrue);
    expect(ask.text, 'Bash: idf.py -p /dev/ttyACM0 flash');
  });

  test('talking to an agent at rest starts the work the words ask for, which ends loud', () async {
    final d = await _manual();
    d.forget();
    _talk(d, 'ag-e2e');
    expect(d.runUntil('turn.started', agent: 'ag-e2e', ms: 2000).text, 'Great, now run it fifty more times on CI');
    final done = d.runUntil('summary', agent: 'ag-e2e', ms: 20000);
    expect(done['restore'], isFalse);
    d.forget();
    d.run(10 * 60 * 1000);
    expect(d.seen.where((s) => s.type != 'level'), isEmpty, reason: 'and then it rests until spoken to again');
  });

  test('a question shown only waits for the person, and is answered in its app once the bar brings it up', () async {
    final d = await _manual();
    d.forget();
    d.run(5 * 60 * 1000);
    expect(d.count('question.close', agent: 'ag-hero'), 0);
    d.link.openAgent('ag-hero');
    d.runUntil('question.close', agent: 'ag-hero', ms: 10000);
  });
}
