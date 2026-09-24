import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';

void main() {
  const ref = (machineId: 'machine-1', agentId: 'agent-7');

  test('a tapped notice leads back to the agent it was about', () {
    expect(decodeAgentPayload(encodeAgentPayload(ref)), ref);
  });

  test('a payload that is not ours opens nothing', () {
    for (final payload in [null, '', 'one-part', 'a\nb\nc', '\nagent']) {
      expect(decodeAgentPayload(payload), isNull, reason: '$payload');
    }
  });

  test('one id per agent, stable and positive', () {
    final id = noticeIdFor(ref);
    expect(noticeIdFor(ref), id);
    expect(id, greaterThanOrEqualTo(0));
    expect(
      noticeIdFor((machineId: 'machine-1', agentId: 'agent-8')),
      isNot(id),
    );
  });
}
