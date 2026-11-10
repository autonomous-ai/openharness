import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';

/// Task #3820 (Phase 2 of the Board, spec docs/plans/2026-11-06-buddy-board-final-spec.md): the fields the backend's
/// #3817, #3818 and #3819 add, read by Desktop. With none of them, every getter reads as today.

Map<String, dynamic> _project([Map<String, dynamic> extra = const {}]) => {
  'id': 'harness',
  'name': 'harness',
  'ownerId': 'owner',
  'leadConversationId': 'lead',
  'members': [
    {'id': 'owner'},
    {'id': 'dee'},
    {'id': 'tuan'},
  ],
  ...extra,
};

void main() {
  group('a project', () {
    test(
      'not switched reads as today: no Board mode, nobody steers but the owner',
      () {
        final p = SuperTabProject.fromJson(_project());
        expect(p.boardMode, isFalse);
        expect(p.deciderId, isNull);
        expect(p.canSteer('owner'), isTrue);
        expect(p.canSteer('tuan'), isFalse);
      },
    );

    test('switched: the decider steers', () {
      final p = SuperTabProject.fromJson(
        _project({'boardMode': true, 'decider': 'dee'}),
      );
      expect(p.boardMode, isTrue);
      expect(p.deciderId, 'dee');
      expect(p.canSteer('dee'), isTrue);
      expect(p.canSteer('tuan'), isFalse);
      expect(p.canSteer('tuan', swarmOwner: true), isTrue);
    });
  });
}
