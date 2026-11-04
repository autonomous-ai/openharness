import 'dart:async';
import 'dart:convert' show utf8;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/e2ee/primitives.dart' show sha256;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_buddy.dart' show swarmBuddyMachineName, swarmCanWrite;
import 'swarm_new_project_sheet.dart'
    show swarmLeadEngineLabel, swarmLeadEngines;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_style.dart';

// Switch PM (Desktop's switch_pm.dart, spec
// 2026-11-02-pm-switch-engine-account-design.md): move a project's Product
// Manager to another engine or account on the machine it runs on. The
// machine's host does the switch; the phone sends `lead.switch` and shows a
// refusal, as Desktop does. Desktop's dialog also moves it to another
// machine and picks its model; the phone does not yet.

/// A machine reading this old is offline (Desktop's
/// `kSuperTabMachineOfflineAfter`).
const _offlineAfter = Duration(seconds: 35);

/// "18:05" when [at] is today, else the date and time ("4 Nov 2026, 18:05"),
/// in local time (Desktop's `switchPmTime`, in the phone's clock).
String swarmSwitchPmTime(DateTime at) {
  final local = at.toLocal(), today = DateTime.now();
  if (local.year == today.year &&
      local.month == today.month &&
      local.day == today.day) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(local.hour)}:${two(local.minute)}';
  }
  return fullDateTime(at);
}

/// One account of a machine as its report lists it (backend
/// `observation.profiles`, Desktop's `SuperTabProfile`): opaque id, a label
/// with no path or email, and what is left of its allowance when known.
typedef SuperTabProfile = ({
  String engine,
  String id,
  String label,
  int? leftPercent,
  DateTime? resetsAt,
});

/// The accounts [pool] reports; empty from a machine that reports none
/// (Desktop's `superTabProfilesOf`).
List<SuperTabProfile> superTabProfilesOf(Map<String, dynamic>? pool) {
  final observation = pool?['observation'];
  final rows = observation is Map ? observation['profiles'] : null;
  return [
    for (final p in rows is List ? rows : const [])
      if (p is Map &&
          p['engine'] is String &&
          p['id'] is String &&
          p['label'] is String)
        (
          engine: p['engine'] as String,
          id: p['id'] as String,
          label: p['label'] as String,
          leftPercent: (p['leftPercent'] as num?)?.toInt(),
          resetsAt: DateTime.tryParse(p['resetsAt'] as String? ?? ''),
        ),
  ];
}

/// A Swarm profile (an engine account of a machine), as the CLI, the backend
/// and Desktop name it: the first 16 hex characters of
/// sha256(`<machineId>:<engine>:<realpath>`), or `...:default` for the
/// engine's default account (Desktop's `swarmProfileId`).
String swarmProfileId(String machineId, String engine, String pathOrDefault) {
  final digest = sha256(utf8.encode('$machineId:$engine:$pathOrDefault'));
  return [for (final byte in digest) byte.toRadixString(16).padLeft(2, '0')]
      .join()
      .substring(0, 16);
}

/// [projectId]'s Product Manager, while it has one (Desktop's `leadOf`).
SuperTabAgent? swarmLeadOf(SuperTabSnapshot? snapshot, String projectId) {
  if (snapshot == null) return null;
  final chat = snapshot.projectById(projectId)?.leadConversationId;
  final id = chat == null ? null : snapshot.conversation(chat)?.leadId;
  return id == null ? null : snapshot.agent(id);
}

/// Whether [accountId] may switch [projectId]'s Product Manager: the
/// project's owner, or the owner of the machine it runs on, never a lent
/// machine's borrower (Desktop's `maySwitchLead`; the backend decides again).
bool swarmMaySwitchLead(
  SuperTabSnapshot? snapshot,
  String projectId,
  String? accountId,
) {
  final lead = swarmLeadOf(snapshot, projectId);
  return lead != null &&
      accountId != null &&
      (snapshot!.projectById(projectId)?.ownerId == accountId ||
          lead.machineOwnerId == accountId);
}

