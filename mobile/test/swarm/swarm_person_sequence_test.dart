import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// Task #2427: each conversation's newest main message from a person (backend
/// parts/commit.ts `lastPersonSequence`), which the desktop's sidebar bolds
/// by. The phone reads it as the desktop does (desktop_parity_test.dart), so
/// nothing the backend sends is dropped here; its own bold rule is unchanged.
void main() {
  Map<String, dynamic> row([Map<String, dynamic> extra = const {}]) => {
    'id': 'g1',
    'title': 'Search',
    'leadId': null,
    'agentIds': <String>[],
    'archived': false,
    'brief': '',
    'checks': <dynamic>[],
    'assignment': null,
    'lastMessageSequence': 9,
    'lastMainSequence': 8,
    ...extra,
  };

  test('reads a conversation\'s newest message from a person, 0 when the server sent none', () {
    expect(
      SuperTabConversation.fromJson(row({'lastPersonSequence': 7}))
          .lastPersonSequence,
      7,
    );
    expect(SuperTabConversation.fromJson(row()).lastPersonSequence, 0);
  });
}
