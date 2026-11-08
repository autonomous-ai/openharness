// Line templates: slots are filled from what the window knows; a slot it
// cannot fill takes its clause with it; nothing is ever shown as `{who}` or
// made up. Plain lines pass through unchanged.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/daemon_lines.dart';
import 'package:harness/daemons/roster.dart';

void main() {
  const who = {'who': 'codex@office'};

  test('plain lines pass through as they are', () {
    expect(
      fillDaemonLine('two agents idle. nothing needs you.', const {}),
      'two agents idle. nothing needs you.',
    );
    for (final d in daemonRoster.daemons) {
      for (final mood in DaemonMood.values) {
        final line = d.line(mood);
        if (!isDaemonTemplate(line)) {
          expect(daemonLine(d, mood, const {}), line, reason: d.id);
        }
      }
    }
  });

  test('every slot filled', () {
    expect(
      fillDaemonLine('bell in {who}: {q}', {...who, 'q': 'run the migration?'}),
      'bell in codex@office: run the migration?',
    );
    expect(fillDaemonLine('{n} in flight.', {'n': '3'}), '3 in flight.');
    expect(
      fillDaemonLine('welcome back. {summary}', {
        'summary': '2 done, 1 waiting 40m',
      }),
      'welcome back. 2 done, 1 waiting 40m',
    );
  });

  test('a missing slot drops its clause, never shows the slot', () {
    expect(fillDaemonLine('bell in {who}: {q}', who), 'bell in codex@office');
    expect(fillDaemonLine('silence in {who}: {recap}', who), 'silence in codex@office');
    expect(fillDaemonLine('{who} finished. {recap}', who), 'codex@office finished.');
    expect(fillDaemonLine('welcome back. {summary}', const {}), 'welcome back.');
    expect(
      fillDaemonLine('[1]  + done  {who}  {recap}', who),
      '[1]  + done  codex@office',
    );
    expect(
      fillDaemonLine('E325: ATTENTION  {who}: {q}', who),
      'E325: ATTENTION  codex@office',
    );
    // A label with nothing after it is not a line.
    expect(fillDaemonLine('E37: {who} wants to write.', const {}), isNull);
    expect(fillDaemonLine('{who}: {q}', const {}), isNull);
    // Voice v3: facts first, a short tag at the end. Without the facts the
    // tag alone is not a line.
    expect(fillDaemonLine('{who}: {q}  (bell)', const {}), isNull);
    expect(
      fillDaemonLine('{who}: {q}  (bell)', who),
      'codex@office  (bell)',
    );
    expect(
      fillDaemonLine('{who} failed: {recap}  [exit 1]', const {}),
      isNull,
    );
    for (final d in daemonRoster.daemons) {
      for (final mood in [DaemonMood.need, DaemonMood.fail]) {
        expect(
          daemonLine(d, mood, const {}),
          neutralDaemonLines[mood],
          reason: '${d.id} ${mood.name}: nothing known, the neutral line',
        );
      }
    }
    // Only the sentence that needs the slot goes.
    expect(
      fillDaemonLine('{who} is waiting: {q}. you there?', const {}),
      'you there?',
    );
  });

  test('a line that cannot be filled becomes the neutral line', () {
    final tim = daemonRoster.byId('tim')!;
    for (final mood in DaemonMood.values) {
      final line = daemonLine(tim, mood, const {});
      expect(line.contains('{'), isFalse, reason: mood.name);
      expect(line, isNotEmpty);
    }
    expect(neutralDaemonLines[DaemonMood.need], 'a harness needs you.');
  });

  test('values are one short line', () {
    expect(slotValue('  run\nthe   migration?  '), 'run the migration?');
    expect(slotValue(''), isNull);
    final long = slotValue('x' * 100, limit: 20)!;
    expect(long.length, 20);
    expect(long, endsWith('...'));
  });
}
