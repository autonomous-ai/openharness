import 'dart:async';

import '../core/machine_resources.dart';
import 'controller.dart';

/// What one more agent needs to start, the CLI's own figure
/// (`START_REQUIREMENTS.memoryBytes`, `cli/src/superTabs/capacity.ts`).
const _agentMemoryBytes = 2 * 1024 * 1024 * 1024;

/// Add machine's starting number of agents: half the machine's memory in
/// agents, from 1 to 16. Null while its memory is unknown.
int? superTabSuggestedAgentSlots(MachineResources? resources) {
  final total = resources?.memoryTotalBytes;
  if (total == null) return null;
  return (total / (2 * _agentMemoryBytes)).floor().clamp(1, 16);
}

/// Whether [stored], on a machine row saved without its Agents setting, is
/// the number joining suggested, which the server reads as As memory allows
/// (backend superTabs/machines.ts agentLimit; Dee, 2026-11-04): 16, or the
/// suggestion its measured memory gave (from 4 GiB, below which it was a
/// floor of 1 rather than a figure from memory).
bool superTabOldJoinSuggestion(int stored, MachineResources? resources) {
  if (stored == 16) return true;
  final total = resources?.memoryTotalBytes;
  return total != null &&
      total >= 2 * _agentMemoryBytes &&
      stored == superTabSuggestedAgentSlots(resources);
}

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