/// Whether [reader]'s person is offered Switch PM… for [projectId] now, as
/// Desktop offers it: one who may write and may switch it, while no switch
/// of it is under way.
bool swarmCanSwitchPm(SwarmReader reader, String projectId) =>
    !reader.accessRevoked &&
    swarmCanWrite(reader) &&
    swarmMaySwitchLead(reader.snapshot, projectId, reader.accountId) &&
    swarmLeadOf(reader.snapshot, projectId)?.switchRequest == null;

/// The project whose Product Manager the usage-limit note [message] offers
/// Switch PM… for: while that PM's machine still alerts about the limit (as a
/// prompt note stops saying anything once answered) and [swarmCanSwitchPm].
/// Null for every other note (Desktop's `SuperTabTerminalRow._canSwitch`).
String? swarmLimitNoteSwitchPm(SwarmReader reader, SuperTabMessage message) {
  final id = message.leadLimitAgentId, snapshot = reader.snapshot;
  if (id == null || snapshot == null) return null;
  final lead = snapshot.agent(id), project = snapshot.leadProjectForAgent(id);
  if (lead == null || project == null || !lead.alerting.contains('limit')) {
    return null;
  }
  return swarmCanSwitchPm(reader, project.id) ? project.id : null;
}

/// Why [projectId]'s Product Manager cannot be switched now, as Desktop's
/// dialog says it before Switch is pressed: no fresh reading from its
/// machine, or a Harness there too old to switch one (backend
/// `MACHINE_OFFLINE`, `HOST_OUTDATED`). Null when it can, and without a PM.
String? swarmSwitchPmRefusal(
  SwarmReader reader,
  String projectId, {
  DateTime? now,
}) {
  final lead = swarmLeadOf(reader.snapshot, projectId);
  if (lead == null) return null;
  final pool = reader.snapshot!.pool(lead.machineId);
  final observation = pool?['observation'];
  final at = observation is Map ? observation['receivedAt'] : null;
  if (at is! num ||
      (now ?? DateTime.now()).difference(
            DateTime.fromMillisecondsSinceEpoch(at.toInt()),
          ) >=
          _offlineAfter) {
    return 'Wait for a fresh reading from the PM’s machine.';
  }
  final capabilities = (observation as Map)['capabilities'];
  if (capabilities is List && capabilities.contains('leadSwitch')) {
    return null;
  }
  final name = switch (pool?['name']) {
    final String named when named.isNotEmpty => swarmBuddyMachineName(
      reader,
      lead.machineId,
    ),
    _ => 'the PM’s machine',
  };
  return 'Update Harness on $name to switch this Product Manager.';
}

/// One account Switch PM lists, and whether the PM runs in it now.
typedef SwarmSwitchPmChoice = ({SuperTabProfile profile, bool current});

/// The accounts Switch PM lists for [projectId]'s Product Manager, as
/// Desktop's dialog does: the accounts its machine reports, or, from a
/// machine that reports none, each offered engine's default account; in the
/// engines' order, the one it runs in marked.
List<SwarmSwitchPmChoice> swarmSwitchPmChoices(
  SuperTabSnapshot snapshot,
  String projectId,
) {
  final lead = swarmLeadOf(snapshot, projectId);
  if (lead == null) return const [];
  final pool = snapshot.pool(lead.machineId);
  var profiles = superTabProfilesOf(pool);
  final reported = profiles.isNotEmpty;
  if (!reported) {
    final offered = (pool?['engines'] as List?)?.whereType<String>();
    profiles = [
      for (final engine in swarmLeadEngines)
        if (offered?.contains(engine) ?? engine == lead.engine)
          (
            engine: engine,
            id: 'default',
            label: 'Default',
            leftPercent: null,
            resetsAt: null,
          ),
    ];
  }
  // By engine, each engine's accounts in the order the machine lists them.
  final ordered = [...profiles.indexed]
    ..sort((a, b) {
      final engine = swarmLeadEngines
          .indexOf(a.$2.engine)
          .compareTo(swarmLeadEngines.indexOf(b.$2.engine));
      return engine != 0 ? engine : a.$1.compareTo(b.$1);
    });
  // A PM that reports no account (or the literal default) runs its engine's
  // default one.
  final stored = lead.profileId;
  final currentId = stored != null && stored != 'default'
      ? stored
      : reported
      ? swarmProfileId(lead.machineId, lead.engine, 'default')
      : 'default';
  return [
    for (final (_, p) in ordered)
      (profile: p, current: p.engine == lead.engine && p.id == currentId),
  ];
}

