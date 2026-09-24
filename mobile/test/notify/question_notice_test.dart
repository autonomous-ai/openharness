import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/question_notice.dart';

/// The dial's rule for a question — `ui_question_show` / `ui_question_close`.
void main() {
  const a = (machineId: 'm', agentId: 'a');
  const b = (machineId: 'm', agentId: 'b');

  test('a request is news once per agent', () {
    final asked = AskedQuestions();
    expect(asked.hear(a, 'q1'), isTrue);
    expect(asked.hear(a, 'q1'), isFalse);
    expect(asked.hear(b, 'q1'), isTrue, reason: 'another agent');
    expect(asked.hear(a, 'q2'), isTrue, reason: 'the next page');
  });

  test('only the open request, or any, can be forgotten', () {
    final asked = AskedQuestions()..hear(a, 'q2');
    expect(asked.forget(a, requestId: 'q1'), isFalse);
    expect(asked.forget(a, requestId: ''), isTrue);
    expect(asked.forget(a), isFalse, reason: 'already gone');
    expect(asked.hear(a, 'q2'), isTrue, reason: 'asked again after its end');
  });

  test('a repeat is silent; a new one escalates like a finished turn', () {
    for (final inFront in [true, false]) {
      expect(
        decideQuestionNotice(isNew: false, inFront: inFront, watching: false),
        AgentNotice.none,
      );
    }
    expect(
      decideQuestionNotice(isNew: true, inFront: true, watching: true),
      AgentNotice.chime,
    );
    expect(
      decideQuestionNotice(isNew: true, inFront: true, watching: false),
      AgentNotice.mark,
    );
    expect(
      decideQuestionNotice(isNew: true, inFront: false, watching: true),
      AgentNotice.alert,
    );
  });
}
