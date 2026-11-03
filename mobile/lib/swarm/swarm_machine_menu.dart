import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';

import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_machines.dart' show showSwarmMachine;
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// What the reader may do to machine [machineId] of a Swarm, as the desktop's machine menu and Details offer it
/// (`desktop/lib/super_tabs/machines.dart` `_canRemove`, `contributor == accountId`): only the person who lent a
/// machine pauses or resumes its new work, and only they, and only where they may write, remove it. The server
/// enforces both again (`machine.pause` OWNER_REQUIRED, `machine.remove` FORBIDDEN), so this only decides what to show.
///
/// Null once the Swarm can no longer be read, or the machine is gone from it: nothing to offer, and an open menu
/// closes. [pause] and [remove] are false for anyone else, and while the machine is being removed.
typedef SwarmMachineRights = ({
  bool pause,
  bool paused,
  bool remove,
  String? removeReason,
});

SwarmMachineRights? swarmMachineRights(SwarmReader reader, String machineId) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked || snapshot == null) return null;
  final pool = snapshot.pool(machineId);
  final onIt = snapshot.agents.where(
    (a) => snapshot.placeOf(a.machineId) == machineId,
  );
  if (pool == null && onIt.isEmpty) return null;
  final removal = pool?['removal'];
  final removing = removal is Map && removal['state'] == 'cleaning';
  final lent = pool != null && pool['contributorId'] == reader.accountId;
  String? reason;
  for (final agent in onIt) {
    reason ??= snapshot.leadProtectionReason(agent.id);
  }
  return (
    pause: lent && removal == null,
    paused: pool?['paused'] == true,
    remove: lent && swarmCanWrite(reader) && !removing,
    removeReason: reason,
  );
}

const _notReached = 'Could not reach this Swarm. Try again.';

/// Pauses or resumes new work on [machineId]; null once the server kept it and the Swarm is read again, else the
/// sentence to show.
Future<String?> swarmPauseMachine(
  SwarmReader reader,
  String machineId, {
  required bool paused,
}) async {
  if (swarmMachineRights(reader, machineId)?.pause != true) {
    return 'You can’t change this machine.';
  }
  return _send(reader, {
    'type': 'machine.pause',
    'machineId': machineId,
    'paused': paused,
  });
}

Future<String?> _send(SwarmReader reader, Map<String, dynamic> command) async {
  try {
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {'operationId': superTabOperationId(), 'command': command},
    );
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    // A call lost on the way (a timeout, a socket dropped) is no answer.
    return _notReached;
  }
  await reader.refresh();
  return null;
}

/// Says [error] at the foot of the screen, unless the screen is gone or the Swarm can no longer be read.
void _tell(
  ScaffoldMessengerState? messenger,
  SwarmReader reader,
  String? error,
) {
  if (error == null ||
      messenger == null ||
      !messenger.mounted ||
      reader.accessRevoked) {
    return;
  }
  messenger.showSnackBar(
    SnackBar(key: const ValueKey('swarm-machine-failed'), content: Text(error)),
  );
}

/// The long-press menu of a machine row: Details, then Pause or Resume new work and Remove from Swarm for whoever may.
/// The rows follow the Swarm as it is read; the sheet closes itself once the machine, or the reader's access, is gone.
Future<void> showSwarmMachineMenu(
  BuildContext context,
  SwarmReader reader,
  String machineId, {
  required String name,
}) {
  PhoneSheetRows rows() {
    final rights = swarmMachineRights(reader, machineId);
    return (
      actions: [
        if (rights != null) ...[
          PhoneSheetAction(
            icon: LucideIcons.info300,
            label: 'Details',
            onTap: () =>
                unawaited(showSwarmMachine(context, reader, machineId)),
          ),
          if (rights.pause)
            PhoneSheetAction(
              icon: rights.paused ? LucideIcons.play300 : LucideIcons.pause300,
              label: rights.paused ? 'Resume new work' : 'Pause new work',
              onTap: () => unawaited(
                _pause(context, reader, machineId, paused: !rights.paused),
              ),
            ),
          if (rights.remove)
            PhoneSheetAction(
              icon: LucideIcons.trash2300,
              label: 'Remove from Swarm',
              destructive: true,
              enabled: rights.removeReason == null,
              // The whole sentence is the desktop's line under the row; a sheet row has room for a few words.
              value: rights.removeReason == null
                  ? null
                  : 'Has a Product Manager',
              onTap: () =>
                  unawaited(removeSwarmMachine(context, reader, machineId)),
            ),
        ],
      ],
      sections: const [],
    );
  }

  void closeWhenGone(Route<void> route) {
    void check() {
      if (swarmMachineRights(reader, machineId) != null) return;
      reader.removeListener(check);
      if (route.isActive) route.navigator?.removeRoute(route);
    }

    reader.addListener(check);
    unawaited(
      (route is TransitionRoute<void> ? route.completed : route.popped)
          .whenComplete(() => reader.removeListener(check)),
    );
  }

  return showPhoneSheet(
    context,
    title: name,
    rows: rows,
    rebuildOn: reader,
    onShown: closeWhenGone,
  );
}

