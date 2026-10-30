import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

import 'swarm_fixture.dart';

/// A chat carries what the server last found about its task, as the
/// desktop's model does (desktop_parity_test): whether it waits on purpose or
/// is stuck, and its Product Manager's last action on it.
void main() {
  test(
    "a chat keeps its task's state and its Product Manager's last action",
    () {
      final chat = SuperTabConversation.fromJson({
        ...groupData('g1', title: 'Fix login'),
        'liveness': {'state': 'quiet', 'why': 'silent', 'since': 1761714000000},
        'leadAction': {'kind': 'post', 'at': 1761714600000},
      });

      expect(chat.liveness, {
        'state': 'quiet',
        'why': 'silent',
        'since': 1761714000000,
      });
      expect(chat.leadAction, {'kind': 'post', 'at': 1761714600000});
    },
  );

  test('a task at work, an older backend, or a value that is no map, has '
      'none', () {
    for (final row in [
      groupData('g1', title: 'Fix login'),
      {
        ...groupData('g1', title: 'Fix login'),
        'liveness': 'quiet',
        'leadAction': ['post'],
      },
    ]) {
      final chat = SuperTabConversation.fromJson(row);
      expect(chat.liveness, isNull);
      expect(chat.leadAction, isNull);
    }
  });
}
