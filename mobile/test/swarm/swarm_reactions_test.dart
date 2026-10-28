import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';

import 'swarm_fixture.dart';

/// Emoji reactions on a Swarm message, as Desktop draws them (backend
/// reactions.ts): the counts under it, the reader's own marked, and the six
/// a long-press offers.
void main() {
  group('the reaction counter', () {
    SuperTabConversation g1(Map<String, dynamic> extra) =>
        SuperTabSnapshot.fromJson(
          SuperTabParts.firstLoad(
            firstLoad(
              groups: [
                {...groupData('g1', title: 'Fix login'), ...extra},
              ],
            ),
          ).state,
        ).conversation('g1')!;

    test('a conversation carries the counter its read sends', () {
      expect(g1({'reactionSeq': 7}).reactionSeq, 7);
    });

    test('a conversation nobody reacted in counts none', () {
      expect(g1(const {}).reactionSeq, 0);
    });
  });
}