/// Whether [choice] may be picked: not the account the PM runs in, nor one
/// with nothing left.
bool swarmSwitchPmPickable(SwarmSwitchPmChoice choice) =>
    !choice.current && choice.profile.leftPercent != 0;

/// "Codex · Work", as Desktop's dialog names an account.
String swarmSwitchPmLabel(SuperTabProfile p) =>
    '${swarmLeadEngineLabel(p.engine)} · ${p.label}';

/// "Current · 40% left · resets 18:05", leaving out what is not known.
String swarmSwitchPmDetail(SwarmSwitchPmChoice choice) => [
  if (choice.current) 'Current',
  if (choice.profile.leftPercent case final left?) '$left% left',
  if (choice.profile.resetsAt case final at?) 'resets ${swarmSwitchPmTime(at)}',
].join(' · ');

/// Opens Switch PM for [projectId]'s Product Manager ([SwarmSwitchPmDialog]),
/// when [reader]'s person is still offered it ([swarmCanSwitchPm]).
Future<void> showSwarmSwitchPm(
  BuildContext context,
  SwarmReader reader,
  String projectId,
) async {
  if (!context.mounted || !swarmCanSwitchPm(reader, projectId)) return;
  await showDialog<void>(
    context: context,
    builder: (_) => SwarmSwitchPmDialog(reader: reader, projectId: projectId),
  );
}

const _notSent = 'Could not reach this Swarm. Try again.';

/// Switch PM, as Desktop's dialog: the accounts of the PM's machine to pick
/// one of, what a switch does, and Switch, which is the confirmation — it
/// stops the PM's session and starts another in the account picked. While
/// its machine cannot switch it ([swarmSwitchPmRefusal]), or no account can
/// be picked, it says so under the list and Switch waits. A refusal stays
/// under the list. It follows the machine's report while open,
/// and goes once the PM can no longer be switched from here: access lost, a
/// viewer now, another PM, or a switch asked for elsewhere.
class SwarmSwitchPmDialog extends StatefulWidget {
  const SwarmSwitchPmDialog({
    super.key,
    required this.reader,
    required this.projectId,
  });

  final SwarmReader reader;
  final String projectId;

  @override
  State<SwarmSwitchPmDialog> createState() => _SwarmSwitchPmDialogState();
}

class _SwarmSwitchPmDialogState extends State<SwarmSwitchPmDialog> {
  /// The PM it opened on: another one there meanwhile closes it.
  late final String? _pmId = swarmLeadOf(
    widget.reader.snapshot,
    widget.projectId,
  )?.id;

  ({String engine, String id})? _picked;
  bool _busy = false, _closed = false;
  String? _error;

  /// This ask's receipt: kept while its answer may have been lost on the
  /// way, so trying again is the same command; a new one once the server
  /// refused it.
  String _operationId = superTabOperationId();