Future<void> _pause(
  BuildContext context,
  SwarmReader reader,
  String machineId, {
  required bool paused,
}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final error = await swarmPauseMachine(reader, machineId, paused: paused);
  _tell(messenger, reader, error);
}

/// What taking [machineId] out of the Swarm would do, as the server counts it (`GET …/machines/ID/removal`, the one
/// the desktop's Remove question reads): the agents that stop, the projects whose code is only there, and the Product
/// Manager that blocks it.
class _Preview {
  const _Preview(
    this.agents,
    this.soleSourceProjects,
    this.blockedProject,
    this.blockedReason,
    this.hiddenAgentCount,
    this.hiddenSoleSourceProjectCount,
  );

  final List<({String name, String project, String? task})> agents;
  final List<String> soleSourceProjects;
  final String? blockedProject;
  final String? blockedReason;
  final int hiddenAgentCount;
  final int hiddenSoleSourceProjectCount;

  static _Preview parse(Object? raw) {
    if (raw is! Map ||
        raw['previewVersion'] != 2 ||
        raw['agents'] is! List ||
        raw['soleSourceProjects'] is! List) {
      throw const FormatException('Invalid machine removal preview');
    }
    String text(Object? value) {
      if (value is String && value.isNotEmpty) return value;
      throw const FormatException('Invalid machine removal preview');
    }

    final blocked = raw['blockedBy'];
    if (blocked != null && blocked is! Map) {
      throw const FormatException('Invalid machine removal preview');
    }
    final blockedMap = blocked as Map?;
    final blockedProject = blockedMap?['projectName'];
    final blockedReason = blockedMap?['reason'];
    if (blocked != null &&
        !((blockedProject is String && blockedProject.isNotEmpty) ||
            (blockedReason is String && blockedReason.isNotEmpty))) {
      throw const FormatException('Invalid machine removal preview');
    }
    if ((blockedProject != null && blockedProject is! String) ||
        (blockedReason != null && blockedReason is! String)) {
      throw const FormatException('Invalid machine removal preview');
    }
    final hiddenAgentCount = raw['hiddenAgentCount'] ?? 0;
    final hiddenSoleSourceProjectCount =
        raw['hiddenSoleSourceProjectCount'] ?? 0;
    if (hiddenAgentCount is! int ||
        hiddenAgentCount < 0 ||
        hiddenSoleSourceProjectCount is! int ||
        hiddenSoleSourceProjectCount < 0) {
      throw const FormatException('Invalid machine removal preview');
    }
    return _Preview(
      [
        for (final item in raw['agents'] as List)
          if (item is Map)
            (
              name: text(item['name']),
              // A Swarm-wide Buddy has no project: the server sends an empty name, and the agent is listed by its name alone.
              project: item['projectName'] is String
                  ? item['projectName'] as String
                  : throw const FormatException(
                      'Invalid machine removal preview',
                    ),
              task: item['task'] is String ? item['task'] as String : null,
            )
          else
            throw const FormatException('Invalid machine removal preview'),
      ],
      [
        for (final item in raw['soleSourceProjects'] as List)
          if (item is Map)
            text(item['name'])
          else
            throw const FormatException('Invalid machine removal preview'),
      ],
      blockedProject as String?,
      blockedReason as String?,
      hiddenAgentCount,
      hiddenSoleSourceProjectCount,
    );
  }
}

/// Most names the question lists before "and N more": the dialog does not scroll.
const _listed = 5;

