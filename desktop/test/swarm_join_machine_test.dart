import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_machine.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';

void main() {
  final server = ConversationServer();
  test(
    'a snapshot reads whether the Swarm uses Team accounts, absent meaning yes',
    () {
      SuperTabSnapshot read(Map<String, dynamic> extra) =>
          SuperTabSnapshot.fromJson({...server.state, ...extra});
      expect(read({}).teamAccounts, isTrue);
      expect(read({'teamAccounts': false}).teamAccounts, isFalse);
    },
  );

  // Review of #2188: an invitation accepted on this computer by someone who
  // joined by link on another one made no membership, and shares nothing.
  test('a join or accept adds this computer only when the server says it made the membership', () {
    // An invitation's accept answers as the backend's commands.ts does.
    expect(
      swarmNewMemberRole({
        'conversationId': 'lead',
        'alreadyMember': false,
        'role': 'collaborator',
      }),
      'collaborator',
    );
    expect(
      swarmNewMemberRole({
        'conversationId': 'lead',
        'alreadyMember': true,
        'role': 'collaborator',
      }),
      isNull,
    );
    // A link join, as store.ts answers it.
    expect(
      swarmNewMemberRole({
        'id': 'tab',
        'role': 'viewer',
        'alreadyMember': false,
      }),
      'viewer',
    );
    // An older server says neither: nothing is added.
    expect(swarmNewMemberRole({'conversationId': 'lead'}), isNull);
    expect(swarmNewMemberRole({'alreadyMember': false}), isNull);
  });

  // Re-check of #2188: every computer sent one fixed operation for an
  // invitation, so a stale accept on computer B got A's answer back, "not a
  // member before", and shared B too.
  test('each computer\'s accept is its own attempt, so a stale one on another computer shares nothing', () async {
    // The server as store.ts keeps it: an answer per operation, replayed; an
    // invitation accepted once is gone.
    final receipts = <String, Map<String, dynamic>>{};
    var pending = true, loseNextReply = false;
    Future<Map<String, dynamic>> server(String operationId) async {
      if (receipts[operationId] case final receipt?) return receipt;
      if (!pending) {
        throw const SuperTabFailure(
          'NOT_FOUND',
          'This invitation is unavailable.',
          statusCode: 404,
        );
      }
      pending = false;
      final answer = {
        'result': {
          'conversationId': 'lead',
          'alreadyMember': false,
          'role': 'collaborator',
        },
      };
      receipts[operationId] = answer;
      if (loseNextReply) {
        loseNextReply = false;
        throw const SuperTabFailure('NETWORK', 'lost reply');
      }
      return answer;
    }

    final a = SwarmInviteAccepts(), b = SwarmInviteAccepts();
    // A's reply is lost; its retry is the same attempt and gets its answer.
    loseNextReply = true;
    await expectLater(a.accept('i1', server), throwsA(isA<SuperTabFailure>()));
    final accepted = await a.accept('i1', server);
    expect(swarmNewMemberRole(superTabMap(accepted['result'])), 'collaborator');
    // B still shows the invitation and accepts it: refused, nothing to add.
    await expectLater(
      b.accept('i1', server),
      throwsA(
        isA<SuperTabFailure>().having((f) => f.code, 'code', 'NOT_FOUND'),
      ),
    );
    expect(receipts, hasLength(1));
  });
}
