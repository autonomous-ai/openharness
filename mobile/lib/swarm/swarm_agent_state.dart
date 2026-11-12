import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';

import 'model.dart';
import 'swarm_agents.dart';
import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_team.dart' show swarmAgentIsPm;

/// What [agent] is doing, in a word or two, as Desktop's Your Team row says
/// it (`agent_state.dart` `rowOf`, Swarm plan step 1: "What Harness knows is
/// a state anyone can see"), the first of:
/// - `offline`: its machine reports its session gone (`downSince`);
/// - `needs you`, to its person, `waiting on its person` to anyone else: a
///   question on its screen ([activity]), or its machine alerting a prompt;
/// - `paused` by its person, its machine's owner or the Swarm's owner;
/// - `limited until 15:40`: out of quota until then, as its machine saw;
/// - `working`: a turn runs ([activity]).
///
/// Desktop also says `starting`, `on #12`, `waiting on a build` and `free`,
/// from its own daemon, the project's board on GitHub and the channel's
/// posts; the phone reads none of them, and an agent it knows nothing of
/// says nothing. [me] is the reader; [now] decides whether a limit still
/// holds.
String? swarmAgentState(
  SuperTabAgent agent, {
  SwarmHarnessActivity? activity,
  required String me,
  DateTime? now,
}) {
  if (agent.downSince != null) return 'offline';
  if (activity == SwarmHarnessActivity.needsInput ||
      agent.alerting.contains('prompt')) {
    return agent.contributorId == me ? 'needs you' : 'waiting on its person';
  }
  // Paused: no new work for it; a question on its screen still comes first
  // (Desktop's, code review of #4112).
  if (agent.paused) return 'paused';
  if (agent.limitedUntil?.toLocal() case final until?
      when until.isAfter(now ?? DateTime.now())) {
    String two(int n) => n.toString().padLeft(2, '0');
    return 'limited until ${two(until.hour)}:${two(until.minute)}';
  }
  if (activity == SwarmHarnessActivity.working) return 'working';
  return null;
}

/// [agent]'s state ([swarmAgentState]) with what the person's own computers
/// say of it ([agents]), for [reader].
String? swarmAgentStateIn(
  SwarmReader reader,
  SuperTabAgent agent,
  SwarmAgents? agents,
) => swarmAgentState(
  agent,
  activity: agents?.activityOf(agent.machineId, agent.harnessId),
  me: reader.accountId,
);

/// Whether the reader may pause [agent] or resume it from its row, as
/// Desktop's right-click offers it (`project_sidebar.dart` `_agentRow`):
/// someone who may write, and its person, its machine's owner or the Swarm's
/// owner (backend `agent.pause`); never a project's Product Manager, which
/// gives the work. Gone once the Swarm can no longer be read, or the agent
/// is gone.
bool swarmMayPauseAgent(SwarmReader reader, String agentId) {
  final snapshot = reader.snapshot;
  final agent = snapshot?.agent(agentId);
  if (reader.accessRevoked ||
      snapshot == null ||
      agent == null ||
      !swarmCanWrite(reader) ||
      swarmAgentIsPm(snapshot, agent)) {
    return false;
  }
  final me = reader.accountId;
  return agent.contributorId == me ||
      agent.machineOwnerId == me ||
      snapshot.ownerId == me;
}

/// Pauses agent [agentId], or resumes it (backend `agent.pause`, Desktop's
/// `pauseAgent`): Harness gives a paused agent no task and types it nothing,
/// and its session runs on. Null once the server took it and the Swarm is
/// read again, else the sentence to show.
Future<String?> swarmPauseAgent(
  SwarmReader reader,
  String agentId, {
  required bool paused,
}) async {
  try {
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {
        'operationId': superTabOperationId(),
        'command': {
          'type': 'agent.pause',
          'agentId': agentId,
          'paused': paused,
        },
      },
    );
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    // A call lost on the way (a timeout, a socket dropped) is no answer.
    return 'Could not reach this Swarm. Try again.';
  }
  await reader.refresh();
  return null;
}

/// [agent]'s menu, from a long press on its row: Pause, or Resume once it is
/// paused, as Desktop's row has them one right-click away and nowhere else
/// (anh Dee, 2026-11-11: "make it subtle. right click you see pause").
/// Nothing when the reader may not ([swarmMayPauseAgent]); the sheet goes
/// once they no longer may. A refusal says why at the foot of the screen.
Future<void> showSwarmAgentMenu(
  BuildContext context,
  SwarmReader reader,
  String agentId,
) async {
  if (!swarmMayPauseAgent(reader, agentId)) return;
  final snapshot = reader.snapshot!;
  final agent = snapshot.agent(agentId)!;
  Route<void>? sheet;
  void moved() {
    final route = sheet;
    if (route == null || swarmMayPauseAgent(reader, agentId)) return;
    sheet = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (route.isActive) route.navigator?.removeRoute(route);
    });
  }

  final messenger = ScaffoldMessenger.maybeOf(context);
  reader.addListener(moved);
  try {
    await showPhoneSheet(
      context,
      title: snapshot.agentName(agentId, fallback: agent.name),
      onShown: (route) => sheet = route,
      rebuildOn: reader,
      rows: () {
        final paused = reader.snapshot?.agent(agentId)?.paused ?? false;
        return (
          actions: [
            PhoneSheetAction(
              icon: paused ? LucideIcons.play300 : LucideIcons.pause300,
              label: paused ? 'Resume' : 'Pause',
              onTap: () => unawaited(() async {
                final error = await swarmPauseAgent(
                  reader,
                  agentId,
                  paused: !paused,
                );
                if (error == null ||
                    reader.accessRevoked ||
                    messenger == null ||
                    !messenger.mounted) {
                  return;
                }
                messenger.showSnackBar(
                  SnackBar(
                    key: const ValueKey('swarm-agent-pause-failed'),
                    content: Text(error),
                  ),
                );
              }()),
            ),
          ],
          sections: const <PhoneSheetSection>[],
        );
      },
    );
  } finally {
    reader.removeListener(moved);
  }
}
