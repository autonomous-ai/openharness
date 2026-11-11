import 'dart:async';

import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_link.dart';

import 'super_tab_fixture.dart';

/// The join link's bearer token, and the one Reset link turns it into.
const swarmSharingToken = '1234567890123456789012345678901234567890123';
const swarmSharingSecondToken = 'abcdefghijabcdefghijabcdefghijabcdefghijabc';

/// A Swarm's sharing as the backend answers it (backend sharing.ts): its access, its revision and the receipts of its
/// saves, and an email invitation added to the Swarm's invitations.
class SwarmSharingServer extends ConversationServer {
  Map<String, dynamic> access = {'mode': 'invited', 'role': 'collaborator'};
  int sharingRevision = 0, sharingReads = 0;
  String token = swarmSharingToken;
  bool loseSharingReply = false, stale = false, failSharingRead = false;
  Completer<void>? hold;
  final sharingPosts = <Map<String, dynamic>>[];
  final sharingReceipts = <String, Map<String, dynamic>>{};

  Map<String, dynamic> get settings => {
    'revision': sharingRevision,
    'access': Map<String, dynamic>.from(access),
    'joinUrl': access['mode'] == 'invited'
        ? null
        : SwarmJoinLink(
            'tab',
            token: access['mode'] == 'link' ? token : null,
          ).url,
  };

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (path.endsWith('/sharing')) {
      await hold?.future;
      if (method == 'GET') {
        sharingReads++;
        if (failSharingRead) {
          throw const SuperTabFailure(
            'NOT_FOUND',
            'Not found',
            statusCode: 404,
          );
        }
        return settings;
      }
      sharingPosts.add(Map<String, dynamic>.from(body!));
      final operation = body['operationId'] as String;
      if (sharingReceipts[operation] case final receipt?) return receipt;
      if (stale) {
        throw const SuperTabFailure(
          'REVISION_CHANGED',
          'Sharing changed',
          statusCode: 409,
        );
      }
      access = Map<String, dynamic>.from(body['access'] as Map);
      if (body['rotateLink'] == true) token = swarmSharingSecondToken;
      sharingRevision++;
      final result = settings;
      sharingReceipts[operation] = result;
      if (loseSharingReply) throw TimeoutException('lost reply');
      return result;
    }
    final command = body?['command'] as Map?;
    if (command?['type'] == 'invite.create') {
      (state['invitations'] as List).add({
        'id': 'invitation',
        'email': command!['email'],
        'role': command['role'],
      });
    }
    return super.request(method, path, body: body);
  }
}
