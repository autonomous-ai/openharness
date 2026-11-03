import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

import 'swarm_fixture.dart';

/// A Buddy chat carries the name its person chose for their Buddy, kept while
/// no Buddy runs, as the desktop's model does (desktop_parity_test).
void main() {
  test('a Buddy chat keeps the name its person chose', () {
    final chat = SuperTabConversation.fromJson({
      ...buddyChatData('c1', agentIds: const []),
      'buddyName': 'Sparky',
    });

    expect(chat.buddyName, 'Sparky');
  });

  test('a chat with no chosen name, as from an older backend, has none', () {
    final chat = SuperTabConversation.fromJson(
      buddyChatData('c1', agentIds: const []),
    );

    expect(chat.buddyName, isNull);
  });
}