String _warning(_Preview preview) {
  final lines = <String>['The Swarm stops using this machine for new work.'];
  if (preview.agents.isNotEmpty) {
    lines.add('\nThese agents will stop:');
    for (final agent in preview.agents.take(_listed)) {
      lines.add(
        '${agent.name}${agent.project.isEmpty ? '' : ' · ${agent.project}'}'
        '${agent.task == null ? '' : '\nThe open task “${agent.task}” loses its agent.'}',
      );
    }
    if (preview.agents.length > _listed) {
      lines.add('and ${preview.agents.length - _listed} more');
    }
  }
  if (preview.hiddenAgentCount > 0) {
    lines.add(
      preview.hiddenAgentCount == 1
          ? "1 agent of a project you can't see will stop."
          : "${preview.hiddenAgentCount} agents of projects you can't see will stop.",
    );
  }
  if (preview.soleSourceProjects.isNotEmpty) {
    lines.add('\nThese projects have code only on this machine:');
    lines.addAll(preview.soleSourceProjects.take(_listed));
    if (preview.soleSourceProjects.length > _listed) {
      lines.add('and ${preview.soleSourceProjects.length - _listed} more');
    }
  }
  if (preview.hiddenSoleSourceProjectCount > 0) {
    lines.add(
      preview.hiddenSoleSourceProjectCount == 1
          ? "1 project you can't see has code only on this machine."
          : "${preview.hiddenSoleSourceProjectCount} projects you can't see have code only on this machine.",
    );
  }
  lines.add(
    '\nThe Swarm folders on this machine will be deleted, including uncommitted or unpushed work.',
  );
  return lines.join('\n');
}

/// Remove from Swarm: reads what it would do, asks with that, and sends `machine.remove`. Nothing is shown or sent for
/// someone who may not, a machine that changed meanwhile, or a Swarm the reader lost access to while it was asking.
Future<void> removeSwarmMachine(
  BuildContext context,
  SwarmReader reader,
  String machineId,
) async {
  bool allowed() {
    final rights = swarmMachineRights(reader, machineId);
    return rights != null && rights.remove && rights.removeReason == null;
  }

  if (!allowed()) return;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final generation = reader.generation;
  final name =
      reader.snapshot?.pool(machineId)?['name'] as String? ?? 'this machine';
  final _Preview preview;
  try {
    preview = _Preview.parse(
      await reader.request(
        'GET',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/machines/${Uri.encodeComponent(machineId)}/removal/v2',
      ),
    );
  } on SuperTabFailure catch (failure) {
    _tell(messenger, reader, failure.message);
    return;
  } catch (_) {
    _tell(messenger, reader, 'Could not check this machine.');
    return;
  }
  // An answer asked for under an earlier read of the Swarm may carry what the reader can no longer see.
  if (!context.mounted || reader.generation != generation || !allowed()) return;
  if (preview.blockedProject case final project?) {
    _tell(
      messenger,
      reader,
      'This machine runs the Product Manager of project $project. Delete the project first.',
    );
    return;
  }
  if (preview.blockedReason case final reason?) {
    _tell(messenger, reader, reason);
    return;
  }
  final confirmed = await confirmPhoneAction(
    context,
    icon: LucideIcons.trash2300,
    title: 'Remove $name from this Swarm?',
    message: _warning(preview),
    confirmLabel: 'Remove from Swarm',
  );
  if (!confirmed ||
      !context.mounted ||
      reader.generation != generation ||
      !allowed()) {
    return;
  }
  _tell(
    messenger,
    reader,
    await _send(reader, {'type': 'machine.remove', 'machineId': machineId}),
  );
}

/// Details' Pause new work / Resume new work, for the person who lent the machine.
class SwarmMachinePauseButton extends StatefulWidget {
  const SwarmMachinePauseButton({
    super.key,
    required this.reader,
    required this.machineId,
  });
  final SwarmReader reader;
  final String machineId;

  @override
  State<SwarmMachinePauseButton> createState() =>
      _SwarmMachinePauseButtonState();
}

class _SwarmMachinePauseButtonState extends State<SwarmMachinePauseButton> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final rights = swarmMachineRights(widget.reader, widget.machineId);
    if (rights == null || !rights.pause) return const SizedBox.shrink();
    return TextButton(
      key: const ValueKey('swarm-machine-pause'),
      onPressed: _busy
          ? null
          : () async {
              final messenger = ScaffoldMessenger.maybeOf(context);
              setState(() => _busy = true);
              final error = await swarmPauseMachine(
                widget.reader,
                widget.machineId,
                paused: !rights.paused,
              );
              if (!mounted) return;
              setState(() => _busy = false);
              _tell(messenger, widget.reader, error);
            },
      child: Text(rights.paused ? 'Resume new work' : 'Pause new work'),
    );
  }
}
