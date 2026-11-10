import 'dart:async';

import 'controller.dart';

/// Accepting a Swarm invitation from this computer. Each attempt has its own
/// operation, kept only for that attempt's retries (a lost reply is asked
/// again under it) and dropped once answered: the server replays an
/// operation's answer to whoever sends it again, so one fixed operation for
/// an invitation gave a stale accept on another computer the first one's
/// answer, "not a member before", and shared that computer too (re-check of
/// #2188).
class SwarmInviteAccepts {
  final _attempts = <String, String>{};

  /// Sends [inviteId]'s accept through [send], with this attempt's operation.
  Future<Map<String, dynamic>> accept(
    String inviteId,
    Future<Map<String, dynamic>> Function(String operationId) send,
  ) async {
    final operationId = _attempts[inviteId] ??= superTabOperationId();
    final reply = await send(operationId);
    _attempts.remove(inviteId);
    return reply;
  }
}
