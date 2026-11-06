import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';

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
    test('not switched reads as today: no Board mode, everyone who may write may chat, nobody steers but the owner', () {
      final p = SuperTabProject.fromJson(_project());
      expect(p.boardMode, isFalse);
      expect(p.deciderId, isNull);
      expect(p.canChatIds, isEmpty);
      expect(p.canChat('tuan'), isTrue);
      expect(p.canSteer('owner'), isTrue);
      expect(p.canSteer('tuan'), isFalse);
    });

    test('switched: Can chat is the owner, the Swarm owner and the people granted it; the decider steers', () {
      final p = SuperTabProject.fromJson(
        _project({
          'boardMode': true,
          'canChat': ['dee'],
          'decider': 'dee',
        }),
      );
      expect(p.boardMode, isTrue);
      expect(p.canChatIds, ['dee']);
      expect(p.deciderId, 'dee');
      expect(p.canChat('owner'), isTrue);
      expect(p.canChat('dee'), isTrue);
      expect(p.canChat('tuan'), isFalse);
      expect(p.canChat('tuan', swarmOwner: true), isTrue);
      expect(p.canSteer('dee'), isTrue);
      expect(p.canSteer('tuan'), isFalse);
      expect(p.canSteer('tuan', swarmOwner: true), isTrue);
    });
  });

  group('a task', () {
    test('paused carries who, when and why; absent reads as not paused', () {
      final at = DateTime.utc(2026, 11, 6, 9);
      final paused = SuperTabConversation.fromJson({
        ...conversationFixture('t', 'Task'),
        'paused': {
          'by': 'dee',
          'at': at.millisecondsSinceEpoch,
          'reason': 'Waiting for the release',
        },
      });
      expect(paused.paused?.by, 'dee');
      expect(paused.paused?.at, at.toLocal());
      expect(paused.paused?.reason, 'Waiting for the release');
      expect(
        SuperTabConversation.fromJson(conversationFixture('t', 'Task')).paused,
        isNull,
      );
    });
  });

  group('Buddies', () {
    Map<String, dynamic> buddy(String id, String name, {bool? isDefault}) => {
      ...conversationFixture(id, name),
      'kind': 'swarm-buddy',
      'buddyOwnerId': 'owner',
      'buddyDefault': ?isDefault,
    }..remove('projectId');

    test('the reader\'s Buddies list default first; one flagged default wins, else the first', () async {
      final server = ConversationServer();
      server.state['swarmBuddy'] = true;
      (server.state['conversations'] as List).addAll([
        buddy('b-code', 'Code'),
        buddy('b-plan', 'Planning', isDefault: true),
        {...buddy('b-other', "Sam's Buddy"), 'buddyOwnerId': 'sam'},
      ]);
      final c = server.controller();
      await c.refresh();
      expect([for (final b in c.buddies()) b.id], ['b-plan', 'b-code']);
      expect(c.buddies().first.buddyDefault, isTrue);
      // The one Buddy chat the rest of the app opens is the default.
      expect(c.buddyChat(SuperTabController.kSwarmBuddyKey)?.id, 'b-plan');
      await c.flush();
      c.dispose();
    });

    test('with no chat flagged (an older backend) the first is the default, as today', () async {
      final server = ConversationServer();
      server.state['swarmBuddy'] = true;
      (server.state['conversations'] as List).addAll([
        buddy('b-code', 'Code'),
        buddy('b-plan', 'Planning'),
      ]);
      final c = server.controller();
      await c.refresh();
      expect([for (final b in c.buddies()) b.id], ['b-code', 'b-plan']);
      expect(c.buddyChat(SuperTabController.kSwarmBuddyKey)?.id, 'b-code');
      await c.flush();
      c.dispose();
    });
  });
}
