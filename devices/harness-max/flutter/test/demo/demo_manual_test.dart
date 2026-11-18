// The demo a person drives (HARNESS_MAX_DEMO=manual): the computer opens at rest, every agent done or resting, and does
// nothing by itself. Each case comes from words said to an agent: some agents' words alternate between their case (a
// failure, a question, a permission prompt) and the mockup's line, so a case can be played again without a restart.
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
  test('it opens at rest on Orca: every agent done or resting, none at work or asking', () async {
    final d = await _manual();
    expect(d.first('apps')!.text, 'orca');
    expect(d.count('turn.started'), 0);
    expect(d.count('question'), 0);
    expect(d.count('summary', agent: 'ag-e2e'), 1, reason: 'its last work, restored');
  });

  test('nothing happens by itself: no work, no front change, no new telling', () async {
    final d = await _manual();
    d.forget();
    d.run(10 * 60 * 1000);
    expect(d.seen.where((s) => s.type != 'level'), isEmpty);
  });

  test('rate-limiter: the first words start a turn that fails, the next a turn that ends well, then it fails again',
      () async {
    final d = await _manual();
    _talk(d, 'ag-rate');
    expect(d.runUntil('turn.started', agent: 'ag-rate', ms: 2000).text, 'Add a sliding-window limit to the public API');
    expect(d.runUntil('turn.error', agent: 'ag-rate', ms: 20000).text, 'npm test failed: 3 rate-limit tests time out');
    d.forget();
    _talk(d, 'ag-rate');
    expect(d.runUntil('turn.started', agent: 'ag-rate', ms: 2000).text, 'Start with the login route only');
    d.runUntil('summary', agent: 'ag-rate', ms: 20000);
    d.forget();
    _talk(d, 'ag-rate');
    d.runUntil('turn.error', agent: 'ag-rate', ms: 20000);
  });

  test('landing-hero: its words end in a question shown only, answered in Orca once the bar brings it up', () async {
    final d = await _manual();
    _talk(d, 'ag-hero');
    final ask = d.runUntil('question', agent: 'ag-hero', ms: 20000);
    expect(ask.text, 'Use the new image in the hero, or keep the video? · answer in Orca');
    d.run(5 * 60 * 1000);
    expect(d.count('question.close', agent: 'ag-hero'), 0, reason: 'it waits for the person');
    d.link.openAgent('ag-hero');
    d.runUntil('question.close', agent: 'ag-hero', ms: 10000);
  });

  test('Harness: firmware-max\'s words end in the yes to flash; harness-cli\'s in a question the bar answers', () async {
    final d = await _manual();
    d.link.pickApp('harness');
    d.run(0);
    expect(d.all('apps').last.text, 'harness');
    expect(d.count('question'), 0, reason: 'Harness rests too');
    _talk(d, 'ag-fw');
    final flash = d.runUntil('question', agent: 'ag-fw', ms: 20000);
    expect([flash.text, flash['permission']], ['Bash: idf.py -p /dev/ttyACM0 flash', true]);
    _talk(d, 'ag-cli');
    final proto = d.runUntil('question', agent: 'ag-cli', ms: 20000);
    expect([proto.text, proto['permission']], ['Bump the cable protocol to 4, or keep 3 and add a field?', false]);
    // Words said to it now are its answer: Keep 3.
    _talk(d, 'ag-cli');
    d.runUntil('question.close', agent: 'ag-cli', ms: 5000);
  });

  test('an agent with no case of its own: the mockup\'s line, a turn that ends loud, then rest', () async {
    final d = await _manual();
    _talk(d, 'ag-e2e');
    expect(d.runUntil('turn.started', agent: 'ag-e2e', ms: 2000).text, 'Great, now run it fifty more times on CI');
    final done = d.runUntil('summary', agent: 'ag-e2e', ms: 20000);
    expect(done['restore'], isFalse);
    d.forget();
    d.run(10 * 60 * 1000);
    expect(d.seen.where((s) => s.type != 'level'), isEmpty);
  });
}
