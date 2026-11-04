import 'dart:async';
import 'dart:convert' show utf8;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/e2ee/primitives.dart' show sha256;
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
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
// refusal, as Desktop does. The project's owner may also move it to another
// machine of the Swarm, which starts it there; and any model of the Swarm's
// catalog may be asked for (backend commands.ts `lead.switch`).

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
  if (!_fresh(pool, now ?? DateTime.now())) {
    return 'Wait for a fresh reading from the PM’s machine.';
  }
  final capabilities = (pool!['observation'] as Map)['capabilities'];
  if (capabilities is List && capabilities.contains('leadSwitch')) {
    return null;
  }
  final name = _poolName(reader, pool, 'the PM’s machine');
  return 'Update Harness on $name to switch this Product Manager.';
}

/// Whether [pool]'s last reading is under [_offlineAfter] old at [now]
/// (Desktop's `fresh`).
bool _fresh(Map<String, dynamic>? pool, DateTime now) {
  final observation = pool?['observation'];
  final at = observation is Map ? observation['receivedAt'] : null;
  return at is num &&
      now.difference(DateTime.fromMillisecondsSinceEpoch(at.toInt())) <
          _offlineAfter;
}

/// [pool]'s name without its `.local`, or [fallback] for one with none.
String _poolName(
  SwarmReader reader,
  Map<String, dynamic> pool,
  String fallback,
) => switch ((pool['name'], pool['machineId'])) {
  (final String named, final String id) when named.isNotEmpty =>
    swarmBuddyMachineName(reader, id),
  _ => fallback,
};

/// One machine Switch PM lists in its Machine row: the one the PM runs on
/// ([current]), or another it could move to, with why it cannot now
/// ([unavailable]; null when it can).
typedef SwarmSwitchPmMachine = ({
  String id,
  String name,
  bool current,
  String? unavailable,
});

/// Why [projectId]'s Product Manager cannot move to machine [pool] now, as
/// Desktop's Machine row says it; null when it can, and for the machine it
/// runs on. Only the project's owner moves it (backend `lead.switch`, a new
/// start: `placeLead`), to a fresh machine whose Harness both starts and
/// switches one, that is theirs or takes this project's work, and that is
/// neither being removed nor paused.
String? swarmSwitchPmMachineRefusal(
  SwarmReader reader,
  String projectId,
  Map<String, dynamic> pool, {
  DateTime? now,
}) {
  final snapshot = reader.snapshot;
  final lead = swarmLeadOf(snapshot, projectId);
  if (pool['machineId'] == lead?.machineId) return null;
  final name = _poolName(reader, pool, 'Mac');
  if (snapshot?.projectById(projectId)?.ownerId != reader.accountId) {
    return 'Only the project’s owner moves its PM to another machine.';
  }
  if (!_fresh(pool, now ?? DateTime.now())) return '$name is offline.';
  final observation = pool['observation'];
  final capabilities = observation is Map ? observation['capabilities'] : null;
  if (capabilities is! List ||
      !capabilities.contains('leadSwitch') ||
      !capabilities.contains('leadStart')) {
    return 'Update Harness on $name to move a Product Manager there.';
  }
  final teamWork = pool['teamWork'];
  final mayUse =
      pool['contributorId'] == reader.accountId ||
      (teamWork is Map && teamWork['allowed'] == true);
  if (!mayUse) {
    return teamWork is Map && teamWork['reason'] is String
        ? teamWork['reason'] as String
        : 'This machine cannot take this project’s work.';
  }
  if (pool['removal'] != null || pool['paused'] == true) {
    return '$name is unavailable in this Swarm.';
  }
  return null;
}

