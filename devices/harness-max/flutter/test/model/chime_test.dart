// The bar chimes as the C build does (max_app.c alert_locked): a new question, a failure, a loud finished turn; one
// chime for the alerts of 30 s.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';

import 'bar_harness.dart';

void main() {
  test('a new question chimes; the same question sent again does not', () {
    final b = linked(abc);
    b.model.onQuestion('a', 'toolu_1', db.q, items: const [db]);
    expect(b.chime.plays, 1);
    b.at(40000);
    b.model.onQuestion('a', 'toolu_1', db.q, items: const [db]);
    expect(b.chime.plays, 1);
  });

  test('a permission prompt chimes', () {
    final b = linked(abc);
    b.model.onQuestion('a', 'toolu_1', deploy.q, items: const [deploy], permission: true);
    expect(b.chime.plays, 1);
  });

  test('a failure chimes', () {
    final b = linked(abc);
    b.model.onTurn('a', 'started', 'Working');
    b.model.onTurn('a', 'error', 'boom');
    expect(b.chime.plays, 1);
  });

  test('a loud finished turn chimes; a listed or silent one, or one restored on connect, does not', () {
    final b = linked(abcde);
    for (final id in ['a', 'b', 'c', 'd']) {
      b.model.onTurn(id, 'started', 'Working');
    }
    b.model.onSummary('b', 'Listed', tier: SummaryTier.list);
    b.model.onSummary('c', 'Quiet', tier: SummaryTier.silent);
    b.model.onSummary('d', 'From before', restore: true);
    expect(b.chime.plays, 0);
    b.model.onSummary('a', 'Fixed the flaky test');
    expect(b.chime.plays, 1);
  });

  test('starting work, its progress and resting never chime', () {
    final b = linked(abc);
    b.model.onTurn('a', 'started', 'Working');
    b.model.onTurn('a', 'verb', 'Editing');
    b.model.onTurn('a', 'activity', 'session.ts', elapsedS: 3);
    b.model.onTurn('a', 'done', '');
    expect(b.chime.plays, 0);
  });

  test('one chime for the alerts of 30 s, then the next chimes again', () {
    final b = linked(abc);
    b.model.onQuestion('a', 'toolu_1', db.q, items: const [db]);
    b.at(10000);
    b.model.onTurn('b', 'started', 'Working');
    b.model.onTurn('b', 'error', 'boom');
    b.at(29999);
    b.model.onQuestion('c', 'toolu_2', deploy.q, items: const [deploy], permission: true);
    expect(b.chime.plays, 1);
    b.at(30000);
    b.model.onQuestionClose('c');
    b.model.onQuestion('c', 'toolu_3', db.q, items: const [db]);
    expect(b.chime.plays, 2);
  });
}
