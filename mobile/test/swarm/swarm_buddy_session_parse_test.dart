import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// Buddy thread sessions' fields (desktop model.dart, spec 2026-10-30-buddy-
/// thread-sessions): the phone reads them as the desktop does, and a value of
/// an unexpected type never breaks the read.
void main() {
  test('unexpected types in session fields never break the read', () {
    expect(SuperTabBuddySessionOf.fromJson({'thread': 5, 'from': 'x'}), isNull);
    expect(SuperTabBuddySessionOf.fromJson('not a map'), isNull);
    expect(
      SuperTabBuddySessionOf.fromJson({'thread': 'r', 'from': 'x'})!.from,
      0,
    );
    final odd = SuperTabBuddySession.fromJson({
      'thread': 'r',
      'startId': 3,
      'agentId': 7,
      'at': 'soon',
    });
    expect([odd.thread, odd.startId, odd.agentId, odd.at], ['r', '', null, 0]);
    Map<String, dynamic> chat(Object? sessions) => {
      'id': 'c',
      'kind': 'buddy',
      'buddyOwnerId': 'p',
      'title': 'Wren',
      'agentIds': <String>[],
      'archived': false,
      'brief': '',
      'checks': <dynamic>[],
      'assignment': null,
      'lastMessageSequence': 0,
      'buddySessions': sessions,
    };
    expect(
      SuperTabConversation.fromJson(chat({'thread': 'r'})).buddySessions,
      isEmpty,
    );
    expect(
      SuperTabConversation.fromJson(
        chat([
          'nope',
          {'thread': 'r', 'startId': 's'},
        ]),
      ).buddySessions.single.startId,
      's',
    );
  });
}