/// The machines Switch PM's Machine row lists for [projectId]'s Product
/// Manager, in the Swarm's order, as Desktop's does: every machine of the
/// Swarm but a Harness Team account read on its Mac, unless the PM runs
/// there. The one it runs on is marked [SwarmSwitchPmMachine.current].
List<SwarmSwitchPmMachine> swarmSwitchPmMachines(
  SwarmReader reader,
  String projectId, {
  DateTime? now,
}) {
  final snapshot = reader.snapshot;
  final lead = swarmLeadOf(snapshot, projectId);
  if (snapshot == null || lead == null) return const [];
  return [
    for (final pool in snapshot.machines)
      if (pool['machineId'] case final String id
          when pool['hostMachineId'] == null || id == lead.machineId)
        (
          id: id,
          name: _poolName(reader, pool, 'Mac'),
          current: id == lead.machineId,
          unavailable: swarmSwitchPmMachineRefusal(
            reader,
            projectId,
            pool,
            now: now,
          ),
        ),
  ];
}

/// One account Switch PM lists, and whether the PM runs in it now.
typedef SwarmSwitchPmChoice = ({SuperTabProfile profile, bool current});

/// The accounts Switch PM lists for [projectId]'s Product Manager on
/// [machineId] (by default the machine it runs on), as Desktop's dialog
/// does: the accounts that machine reports, or, from a machine that reports
/// none, each engine it offers in its default account (the PM's own engine
/// on its own machine, when it says nothing of its engines); in the engines'
/// order, the one it runs in marked.
List<SwarmSwitchPmChoice> swarmSwitchPmChoices(
  SuperTabSnapshot snapshot,
  String projectId, {
  String? machineId,
}) {
  final lead = swarmLeadOf(snapshot, projectId);
  if (lead == null) return const [];
  final on = machineId ?? lead.machineId;
  final pool = snapshot.pool(on);
  var profiles = superTabProfilesOf(pool);
  final reported = profiles.isNotEmpty;
  if (!reported) {
    final offered = (pool?['engines'] as List?)?.whereType<String>();
    profiles = [
      for (final engine in swarmLeadEngines)
        if (offered?.contains(engine) ??
            (on == lead.machineId && engine == lead.engine))
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
      (
        profile: p,
        current:
            on == lead.machineId &&
            p.engine == lead.engine &&
            p.id == currentId,
      ),
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

/// One model of the Swarm's catalog (backend catalog.ts `CatalogModel`).
typedef SwarmSwitchPmModel = ({String engine, String model});

/// The models the tab's routing-policy read offers ([answer]'s
/// `catalog.models`), as Desktop's dialog keeps them: each row with an
/// engine and a model that is not marked `offered: false`. Empty from an
/// answer without a catalog.
List<SwarmSwitchPmModel> swarmSwitchPmCatalog(Object? answer) {
  final catalog = answer is Map ? answer['catalog'] : null;
  final rows = catalog is Map ? catalog['models'] : null;
  return [
    for (final row in rows is List ? rows : const [])
      if (row is Map &&
          row['engine'] is String &&
          row['model'] is String &&
          row['offered'] != false)
        (engine: row['engine'] as String, model: row['model'] as String),
  ];
}

/// The models Switch PM's Model row offers [engine] after Default, each
/// once, in the catalog's order (Desktop's `offeredModels`). The catalog's
/// own `default` row is Default itself (catalog.ts: it keeps the engine's
/// own model), so it is not listed twice.
List<String> swarmSwitchPmModels(
  List<SwarmSwitchPmModel> catalog,
  String engine,
) => {
  for (final row in catalog)
    if (row.engine == engine && row.model != 'default') row.model,
}.toList();

/// The `lead.switch` command Switch PM sends (backend commands.ts): the
/// engine and account picked, the machine only when it is not the one the
/// PM runs on, and the model only when one other than Default is picked.
Map<String, dynamic> swarmSwitchPmCommand({
  required String projectId,
  required ({String engine, String id}) picked,
  required String currentMachineId,
  required String machineId,
  String? model,
}) => {
  'type': 'lead.switch',
  'projectId': projectId,
  'engine': picked.engine,
  'profileId': picked.id,
  if (machineId != currentMachineId) 'machineId': machineId,
  'model': ?model,
};

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

/// Switch PM, as Desktop's dialog: the machine it runs on, or another to
/// move it to ([swarmSwitchPmMachines]); that machine's accounts to pick one
/// of; the model it starts on, Default or one of the Swarm's catalog (read
/// once as it opens: unread, Default alone); what a switch does; and
/// Switch, which is the confirmation — it stops the PM's session and starts
/// another in the account picked. Another machine forgets the account and
/// model picked, and another account the model. While its machine cannot
/// switch it ([swarmSwitchPmRefusal]), or no account can be picked, it says
/// so under the list and Switch waits. A refusal stays under the list. It
/// follows the Swarm while open, and goes once the PM can no longer be
/// switched from here: access lost, a viewer now, another PM, or a switch
/// asked for elsewhere.
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

  /// The machine whose accounts it lists: the PM's own until another is
  /// chosen.
  late String? _machineId = swarmLeadOf(
    widget.reader.snapshot,
    widget.projectId,
  )?.machineId;
  ({String engine, String id})? _picked;

  /// The model picked; null is Default.
  String? _model;
  List<SwarmSwitchPmModel> _catalog = const [];
  bool _busy = false, _closed = false;
  String? _error;

  /// This ask's receipt: kept while its answer may have been lost on the
  /// way, so trying again is the same command; a new one once the server
  /// refused it, or for another ask.
  String _operationId = superTabOperationId();

  /// The command [_operationId] last carried.
  Map<String, dynamic>? _asked;

  bool get _holds =>
      _pmId != null &&
      swarmCanSwitchPm(widget.reader, widget.projectId) &&
      swarmLeadOf(widget.reader.snapshot, widget.projectId)?.id == _pmId;

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_moved);
    unawaited(_readCatalog());
  }

  @override
  void dispose() {
    widget.reader.removeListener(_moved);
    super.dispose();
  }

  /// The Swarm's model catalog, as Desktop's dialog reads it once; a read
  /// that fails leaves Default alone.
  Future<void> _readCatalog() async {
    final reader = widget.reader;
    try {
      final answer = await reader.request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/routing-policy',
      );
      final catalog = swarmSwitchPmCatalog(answer);
      if (mounted) setState(() => _catalog = catalog);
    } catch (_) {
      // The engine's own model, Default, is still there to pick.
    }
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

  Future<void> _switch(Map<String, dynamic> command) async {
    if (_busy || _closed) return;
    final reader = widget.reader;
    // An answer lost on the way is asked for again by the same receipt; a
    // different ask is a new one.
    if (_asked != null && !_same(_asked!, command)) {
      _operationId = superTabOperationId();
    }
    _asked = command;
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {'operationId': _operationId, 'command': command},
      );
    } on SuperTabFailure catch (failure) {
      error = failure.message;
      if (failure.statusCode >= 400 && failure.statusCode < 500) {
        _operationId = superTabOperationId();
        _asked = null;
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

  static bool _same(Map<String, dynamic> a, Map<String, dynamic> b) =>
      a.length == b.length && a.keys.every((k) => b[k] == a[k]);

  Widget _row(SwarmSwitchPmChoice choice, bool picked, bool machineOpen) {
    final p = choice.profile;
    final pickable = machineOpen && swarmSwitchPmPickable(choice);
    final detail = swarmSwitchPmDetail(choice);
    return Semantics(
      selected: picked,
      child: InkWell(
        key: ValueKey('swarm-switch-pm-${p.engine}-${p.id}'),
        borderRadius: BorderRadius.circular(AppControl.radius),
        onTap: pickable && !_busy
            ? () => setState(() {
                _picked = (engine: p.engine, id: p.id);
                _model = null;
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

  Widget _quiet(String text, {Key? key, double top = AppSpace.s}) => Padding(
    padding: EdgeInsets.only(top: top),
    child: Text(
      text,
      key: key,
      style: AppType.caption(color: AppPalette.textSecondary),
    ),
  );

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final reader = widget.reader;
    final snapshot = reader.snapshot;
    final lead = swarmLeadOf(snapshot, widget.projectId);
    final now = DateTime.now();
    final machines = swarmSwitchPmMachines(reader, widget.projectId, now: now);
    // A machine chosen that left the list: back to the PM's own, with
    // nothing picked on it (Desktop's).
    if (lead != null &&
        _machineId != lead.machineId &&
        !machines.any((m) => m.id == _machineId)) {
      _machineId = lead.machineId;
      _picked = null;
      _model = null;
    }
    final machineId = _machineId ?? lead?.machineId;
    final active = machines.where((m) => m.id == machineId).firstOrNull;
    final activePool = machineId == null ? null : snapshot?.pool(machineId);
    final machineOpen = active != null && active.unavailable == null;
    List<SwarmSwitchPmChoice> choicesOn(String id) => snapshot == null
        ? const <SwarmSwitchPmChoice>[]
        : swarmSwitchPmChoices(snapshot, widget.projectId, machineId: id);
    final choices = machineId == null
        ? const <SwarmSwitchPmChoice>[]
        : choicesOn(machineId);
    bool isPicked(SuperTabProfile p) =>
        _picked?.engine == p.engine && _picked?.id == p.id;
    // A pick that can no longer be made (it ran out meanwhile) is none.
    final picked =
        machineOpen &&
            choices.any((c) => swarmSwitchPmPickable(c) && isPicked(c.profile))
        ? _picked
        : null;
    final models = swarmSwitchPmModels(
      _catalog,
      picked?.engine ?? lead?.engine ?? '',
    );
    if (_model != null && !models.contains(_model)) _model = null;
    final others = [
      for (final m in machines)
        if (!m.current && m.unavailable == null) m,
    ];
    final noChoice =
        !(machineOpen && choices.any(swarmSwitchPmPickable)) &&
        !others.any(
          (m) => choicesOn(m.id).any((c) => c.profile.leftPercent != 0),
        );
    final refusal = swarmSwitchPmRefusal(reader, widget.projectId, now: now);
    final note =
        refusal ??
        (!noChoice
            ? null
            : others.isEmpty
            ? 'No other machine or account can run a Product Manager right '
                  'now.'
            : 'No engine or account can run a Product Manager right now.');
    final command = picked == null || lead == null || machineId == null
        ? null
        : swarmSwitchPmCommand(
            projectId: widget.projectId,
            picked: picked,
            currentMachineId: lead.machineId,
            machineId: machineId,
            model: _model,
          );
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
                _SwitchPmPicker<String>(
                  key: const ValueKey('swarm-switch-pm-machine'),
                  label: 'Machine',
                  value: machineId,
                  options: [
                    for (final m in machines)
                      (
                        value: m.id,
                        key: 'swarm-switch-pm-machine-${m.id}',
                        label: [m.name, if (m.current) 'Current'].join(' · '),
                        detail: m.unavailable,
                        enabled: m.unavailable == null,
                      ),
                  ],
                  onChanged: _busy
                      ? null
                      : (id) => setState(() {
                          _machineId = id;
                          _picked = null;
                          _model = null;
                          _error = null;
                        }),
                ),
                if (choices.isEmpty)
                  _quiet(
                    active?.unavailable ??
                        'No engine or account is available on this machine.',
                  ),
                for (final choice in choices)
                  _row(
                    choice,
                    picked != null && isPicked(choice.profile),
                    machineOpen,
                  ),
                _SwitchPmPicker<String?>(
                  key: const ValueKey('swarm-switch-pm-model'),
                  label: 'Model',
                  value: _model,
                  options: [
                    (
                      value: null,
                      key: 'swarm-switch-pm-model-default',
                      label: 'Default',
                      detail: null,
                      enabled: true,
                    ),
                    for (final model in models)
                      (
                        value: model,
                        key: 'swarm-switch-pm-model-$model',
                        label: model,
                        detail: null,
                        enabled: true,
                      ),
                  ],
                  onChanged: _busy
                      ? null
                      : (model) => setState(() => _model = model),
                ),
                if (note != null)
                  _quiet(
                    note,
                    key: const ValueKey('swarm-switch-pm-no-choice'),
                  ),
                if (activePool != null &&
                    activePool['contributorId'] != reader.accountId)
                  _quiet('Only accounts its owner offered are listed.'),
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
            onPressed: _busy || command == null || refusal != null || noChoice
                ? null
                : () => unawaited(_switch(command)),
          ),
        ],
      ),
    );
  }
}

/// One choice of a [_SwitchPmPicker]: its value, its row's key, its words,
/// and, for one that cannot be chosen, why under them.
typedef _SwitchPmOption<T> = ({
  T value,
  String key,
  String label,
  String? detail,
  bool enabled,
});

/// Switch PM's Machine and Model rows, as Desktop's select fields: [label]
/// at its start, the choice made at its end with a chevron, and a tap opens
/// a menu of [options] on the design system's menu surface, the choice
/// made ticked, one that cannot be chosen dimmed with why under it. Fixed
/// while [onChanged] is null.
class _SwitchPmPicker<T> extends StatelessWidget {
  const _SwitchPmPicker({
    super.key,
    required this.label,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  final String label;
  final T? value;
  final List<_SwitchPmOption<T>> options;
  final ValueChanged<T>? onChanged;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final shown = options.where((o) => o.value == value).firstOrNull?.label;
    final enabled = onChanged != null;
    // As wide as the phone allows, so a machine's why wraps inside it.
    final widest = MediaQuery.sizeOf(context).width - 2 * AppSpace.screenInset;
    return MenuAnchor(
      style: AppMenu.style(maxWidth: widest),
      // Held to [widest], so long words wrap rather than run off the phone.
      crossAxisUnconstrained: false,
      alignmentOffset: const Offset(0, AppSpace.xs),
      menuChildren: [
        for (final option in options)
          MenuItemButton(
            key: ValueKey(option.key),
            style: ButtonStyle(
              minimumSize: const WidgetStatePropertyAll(
                Size(AppSpace.xl * 6, minTouchTarget),
              ),
              foregroundColor: WidgetStateProperty.resolveWith(
                (states) => states.contains(WidgetState.disabled)
                    ? AppPalette.textFaint
                    : AppPalette.textPrimary,
              ),
              textStyle: WidgetStatePropertyAll(AppType.body()),
            ),
            onPressed: option.enabled && enabled
                ? () => onChanged!(option.value)
                : null,
            trailingIcon: option.value == value
                ? Icon(
                    LucideIcons.check300,
                    size: AppIconSize.besideText,
                    color: AppPalette.accentOnSurface,
                  )
                : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpace.xs),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(option.label),
                  if (option.detail case final detail?)
                    Text(
                      detail,
                      style: AppType.caption(color: AppPalette.textSecondary),
                    ),
                ],
              ),
            ),
          ),
      ],
      builder: (context, menu, _) => Semantics(
        button: true,
        enabled: enabled,
        label: '$label: ${shown ?? ''}',
        excludeSemantics: true,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppControl.radius),
          onTap: enabled
              ? () => menu.isOpen ? menu.close() : menu.open()
              : null,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minTouchTarget),
            child: Row(
              children: [
                Text(
                  label,
                  style: AppType.label(color: AppPalette.textSecondary),
                ),
                const SizedBox(width: AppSpace.m),
                // Two lines before it is cut: "Ken's MacBook Pro · Current"
                // whole on a narrow phone.
                Expanded(
                  child: Text(
                    shown ?? '',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.end,
                    style: AppType.label(
                      color: enabled
                          ? AppPalette.textPrimary
                          : AppPalette.textSecondary,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpace.xs),
                Icon(
                  LucideIcons.chevronDown300,
                  size: AppIconSize.besideText,
                  color: AppPalette.textSecondary,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