  bool get _holds =>
      _pmId != null &&
      swarmCanSwitchPm(widget.reader, widget.projectId) &&
      swarmLeadOf(widget.reader.snapshot, widget.projectId)?.id == _pmId;

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_moved);
  }

  @override
  void dispose() {
    widget.reader.removeListener(_moved);
    super.dispose();
  }

  void _moved() {
    if (!mounted || _closed) return;
    // While its own ask is out, its answer decides.
    if (_busy || _holds) {
      setState(() {});
      return;
    }
    _close();
  }

  /// Goes once this frame is done: not while the reader tells its listeners.
  void _close() {
    if (_closed) return;
    _closed = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route != null && route.isActive) route.navigator?.removeRoute(route);
    });
  }

  Future<void> _switch(({String engine, String id}) picked) async {
    if (_busy || _closed) return;
    final reader = widget.reader;
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {
          'operationId': _operationId,
          'command': {
            'type': 'lead.switch',
            'projectId': widget.projectId,
            'engine': picked.engine,
            'profileId': picked.id,
          },
        },
      );
    } on SuperTabFailure catch (failure) {
      error = failure.message;
      if (failure.statusCode >= 400 && failure.statusCode < 500) {
        _operationId = superTabOperationId();
      }
    } catch (_) {
      // A call lost on the way (a timeout, a socket dropped) is no answer.
      error = _notSent;
    }
    // Switching… once the Swarm is read again.
    if (error == null) unawaited(reader.refresh());
    if (!mounted || _closed) return;
    if (error == null) {
      _closed = true;
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
    if (!_holds) _close();
  }

  Widget _row(SwarmSwitchPmChoice choice, bool picked) {
    final p = choice.profile;
    final pickable = swarmSwitchPmPickable(choice);
    final detail = swarmSwitchPmDetail(choice);
    return Semantics(
      selected: picked,
      child: InkWell(
        key: ValueKey('swarm-switch-pm-${p.engine}-${p.id}'),
        borderRadius: BorderRadius.circular(AppControl.radius),
        onTap: pickable && !_busy
            ? () => setState(() {
                _picked = (engine: p.engine, id: p.id);
                _error = null;
              })
            : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minTouchTarget),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpace.xs),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        swarmSwitchPmLabel(p),
                        style: AppType.body(
                          color: pickable
                              ? AppPalette.textPrimary
                              : AppPalette.textFaint,
                        ),
                      ),
                      if (detail.isNotEmpty)
                        Text(
                          detail,
                          style: AppType.caption(
                            color: AppPalette.textSecondary,
                          ),
                        ),
                    ],
                  ),
                ),
                if (picked)
                  Padding(
                    padding: const EdgeInsets.only(left: AppSpace.s),
                    child: Icon(
                      LucideIcons.check300,
                      size: 18,
                      color: AppPalette.accentOnSurface,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final reader = widget.reader;
    final snapshot = reader.snapshot;
    final lead = swarmLeadOf(snapshot, widget.projectId);
    final choices = snapshot == null
        ? const <SwarmSwitchPmChoice>[]
        : swarmSwitchPmChoices(snapshot, widget.projectId);
    bool isPicked(SuperTabProfile p) =>
        _picked?.engine == p.engine && _picked?.id == p.id;
    // A pick that can no longer be made (it ran out meanwhile) is none.
    final picked =
        choices.any((c) => swarmSwitchPmPickable(c) && isPicked(c.profile))
        ? _picked
        : null;
    final refusal = swarmSwitchPmRefusal(reader, widget.projectId);
    final note =
        refusal ??
        (choices.any(swarmSwitchPmPickable)
            ? null
            : 'No engine or account can run a Product Manager right now.');
    return PopScope(
      // Its ask out, its answer decides whether it goes.
      canPop: !_busy,
      child: AlertDialog(
        title: Text(
          'Switch PM',
          style: AppType.heading(color: AppPalette.textPrimary),
        ),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final choice in choices)
                  _row(choice, picked != null && isPicked(choice.profile)),
                if (note != null)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpace.s),
                    child: Text(
                      note,
                      key: const ValueKey('swarm-switch-pm-no-choice'),
                      style: AppType.caption(color: AppPalette.textSecondary),
                    ),
                  ),
                if (lead != null && lead.machineOwnerId != reader.accountId)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpace.s),
                    child: Text(
                      'Only accounts its owner offered are listed.',
                      style: AppType.caption(color: AppPalette.textSecondary),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.only(top: AppSpace.m),
                  child: Text(
                    'The new session starts fresh and reads a handoff note. '
                    'Tasks and chat stay.',
                    style: AppType.body(color: AppPalette.textSecondary),
                  ),
                ),
                if (_error case final error?)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpace.s),
                    child: Text(
                      error,
                      key: const ValueKey('swarm-switch-pm-error'),
                      style: AppType.caption(color: AppColors.danger),
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          SwarmButton(
            key: const ValueKey('swarm-switch-pm-cancel'),
            label: 'Cancel',
            style: SwarmButtonStyle.link,
            onPressed: _busy
                ? null
                : () {
                    _closed = true;
                    Navigator.of(context).pop();
                  },
          ),
          SwarmButton(
            key: const ValueKey('swarm-switch-pm-confirm'),
            label: 'Switch',
            style: SwarmButtonStyle.fill,
            busy: _busy,
            busyLabel: 'Switching…',
            onPressed: _busy || picked == null || refusal != null
                ? null
                : () => unawaited(_switch(picked)),
          ),
        ],
      ),
    );
  }
}
