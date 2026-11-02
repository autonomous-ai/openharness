import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/status_line_style.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../usage/models_menu_controller.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/harness_activity_mark.dart';
import '../widgets/workspace_subscription_usage.dart';
import 'add_computers.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'local_models.dart';
import 'machine_allowance.dart';
import '../models/swarm_models_target.dart' show swarmSharedWithYouShown;
import 'machine_details.dart';
import 'machine_icon.dart';
import 'machine_status.dart';
import 'model.dart';
import 'join_machine.dart' show superTabSuggestedAgentSlots;
import 'team_account_setup.dart';
import 'section_heading.dart';

export 'machine_status.dart';

/// The backend's upper bound. A machine's own total RAM may set a lower one.
const _agentSlotsMin = 1;
const _agentSlotsMax = 1024;

/// Every machine may offer this many, whatever its RAM, and the suggestion
/// never starts above 16 (superTabSuggestedAgentSlots): the CLI's own figures
/// (`prepareContribution`, `cli/src/superTabs/contribution.ts`).
const _agentSlotsFloor = 4;

/// What one more agent needs to start, the CLI's own figure
/// (`START_REQUIREMENTS.memoryBytes`, `cli/src/superTabs/capacity.ts`).
const _agentMemoryBytes = 2 * 1024 * 1024 * 1024;

int _clampAgentSlots(num value) =>
    value.toInt().clamp(_agentSlotsMin, _agentSlotsMax);

/// The machine's total-RAM limit and its half-sized starting suggestion.
/// Every 2 GiB may run an agent and every machine may offer four, with no cap
/// of 16 (Ken, 2026-10-28: it held a 192 GiB Mac Studio to a sixth of its
/// room). The suggestion keeps its 16, so 192 GiB suggests 16 of 96 slots.
int? _maxAgentSlots(MachineResources? resources) {
  final total = resources?.memoryTotalBytes;
  if (total == null) return null;
  final byMemory = (total / _agentMemoryBytes).floor();
  return _clampAgentSlots(
    byMemory < _agentSlotsFloor ? _agentSlotsFloor : byMemory,
  );
}

int? _suggestedAgentSlots(MachineResources? resources) =>
    superTabSuggestedAgentSlots(resources);

class SuperTabMachines extends StatefulWidget {
  const SuperTabMachines({
    super.key,
    required this.controller,
    required this.onAddAgent,
    this.app,
    this.embedded = false,
    this.now = DateTime.now,
    this.readLocal,
    this.collapsed = false,
    this.onToggleCollapsed,
    this.onOpenAgent,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final bool embedded;

  /// Whether the body below the heading is hidden. The heading itself, and
  /// its Add machine action, remain visible so the group stays reachable.
  final bool collapsed;
  final VoidCallback? onToggleCollapsed;

  /// Opens an existing agent using the workspace's membership and account guards.
  final ValueChanged<SuperTabAgent>? onOpenAgent;
  final ValueChanged<SuperTabConversation> onAddAgent;

  /// The clock the readings' ages are counted against.
  final DateTime Function() now;

  /// Reads this computer's own view of a machine, in place of [AppNotifier.readMachineResources]. A test gives it
  /// to have the readings taken (they are not, under `flutter test`, unless it does).
  @visibleForTesting
  final Future<MachineResources?> Function(String machineId)? readLocal;
  @override
  State<SuperTabMachines> createState() => _SuperTabMachinesState();
}

/// The engines whose allowance a machine row shows, in this order.
const _chipEngines = ['claude', 'codex'];

/// A machine's Agents setting in its settings: as many as its memory allows
/// (the [_maxAgentSlots] figure, stored in the same `maxAgents` every machine
/// has), or at most a number its owner picks. Each start still checks free
/// memory either way (Dee, 2026-10-29).
///
/// The number is a stepper rather than a field, so no keystroke can leave the
/// dialog holding a count the backend would refuse; both buttons go dead at
/// the bounds rather than staying lit and doing nothing. Changing it chooses
/// At most, the only choice it belongs to. It sits beside the At most tile
/// rather than inside it, so a screen reader reaches the number and its two
/// buttons instead of one merged choice (review of #2084).
class _AgentsLimit extends StatelessWidget {
  const _AgentsLimit({
    required this.memory,
    required this.value,
    required this.maximum,
    required this.busy,
    required this.onMemory,
    required this.onAtMost,
  });

  final bool memory;
  final int value;
  final int maximum;
  final bool busy;
  final VoidCallback onMemory;
  final ValueChanged<int> onAtMost;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final value = this.value;
    final canFewer = !busy && value > _agentSlotsMin;
    final canMore = !busy && value < maximum;
    void fewer() => onAtMost(value > maximum ? maximum : value - 1);
    void more() => onAtMost(value + 1);
    return Row(
      // "Agents" on the line of its first choice.
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Text('Agents', style: DesktopChrome.text()),
        const SizedBox(width: grid.AppDesktop.groupGap),
        Expanded(
          child: RadioGroup<String>(
            key: const ValueKey('machine-agents'),
            groupValue: memory ? 'memory' : 'atMost',
            onChanged: (choice) {
              if (busy) return;
              choice == 'memory' ? onMemory() : onAtMost(value);
            },
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Standard tiles: one Tab stop for the choice, and the arrow
                // keys move it (re-review of #2084).
                RadioListTile<String>(
                  key: const ValueKey('machine-agents-memory'),
                  value: 'memory',
                  enabled: !busy,
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: const Text('As memory allows'),
                ),
                Row(
                  children: [
                    Expanded(
                      child: RadioListTile<String>(
                        key: const ValueKey('machine-agents-at-most'),
                        value: 'atMost',
                        enabled: !busy,
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        title: const Text('At most'),
                      ),
                    ),
                    // The number on its own: adjustable by a screen reader's
                    // increase and decrease, with its two buttons beside it.
                    Semantics(
                      container: true,
                      label: 'Most agents',
                      value: '$value',
                      increasedValue: canMore ? '${value + 1}' : null,
                      decreasedValue: canFewer
                          ? '${value > maximum ? maximum : value - 1}'
                          : null,
                      onIncrease: canMore ? more : null,
                      onDecrease: canFewer ? fewer : null,
                      child: Container(
                        constraints: const BoxConstraints(
                          minHeight: grid.AppControl.height,
                        ),
                        decoration: BoxDecoration(
                          // The same recessed well the picker's control sits in.
                          color: grid.AppSurface.recess,
                          borderRadius: BorderRadius.circular(
                            grid.AppControl.radius,
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            AppIconButton(
                              key: const ValueKey('agent-limit-fewer'),
                              icon: AppIcons.minus,
                              size: grid.AppControl.iconSize,
                              tooltip: 'Fewer agents',
                              onPressed: canFewer ? fewer : null,
                            ),
                            ExcludeSemantics(
                              child: Text(
                                value.toString(),
                                key: const ValueKey('agent-limit-value'),
                                style: DesktopChrome.control().copyWith(
                                  fontFeatures: const [
                                    FontFeature.tabularFigures(),
                                  ],
                                ),
                              ),
                            ),
                            AppIconButton(
                              key: const ValueKey('agent-limit-more'),
                              icon: AppIcons.plus,
                              size: grid.AppControl.iconSize,
                              tooltip: 'More agents',
                              onPressed: canMore ? more : null,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// Sets [machineId]'s project up for the Swarm and asks what it offers
/// (`prepareContribution`), a second apart for up to five minutes. Null when
/// [alive] says the asker is gone or the reader can no longer write. [setupId]
/// names the setup, so asking again joins the one under way.
Future<Map<String, dynamic>?> _prepareContribution(
  SuperTabController c,
  AppNotifier app,
  String machineId, {
  required String setupId,
  required bool Function() alive,
}) async {
  final deadline = clock.now().add(const Duration(minutes: 5));
  while (true) {
    if (!alive() || !c.canWrite) return null;
    final prepared = await app.superTabMachineRequest(machineId, {
      'action': 'prepareContribution',
      'tabId': c.tabId,
      'scope': 'swarm',
      'operationId': setupId,
    });
    if (prepared['state'] == 'ready' && prepared['scope'] == 'swarm') {
      return prepared;
    }
    if (prepared['state'] != 'preparing') {
      throw const SuperTabFailure(
        'UPDATE_REQUIRED',
        'Update Harness on this machine, then try again.',
      );
    }
    if (clock.now().isAfter(deadline)) {
      throw const SuperTabFailure(
        'SETUP_PENDING',
        'Project setup is still running. Try again to check its progress.',
      );
    }
    await Future<void>.delayed(const Duration(seconds: 1));
  }
}

/// The engines a prepared machine offers the Swarm.
List<String> _contributedEngines(Map<String, dynamic> prepared) {
  final engines =
      (prepared['engines'] as List?)
          ?.whereType<String>()
          .where((engine) => _chipEngines.contains(engine))
          .toSet()
          .toList() ??
      <String>[];
  if (engines.isEmpty) {
    throw const SuperTabFailure(
      'NO_SWARM_ENGINE',
      'Install Claude Code or Codex on this machine, then try again.',
    );
  }
  return engines;
}

/// The setup a Buddy sends for [machineId], one of the reader's own machines
/// outside the Swarm: prepared there as Add machine prepares one (its folder
/// and engines), so the server records it for their Buddies alone and never
/// adds it to the Swarm (Dee, 10-29). Null when [alive] ended first or the
/// reader can no longer write.
Future<Map<String, dynamic>?> prepareBuddyMachine(
  SuperTabController c,
  AppNotifier app,
  String machineId, {
  required String setupId,
  required bool Function() alive,
}) async {
  final prepared = await _prepareContribution(
    c,
    app,
    machineId,
    setupId: setupId,
    alive: alive,
  );
  if (prepared == null) return null;
  return {
    'name': app.stateOf(machineId)?.machine.displayName ?? machineId,
    'cwd': prepared['cwd'],
    'engines': _contributedEngines(prepared),
  };
}

/// Adds the prepared [machineId] to the Swarm, offering [maxAgents] slots.
/// False when [alive] says the asker is gone or the reader can no longer
/// write, in which case nothing was added.
Future<bool> _sendContribution(
  SuperTabController c,
  AppNotifier app,
  String machineId,
  Map<String, dynamic> prepared,
  List<String> engines, {
  required int maxAgents,
  required bool Function() alive,
  bool teamAccountOnly = false,
  bool offerTeamAccount = true,
}) async {
  // An earlier lost reply leaves an uncertain attempt holding its own
  // receipt, and only one action may be in flight: check that one first, then
  // send the number the owner is looking at — the stored attempt cannot know
  // it was changed.
  if (c.pendingCommand?['type'] == 'machine.contribute') {
    // If that attempt cannot be confirmed, its own error is the one worth
    // showing: it says why it is still unclear.
    if (await c.retry() == null) {
      if (!alive()) return false;
      throw SuperTabFailure(
        c.operationErrorCode ?? 'CONTRIBUTION_FAILED',
        c.operationError ?? 'The earlier attempt is still not confirmed. Try again to check it.',
      );
    }
    if (!alive() || !c.canWrite) return false;
  }
  final result = await c.command({
    'type': 'machine.contribute',
    'machineId': machineId,
    'name': app.stateOf(machineId)!.machine.displayName,
    'cwd': prepared['cwd'],
    if (prepared['scope'] != null) 'scope': prepared['scope'],
    'engines': engines,
    'maxAgents': maxAgents,
    if (teamAccountOnly) 'teamAccountOnly': true,
  });
  if (result == null) {
    throw SuperTabFailure(
      'CONTRIBUTION_FAILED',
      c.operationError ?? 'Could not add this machine.',
    );
  }
  await app.wakeSuperTabHost(machineId);
  // This Mac, added while its person is here: macOS asks once for the Harness
  // Team account (cli/src/team/autoSetup.ts).
  if (offerTeamAccount && app.stateOf(machineId)?.isLocalMachine == true) {
    unawaited(app.offerTeamAccount('contribute', tabId: c.tabId));
  }
  return true;
}

/// Adds the reader's own computer [machineId] to the Swarm as the Add machine
/// form does when its Add machine is clicked untouched: the slots its memory
/// suggests, else what preparation offered. Resolves to [machineId], null when
/// [alive] ended first. Throws a [SuperTabFailure] saying why it could not.
/// [setupId] is the caller's to keep between tries: a setup still running
/// answers the next try with the same one. With [teamAccountOnly], teammates'
/// work reaches it only through its Harness Team account once that passes its
/// privacy check (backend superTabs/machines.ts `teamWorkRefusal`). Without
/// [offerTeamAccount], this Mac is not offered a Harness Team account: a
/// Personal Swarm has no teammates to run work for.
/// [readResources] stands in for [AppNotifier.readMachineResources].
Future<String?> contributeComputer(
  SuperTabController c,
  AppNotifier app,
  String machineId, {
  required String setupId,
  required bool Function() alive,
  bool teamAccountOnly = false,
  bool offerTeamAccount = true,
  Future<MachineResources?> Function(String machineId)? readResources,
}) async {
  final prepared = await _prepareContribution(
    c,
    app,
    machineId,
    setupId: setupId,
    alive: alive,
  );
  if (prepared == null) return null;
  final engines = _contributedEngines(prepared);
  MachineResources? resources;
  try {
    resources = await (readResources ?? app.readMachineResources)(machineId);
  } catch (_) {
    // The suggestion only sizes the offer; preparation's own number stands in.
  }
  final offered = prepared['maxAgents'];
  final slots =
      _suggestedAgentSlots(resources) ??
      (offered is num ? _clampAgentSlots(offered) : _agentSlotsMin);
  if (!alive() || !c.canWrite) return null;
  final added = await _sendContribution(
    c,
    app,
    machineId,
    prepared,
    engines,
    maxAgents: slots,
    alive: alive,
    teamAccountOnly: teamAccountOnly,
    offerTeamAccount: offerTeamAccount,
  );
  return added ? machineId : null;
}

/// Why [m] cannot be added to the Swarm now, in the Add machine form's words;
/// null when it can.
({IconData icon, String message})? _machineUnavailable(
  MachineState m, {
  required bool inSwarm,
}) {
  if (inSwarm) {
    return (icon: AppIcons.circleCheck, message: 'Already in this Swarm');
  }
  if (m.needsLink) {
    return (
      icon: AppIcons.unlink,
      message: 'Not linked. Link this computer from Machines.',
    );
  }
  if (m.isOffline) {
    return (
      icon: AppIcons.cloudOff,
      message: 'Offline. Open Harness on this computer to add it.',
    );
  }
  return null;
}

/// Why this computer cannot be added to the Swarm from here, as the Add
/// machine form says it; null when it can.
String? thisComputerRefusal(AppNotifier app, SuperTabController c) {
  final here = app.machineStates.values
      .where((m) => m.isLocalMachine)
      .firstOrNull;
  if (here == null || here.belongsToOtherAccount) {
    return 'No computer is connected to this account yet.';
  }
  final inSwarm = (c.snapshot?.machines ?? const <Map<String, dynamic>>[]).any(
    (m) => m['machineId'] == here.machine.machineId,
  );
  return _machineUnavailable(here, inSwarm: inSwarm)?.message;
}

/// A machine's settings in this Swarm, its owner's: how many agents it runs,
/// and Remove from this Swarm. Adding machines is Add your computers
/// (add_computers.dart). The panel's own knowledge comes in as callbacks:
/// [sampleOf] a reading it already holds, [canRemove], [removeReason] and
/// [remove] for Remove from this Swarm, and [readLocal] in place of
/// [AppNotifier.readMachineResources].
Future<void> _machineSettingsDialog(
  BuildContext context,
  SuperTabController c,
  AppNotifier app, {
  required Map<String, dynamic> existing,
  _MachineView? view,
  required MachineResources? Function(String machineId) sampleOf,
  required bool Function(String machineId) canRemove,
  required String? Function(String machineId) removeReason,
  required void Function(_MachineView view) remove,
  Future<MachineResources?> Function(String machineId)? readLocal,
}) async {
  final existingId = existing['machineId'] as String;
  bool canSelect(MachineState? m) =>
      m != null &&
      !m.belongsToOtherAccount &&
      _machineUnavailable(m, inSwarm: false) == null;
  String? error;
  var busy = false;
  String? setupId;
  int? storedSlots(String? id) {
    final row = id == null
        ? null
        : c.snapshot?.machines.where((m) => m['machineId'] == id).firstOrNull;
    final current = row?['maxAgents'];
    return current is num ? current.toInt() : null;
  }

  // Readings this dialog has taken itself, keyed by machine. The panel's own
  // samples stand in for a machine it already reads.
  final suggestions = <String, int>{};
  final maximums = <String, int>{};

  // Machine settings: As memory allows, or At most a number (Dee,
  // 2026-10-29). Memory is known from this dialog's reading, the panel's
  // sample, or what the machine last reported to the Swarm.
  MachineResources? settingsResources() =>
      sampleOf(existingId) ?? view?.resources;
  int? memoryMaximum() =>
      maximums[existingId] ?? _maxAgentSlots(settingsResources());

  // Until the owner touches either, both follow what is known: a stored
  // limit at or above the maximum is as memory allows, and one below it is
  // the owner's own. With the maximum unknown a stored number is kept, and
  // a machine with no number of its own starts at At most its suggestion
  // (review of #2084).
  bool? memoryEdited;
  int? atMostEdited;
  bool memoryChoice() {
    if (memoryEdited != null) return memoryEdited!;
    final stored = storedSlots(existingId);
    final maximum = memoryMaximum();
    return stored != null && maximum != null && stored >= maximum;
  }

  // With nothing known, every machine may offer four.
  int atMostMaximum() =>
      memoryMaximum() ??
      _clampAgentSlots(storedSlots(existingId) ?? _agentSlotsFloor);
  int atMostValue() {
    if (atMostEdited != null) return atMostEdited!;
    final stored = storedSlots(existingId);
    final maximum = memoryMaximum();
    if (stored != null && (maximum == null || stored < maximum)) {
      return _clampAgentSlots(stored);
    }
    final suggested =
        suggestions[existingId] ?? _suggestedAgentSlots(settingsResources());
    return (suggested ?? maximum ?? stored ?? _agentSlotsFloor).clamp(
      _agentSlotsMin,
      atMostMaximum(),
    );
  }

  /// Why this machine's settings cannot be saved from here, in settings'
  /// own words; null when they can.
  String? settingsUnavailable() {
    final m = app.stateOf(existingId);
    if (m == null) {
      return 'This computer can’t reach that machine. Sign in to Harness '
          'there with this account to change its settings.';
    }
    // The machine by name: "this computer" is the one you're on.
    final name = superTabMachineName(m.machine.displayName);
    if (m.belongsToOtherAccount) {
      return '$name is signed in to another account.';
    }
    if (m.needsLink) return 'Not linked. Link $name from Machines.';
    if (m.isOffline) {
      return 'Offline. Open Harness on $name to change its settings.';
    }
    return null;
  }

  // As memory allows saves the machine's maximum: its own figure from
  // setup (it measured the machine just now), else the one known here,
  // else what an older Harness's setup offered.
  int memoryLimit(Map<String, dynamic> prepared) {
    final offeredMaximum = prepared['maxAvailableAgents'];
    if (offeredMaximum is num) return _clampAgentSlots(offeredMaximum);
    final offered = prepared['maxAgents'];
    return memoryMaximum() ??
        (offered is num
            ? _clampAgentSlots(offered)
            : storedSlots(existingId) ?? _agentSlotsFloor);
  }

  // The open dialog and its own setState, once it is built: a reading
  // answers while the form is open, and the field has to repaint when it
  // does. Both are read only while the dialog is still there — one that
  // arrives after it closed has nothing to repaint.
  BuildContext? dialog;
  void Function(void Function())? repaint;
  var reading = false;

  /// The machine's memory reading, for the At most limit, without asking
  /// preparation: preparation sets the project up, probes engines and takes
  /// one of its 32 setup slots, and opening settings the owner may cancel is
  /// no reason to do that. The owner's chosen number is never replaced.
  Future<void> readMemory() async {
    if (reading || !canSelect(app.stateOf(existingId))) return;
    reading = true;
    MachineResources? resources;
    try {
      resources = await (readLocal ?? app.readMachineResources)(existingId);
    } catch (_) {
      return;
    }
    final suggested = _suggestedAgentSlots(resources);
    if (suggested == null || dialog?.mounted != true) return;
    suggestions[existingId] = suggested;
    maximums[existingId] = _maxAgentSlots(resources)!;
    repaint?.call(() {});
  }

  await showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      child: ListenableBuilder(
        listenable: app,
        builder: (context, _) => StatefulBuilder(
          builder: (context, update) {
            dialog = context;
            repaint = update;
            // Not awaited: the form is usable immediately, and the limit
            // only has to be there by the time the owner reads it. The
            // machine is read once, so a rebuild does not read again.
            unawaited(readMemory());
            final canSave = canSelect(app.stateOf(existingId));
            Future<void> save() async {
              if (busy || !c.canWrite || !canSelect(app.stateOf(existingId))) {
                return;
              }
              // Settings save what is on screen now: preparation below may
              // learn a different maximum, and that must not turn the
              // owner's At most into As memory allows (review of #2084).
              final atMost = memoryChoice() ? null : atMostValue();
              update(() {
                busy = true;
                error = null;
              });
              try {
                setupId ??= superTabOperationId();
                final prepared = await _prepareContribution(
                  c,
                  app,
                  existingId,
                  setupId: setupId!,
                  alive: () => context.mounted,
                );
                if (prepared == null) return;
                if (!context.mounted || !c.canWrite) return;
                final engines = _contributedEngines(prepared);
                final offeredMaximum = prepared['maxAvailableAgents'];
                if (offeredMaximum is num) {
                  maximums[existingId] = _clampAgentSlots(offeredMaximum);
                }
                if (!await _sendContribution(
                  c,
                  app,
                  existingId,
                  prepared,
                  engines,
                  maxAgents: atMost ?? memoryLimit(prepared),
                  alive: () => context.mounted,
                )) {
                  return;
                }
                if (context.mounted) Navigator.pop(context);
              } catch (failure) {
                if (context.mounted) {
                  update(() {
                    busy = false;
                    error = failure.toString();
                    if (failure is! SuperTabFailure ||
                        failure.code != 'SETUP_PENDING') {
                      setupId = null;
                    }
                  });
                }
              }
            }

            final current = app.stateOf(existingId);
            final why = settingsUnavailable();
            return SuperTabDetailDialog(
              title: superTabMachineName(
                current?.machine.displayName ??
                    existing['name'] as String? ??
                    existingId,
              ),
              body: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _AgentsLimit(
                    memory: memoryChoice(),
                    value: atMostValue(),
                    maximum: atMostMaximum(),
                    busy: busy,
                    onMemory: () => update(() => memoryEdited = true),
                    onAtMost: (next) => update(() {
                      memoryEdited = false;
                      atMostEdited = next;
                    }),
                  ),
                  // Why it cannot be removed, in words rather than a dimmed button alone.
                  if (view != null && canRemove(view.id))
                    if (removeReason(view.id) case final reason?) ...[
                      const SizedBox(height: grid.AppDesktop.controlGap),
                      Text(reason, style: DesktopChrome.metadata()),
                    ],
                  if (!canSave && why != null) ...[
                    const SizedBox(height: grid.AppDesktop.controlGap),
                    Text(why, style: DesktopChrome.metadata()),
                  ],
                  if (error != null) ...[
                    const SizedBox(height: grid.AppDesktop.controlGap),
                    Text(error!, style: DesktopChrome.metadata()),
                  ],
                ],
              ),
              // One clear action at the right; the rarer one quiet at the
              // left, as in the machine's details.
              leadingActions: [
                if (view != null && canRemove(view.id))
                  TextButton(
                    style: superTabQuietAction,
                    onPressed: busy || removeReason(view.id) != null
                        ? null
                        : () {
                            Navigator.pop(context);
                            WidgetsBinding.instance.addPostFrameCallback((_) {
                              remove(view);
                            });
                          },
                    child: const Text('Remove from this Swarm'),
                  ),
              ],
              actions: [
                FilledButton(
                  onPressed: busy || !canSave ? null : save,
                  child: Text(busy ? 'Saving…' : 'Save'),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}

class _SuperTabMachinesState extends State<SuperTabMachines> {
  final _samples = <String, (MachineResources, DateTime)>{};
  String? _selectedMachineId;

  /// Samples from before foreground return stay cached, but their readings are
  /// hidden behind the refreshing state until the next read answers.
  final _awaiting = <String>{};

  /// How many reads of the Swarm's state had been answered when the app came back to the front; the machines
  /// reporting through it are refreshing until one more is. Null: the app has not been away.
  int? _swarmReadsAtReturn;

  /// Once a second, so that ages, states and the heading's count follow the clock between the Swarm's reads.
  Timer? _tick;
  final _tips = <String, GlobalKey<TooltipState>>{};
  ModelsMenuController? _usage;
  Timer? _timer;
  bool _reading = false;
  int _revision = 0;

  /// What this Mac's daemon remembers of its Harness Team account setup
  /// ([AppNotifier.teamSetupStatus]), for its own row's line; null until read
  /// or when it cannot say.
  ({String state, String? detail})? _teamSetup;
  bool _teamSetupReading = false;
  SuperTabController get c => widget.controller;
  // Team agents only: a Buddy is listed nowhere, and its machine may be its
  // person's alone, outside the Swarm (backend buddyOnly).
  Set<String> get _ids => {
    for (final a in c.snapshot?.teamAgents ?? const <SuperTabAgent>[])
      a.machineId,
    for (final m in c.snapshot?.machines ?? const <Map<String, dynamic>>[])
      m['machineId'] as String,
  };

  /// The rows: one per computer, a Mac's Harness Team account inside its Mac's ([SuperTabSnapshot.placeOf]).
  Iterable<String> get _rowIds =>
      _ids.where((id) => (c.snapshot?.placeOf(id) ?? id) == id);

  @override
  void initState() {
    super.initState();
    if (!kUnderTest) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) => _changed());
    }
    unawaited(_readTeamSetup());
    if ((!kUnderTest || widget.readLocal != null) && widget.app != null) {
      _updateUsage();
      widget.app!.foreground.addListener(_foreground);
      unawaited(_refresh());
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  /// Reads why this Mac has no Harness Team account, only while its person's
  /// own row offers Set up: asked of this Mac's daemon, never of another's.
  Future<void> _readTeamSetup() async {
    final app = widget.app;
    if (app == null || _teamSetupReading || !app.canSetUpTeamAccount) return;
    final own = c.snapshot?.machines.any(
      (m) =>
          m['contributorId'] == c.accountId &&
          app.stateOf(m['machineId'] as String)?.isLocalMachine == true &&
          (m['teamWork'] as Map?)?['code'] == 'TEAM_ACCOUNT_REQUIRED',
    );
    if (own != true) {
      _teamSetup = null;
      return;
    }
    _teamSetupReading = true;
    try {
      final read = await app.teamSetupStatus();
      if (!mounted) return;
      _teamSetup = read;
      _changed();
    } finally {
      _teamSetupReading = false;
    }
  }

  void _updateUsage() {
    if (kUnderTest || widget.app == null) return;
    if (!widget.app!.foreground.value) {
      _usage?.removeListener(_changed);
      _usage?.dispose();
      _usage = null;
    } else {
      _usage ??= ModelsMenuController(remote: widget.app!.readRemoteUsage)
        ..addListener(_changed)
        ..start();
    }
  }

  void _foreground() {
    _updateUsage();
    _revision++;
    _timer?.cancel();
    if (widget.app?.foreground.value == true) {
      // Keep machine identity stable while refreshing, without presenting the
      // previous foreground session's readings as current capacity.
      _awaiting.addAll(_samples.keys);
      _swarmReadsAtReturn = c.stateReads;
      unawaited(c.refresh());
      _changed();
      unawaited(_refresh());
    } else {
      _changed();
    }
  }

  Future<void> _refresh() async {
    if (_reading || !mounted || widget.app?.foreground.value != true) return;
    _reading = true;
    final revision = _revision;
    try {
      final ids = _ids.toList();
      for (var i = 0; i < ids.length; i += 2) {
        await Future.wait(
          ids.skip(i).take(2).map((id) async {
            final value =
                await (widget.readLocal ?? widget.app!.readMachineResources)(
                  id,
                );
            if (!mounted || revision != _revision || !_ids.contains(id)) return;
            // Read or not, the wait for it is over; with nothing read the last sample stands and ages.
            _awaiting.remove(id);
            if (value != null) _samples[id] = (value, widget.now());
            // Each machine as its read arrives, not once all of them have been read.
            _changed();
          }),
        );
        if (!mounted || revision != _revision) return;
      }
      _samples.removeWhere((id, _) => !_ids.contains(id));
      _awaiting.removeWhere((id) => !_samples.containsKey(id));
      await _readTeamSetup();
    } finally {
      _reading = false;
      if (mounted && widget.app?.foreground.value == true) {
        _timer = Timer(const Duration(seconds: 15), _refresh);
      }
    }
  }

  @override
  void dispose() {
    _revision++;
    _timer?.cancel();
    _tick?.cancel();
    widget.app?.foreground.removeListener(_foreground);
    _usage?.removeListener(_changed);
    _usage?.dispose();
    super.dispose();
  }

  /// [existing]'s settings in this Swarm (its owner's).
  Future<void> _settings({
    required Map<String, dynamic> existing,
    _MachineView? view,
  }) async {
    final app = widget.app;
    if (app == null) return;
    await _machineSettingsDialog(
      context,
      c,
      app,
      existing: existing,
      view: view,
      sampleOf: (id) => _samples[id]?.$1,
      canRemove: _canRemove,
      removeReason: _removeReason,
      remove: (v) {
        if (mounted) unawaited(_remove(v));
      },
      readLocal: widget.readLocal,
    );
  }

  /// One engine's reading as an account row. [old]: the machine is offline, so this is its last reading, whose
  /// windows may have reset since; the figures stay, as when they were read. A current reading whose window reset has
  /// none, the next reading has it.
  Map<String, Object?> _quotaRow(
    Map<String, dynamic> quota,
    String machineId, {
    required bool old,
  }) {
    final windows =
        [for (final raw in quota['windows'] as List? ?? []) superTabMap(raw)]
          ..sort(
            (a, b) => ((b['usedPercent'] as num?) ?? 0).compareTo(
              (a['usedPercent'] as num?) ?? 0,
            ),
          );
    DateTime? reset(dynamic raw) => raw is num
        ? DateTime.fromMillisecondsSinceEpoch(
            raw > 100000000000 ? raw.toInt() : (raw * 1000).toInt(),
          )
        : raw is String
        ? DateTime.tryParse(raw)
        : null;
    final expired =
        !old &&
        windows.any(
          (w) => reset(w['resetsAt'])?.isBefore(DateTime.now()) == true,
        );
    final known = quota['known'] == true && windows.isNotEmpty && !expired;
    return {
      'accountKey': 'machine:$machineId:${quota['engine']}',
      'engine': quota['engine'],
      'name': engineIdentity(quota['engine'] as String? ?? '').label,
      'remainingPercent': known
          ? 100 - (windows.first['usedPercent'] as num)
          : null,
      'details': [
        for (final w in windows)
          '${w['name']}: ${100 - (w['usedPercent'] as num)}% remaining${reset(w['resetsAt'])?.isAfter(DateTime.now()) == true ? ' · resets in ${_until(reset(w['resetsAt'])!)}' : ''}',
      ],
    };
  }

  String _until(DateTime when) {
    final minutes = when.difference(DateTime.now()).inMinutes;
    return minutes <= 0
        ? 'now'
        : minutes < 60
        ? '${minutes}m'
        : minutes < 1440
        ? '${minutes ~/ 60}h ${minutes % 60}m'
        : '${minutes ~/ 1440}d';
  }

  /// The Subscriptions a machine's row shows to every viewer, from its own pool ([SuperTabSnapshot.subscriptionPoolOf]):
  /// a Mac's Harness Team account spends the Mac owner's subscriptions. One card per engine it offers, Claude first,
  /// with its figure or why there is none; offline, the last figures, with when they were read.
  ({
    List<Map<String, Object?>> accounts,
    List<String>? engines,
    List<_Allowance> allowances,
    String aside,
  })
  _subscriptions(
    String id, {
    required Map<String, dynamic>? reading,
    required bool readingDim,
    required DateTime? readingAt,
    required DateTime now,
  }) {
    final pool = c.snapshot!.subscriptionPoolOf(id) ?? reading;
    final poolId = pool?['machineId'] as String? ?? id;
    final state = widget.app?.stateOf(poolId);
    final observation = superTabMap(
      pool?['observation'] ?? const <String, dynamic>{},
    );
    final received = observation['receivedAt'];
    final readAt = identical(pool, reading)
        ? readingAt
        : received is num
        ? DateTime.fromMillisecondsSinceEpoch(received.toInt())
        : null;
    final stale = identical(pool, reading)
        ? readingDim
        : readAt == null ||
              now.difference(readAt) >= kSuperTabMachineOfflineAfter;
    final quotas = {
      for (final raw in observation['quotas'] as List? ?? [])
        if (_chipEngines.contains(superTabMap(raw)['engine']))
          superTabMap(raw)['engine'] as String: superTabMap(raw),
    };
    final configured = (pool?['engines'] as List?)?.whereType<String>();
    final allowed =
        configured?.any((engine) => !_chipEngines.contains(engine)) == true
        ? quotas.keys.toList()
        : configured?.where(_chipEngines.contains).toList();
    var accounts =
        _usage?.rows
            .where(
              (row) =>
                  (allowed == null || allowed.contains(row['engine'])) &&
                  (state?.isLocalMachine == true
                      ? row['local'] == true
                      : (row['machines'] as List? ?? []).contains(
                          state?.machine.displayName,
                        )),
            )
            .toList() ??
        const <Map<String, Object?>>[];
    if (accounts.isEmpty && readAt != null) {
      accounts = [
        for (final quota in quotas.values) _quotaRow(quota, poolId, old: stale),
      ];
    }
    final reasons = observation['quotaReasons'];
    // Engines the server suspended here after failed starts, with why (backend superTabs/engineHealth.ts), on the Mac
    // or its Harness Team account.
    final suspended = <String, String>{
      for (final p in [c.snapshot!.pool(id), c.snapshot!.teamPoolOf(id)])
        if (p?['suspendedEngines'] case final Map raw)
          for (final entry in raw.entries)
            if (entry.key is String && entry.value is String)
              entry.key as String: entry.value as String,
    };
    final allowances = [
      for (final engine in _chipEngines)
        if (allowed?.contains(engine) ??
            (quotas.containsKey(engine) ||
                suspended.containsKey(engine) ||
                accounts.any((row) => row['engine'] == engine)))
          switch (accounts
              .where(
                (row) =>
                    row['engine'] == engine && row['remainingPercent'] is num,
              )
              .firstOrNull) {
            final row? => _figured(
              engine,
              row,
              stale: stale,
              struck: suspended[engine],
              // Information only: quota never makes a machine unusable.
              notice:
                  suspended[engine] == null &&
                      !stale &&
                      (row['remainingPercent'] as num) <= 0
                  ? _noQuotaLeft
                  : null,
            ),
            null => _unfigured(
              engine,
              poolId,
              superMachineAllowanceReason(
                quotas[engine],
                reasons is Map ? reasons[engine] : null,
              ),
              struck: suspended[engine],
            ),
          },
    ];
    return (
      accounts: accounts,
      engines: allowed,
      allowances: allowances,
      aside: !stale
          ? 'left now'
          : readAt == null
          ? 'offline'
          : 'offline, read ${superTabAgo(now.difference(readAt))}',
    );
  }

  /// [engine]'s card from its account [row], which has a figure; [stale] when it is the last one an offline machine read.
  _Allowance _figured(
    String engine,
    Map<String, Object?> row, {
    required bool stale,
    String? struck,
    String? notice,
  }) {
    final account = WorkspaceSubscriptionUsage.fromRows([row]).accounts.first;
    return _Allowance(
      engine: engine,
      name: account.name,
      figure: account.figure,
      left: (row['remainingPercent'] as num).toDouble().clamp(0, 100),
      stale: stale,
      struck: struck,
      notice: notice,
      note: superMachineAllowanceNote(switch (row['details']) {
        final List lines => lines.whereType<String>(),
        _ => const <String>[],
      }),
      detail: [
        account.name,
        ...switch (row['details']) {
          final List lines when lines.isNotEmpty => lines.whereType<String>(),
          _ => ['${account.figure} remaining'],
        },
      ].join('\n'),
    );
  }

  /// [engine]'s card without a figure, saying [reason] instead; named and figured as one with a reading is.
  _Allowance _unfigured(
    String engine,
    String machineId,
    String reason, {
    String? struck,
  }) {
    final account = WorkspaceSubscriptionUsage.fromRows([
      {'engine': engine, 'accountKey': 'machine:$machineId:$engine'},
    ]).accounts.first;
    return _Allowance(
      engine: engine,
      name: account.name,
      figure: account.figure,
      left: null,
      note: reason,
      struck: struck,
      detail: '${account.name}\n$reason',
    );
  }

  /// Everything a machine's row, its tooltip and its details say of it, read once per build.
  _MachineView _view(String id) {
    final app = widget.app, snapshot = c.snapshot!;
    final shared = snapshot.pool(id);
    // The Mac's Harness Team account is part of its row: its agents are listed here, and everyone but the Mac's owner
    // reads its availability, since it runs their agents, also while the owner is away from the Mac. The owner reads
    // their own computer. Actions stay the Mac's; the backend changes its team account with it.
    final team = snapshot.teamPoolOf(id);
    final teamId = team?['machineId'] as String?;
    final agents = snapshot.teamAgents
        .where((a) => snapshot.placeOf(a.machineId) == id)
        .toList();
    final contributor =
        shared?['contributorId'] as String? ??
        agents.firstOrNull?.contributorId;
    final person = snapshot.people
        .where((p) => p.id == contributor)
        .firstOrNull;
    final reading = snapshot.readingPoolOf(id, c.accountId);
    final teammateView = team != null && identical(reading, team);
    final readId = teammateView ? teamId! : id;
    final state = app?.stateOf(readId);
    final observation = superTabMap(
      reading?['observation'] ?? const <String, dynamic>{},
    );
    final now = widget.now();
    final received = observation['receivedAt'];
    final observedAt = received is num
        ? DateTime.fromMillisecondsSinceEpoch(received.toInt())
        : null;
    final sample = _samples[readId];
    final connected =
        state?.connectionStatus == ConnectionStatus.connected &&
        state?.nodeOnline != false;
    // Where the reading comes from. A computer this Desktop reads itself is known by that reading — and so is
    // this very computer when it contributes and its own sample is the newer, which is why it stays live while
    // the Swarm cannot be read. Any other contributing machine is known by what it reports through the Swarm.
    final direct =
        reading == null ||
        (state?.isLocalMachine == true &&
            sample != null &&
            (observedAt == null || sample.$2.isAfter(observedAt)));
    final readingAt = direct ? sample?.$2 : observedAt;
    final age = readingAt == null ? null : now.difference(readingAt);
    // A computer only running someone's agents, never added to the Swarm and not one this Desktop reads (a teammate's
    // Lead computer): nothing reports it but its agents, so it is up while one of them is (group #646, item 5).
    final agentsOnly = shared == null && team == null && state == null;
    final status = agentsOnly
        ? (agents.any((a) => a.downSince == null)
              ? SuperTabMachineStatus.live
              : SuperTabMachineStatus.offline)
        : superTabMachineStatus(
            age: age,
            // The Swarm cannot be read: a machine's silence is not known to be its own, so it is not offline.
            unreachable: !direct && c.backendUnreachable,
            refreshing: direct
                ? _awaiting.contains(readId)
                : _swarmReadsAtReturn != null &&
                      c.stateReads <= _swarmReadsAtReturn!,
            connected: direct ? connected : null,
          );
    // Cached samples remain available to the refresh logic, but stale numbers are not presented as current.
    final dim =
        status == SuperTabMachineStatus.offline ||
        status == SuperTabMachineStatus.unknown ||
        status == SuperTabMachineStatus.refreshing;
    final resource = superTabMap(
      observation['resources'] ?? const <String, dynamic>{},
    );
    final observed = observedAt != null
        ? MachineResources.fromJson({
            ...resource,
            if (resource['gpuPercent'] != null)
              'gpus': [
                {
                  'id': 'observed',
                  'name': 'GPU',
                  'utilizationPercent': resource['gpuPercent'],
                },
              ],
          })
        : null;
    final value = direct ? sample?.$1 : observed;
    // The name the person gave it in their own Machines list (Rename) wins
    // over the one the Swarm recorded, often its hostname.
    final given = app?.stateOf(id)?.machine.name;
    final name =
        (given == null || given.isEmpty ? null : given) ??
        shared?['name'] as String? ??
        app?.stateOf(id)?.machine.displayName ??
        // The Swarm knows no name for it, and sharing its own would be new data: it is named by its owner.
        (agentsOnly && person != null
            ? "${person.username}'s computer"
            : 'Unavailable machine');
    final subscriptions = _subscriptions(
      id,
      reading: reading,
      readingDim: dim,
      readingAt: readingAt,
      now: now,
    );
    final accounts = subscriptions.accounts, allowed = subscriptions.engines;
    final paused = reading?['paused'] == true;
    final removal = shared?['removal'];
    final cleaning =
        removal is Map && superTabMap(removal)['state'] == 'cleaning';
    final details = cleaning
        ? 'Cleaning up'
        : switch (status) {
            SuperTabMachineStatus.live ||
            SuperTabMachineStatus.late => paused ? 'New work paused' : 'Online',
            SuperTabMachineStatus.offline =>
              paused ? 'Offline, new work paused' : 'Offline',
            SuperTabMachineStatus.unknown => "Can't reach Harness",
            SuperTabMachineStatus.refreshing => 'Refreshing…',
          };
    final diskFree = value?.projectDiskTotalBytes == null
        ? value?.diskFreeBytes
        : value?.projectDiskFreeBytes;
    final memoryFree =
        value?.memoryTotalBytes == null || value?.memoryUsedBytes == null
        ? null
        : (value!.memoryTotalBytes! - value.memoryUsedBytes!).clamp(
            0,
            value.memoryTotalBytes!,
          );
    String available(double used) =>
        resourcePercent((100 - used).clamp(0, 100));
    // The models this machine offers the Swarm, from the same reading: an API's by its model, without the
    // provider's folder ("deepseek/…"), the API's name on hover.
    final apiModels = <_ServedModel>[], localModels = <_ServedModel>[];
    if (c.snapshot?.localModels case final local? when local.enabled) {
      for (final m
          in observation['localModels'] is List
              ? observation['localModels'] as List
              : const []) {
        if (m is! Map || m['model'] is! String) continue;
        final model = m['model'] as String;
        final named = m['name'] is String ? m['name'] as String : model;
        final starting = m['starting'] == true;
        final state = starting
            ? '\nStarting: not on the Swarm\'s grid yet'
            : '';
        switch (m['kind']) {
          case 'api' when m['grid'] == local.grid:
            final via = named.contains(' · ')
                ? named.substring(named.lastIndexOf(' · ') + 3)
                : null;
            apiModels.add((
              name: model.contains('/')
                  ? model.substring(model.lastIndexOf('/') + 1)
                  : model,
              tip:
                  [model, if (via != null) 'Shared from $via'].join('\n') +
                  state,
              starting: starting,
            ));
          case 'shared' when swarmSharedWithYouShown:
            localModels.add((
              name: named,
              tip: '$named\nShared with you',
              starting: false,
            ));
          case 'local' || null when m['grid'] == local.grid:
            localModels.add((
              name: named,
              tip: starting
                  ? '$named\nStarting on this machine'
                  : '$named\nRunning on this machine',
              starting: starting,
            ));
        }
      }
    }
    final line = _teammatesLine(shared, team, contributor);
    final setUpTeam =
        line != null &&
        team == null &&
        (shared?['teamWork'] as Map?)?['code'] == 'TEAM_ACCOUNT_REQUIRED' &&
        contributor == c.accountId &&
        app != null &&
        app.canSetUpTeamAccount &&
        app.stateOf(id)?.isLocalMachine == true;
    // Its own person reads why: they cancelled, or setup failed and why.
    final problem = setUpTeam
        ? superTabTeamSetupLine(_teamSetup) ?? line
        : line;
    return _MachineView(
      apiModels: apiModels,
      localModels: localModels,
      id: id,
      name: name,
      problem: problem,
      setUpTeam: setUpTeam,
      owner: person,
      contributor: contributor,
      shared: shared,
      agents: agents,
      status: status,
      readingAt: readingAt,
      arrived: age != null && age < const Duration(milliseconds: 1200),
      paused: paused,
      cleaning: cleaning,
      dim: dim,
      details: details,
      resources: value,
      accounts: accounts,
      engines: allowed,
      allowances: subscriptions.allowances,
      subscriptionsAside: subscriptions.aside,
      // What the line leaves out, for hover, focus and a screen reader: whose machine it is and its hardware,
      // after its state when that is not online. Never an age. Only current readings are included.
      tip: [
        if (cleaning) 'Cleaning up' else ?superTabMachineTip(status),
        if (person != null) 'Owned by ${person.username}',
        if (paused) 'New work paused',
        if (!dim && value?.cpuPercent != null)
          'CPU ${available(value!.cpuPercent!)} free',
        if (!dim && value?.busiestGpu?.utilizationPercent != null)
          'GPU ${available(value!.busiestGpu!.utilizationPercent!)} free',
        if (!dim && memoryFree != null)
          'RAM ${resourceBytes(memoryFree.toDouble())} free',
        if (!dim && diskFree != null) 'SSD ${resourceBytes(diskFree)} free',
      ].join(' · '),
    );
  }

  /// Why teammates' agents cannot run on this row's computer, in its one line; null when they can, when nobody
  /// else starts work in this Swarm, or when the row already reads offline: the computer's own silence, or, for
  /// anyone but the Mac's owner, its Harness Team account's. A Mac with a team account answers for that account.
  String? _teammatesLine(
    Map<String, dynamic>? shared,
    Map<String, dynamic>? team,
    String? contributor,
  ) {
    if (c.snapshot?.hasTeammates != true) return null;
    final work = (team ?? shared)?['teamWork'];
    if (work is! Map || work['allowed'] != false) return null;
    final code = work['code'];
    if (code == 'MACHINE_OFFLINE' &&
        (team == null || contributor != c.accountId)) {
      return null;
    }
    return superTabTeammatesPaused(code);
  }

  /// Every agent of the Swarm on [machineId]'s row, its Mac's Harness Team account's included: removing the machine
  /// takes them all with it.
  List<SuperTabAgent> _agentsOn(String machineId) {
    final snapshot = c.snapshot;
    return [
      for (final a in snapshot?.agents ?? const <SuperTabAgent>[])
        if (snapshot!.placeOf(a.machineId) == machineId) a,
    ];
  }

  String? _removeReason(String machineId) {
    final snapshot = c.snapshot;
    if (snapshot == null) return null;
    for (final agent in _agentsOn(machineId)) {
      if (snapshot.leadProtectionReason(agent.id) case final reason?) {
        return reason;
      }
    }
    return null;
  }

  /// A person can remove only the machine they contributed to this Swarm.
  bool _canRemove(String machineId) {
    if (!c.canWrite) return false;
    final pool = c.snapshot?.machines
        .where((m) => m['machineId'] == machineId)
        .firstOrNull;
    final removal = pool?['removal'];
    return pool?['contributorId'] == c.accountId &&
        (removal is! Map || superTabMap(removal)['state'] != 'cleaning');
  }

  Future<_RemovalPreview> _removalPreview(String machineId) async {
    final reply = await c.request(
      'GET',
      '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/machines/${Uri.encodeComponent(machineId)}/removal',
    );
    return _RemovalPreview.fromMap(reply);
  }

  /// Takes a machine out of this Swarm, and stops its ordinary agents after confirmation.
  Future<void> _remove(_MachineView v) async {
    final id = v.id, name = superTabMachineName(v.name);
    if (!_canRemove(id)) return;
    Future<_RemovalPreview>? previewFuture;
    var busy = false, attempted = false;
    await showAppDialog<void>(
      context: context,
      builder: (context) {
        // Start the read when the route builds, so FutureBuilder owns failures.
        previewFuture ??= _removalPreview(id);
        return SuperTabDialogScope(
          controller: c,
          child: StatefulBuilder(
            builder: (context, update) => FutureBuilder<_RemovalPreview>(
              future: previewFuture,
              builder: (context, previewState) => ListenableBuilder(
                listenable: c,
                builder: (context, _) {
                  final pending = c.pendingCommand;
                  final checking =
                      pending?['type'] == 'machine.remove' &&
                      pending?['machineId'] == id;
                  final available = _ids.contains(id) || checking || busy;
                  final permitted = _canRemove(id) || checking;
                  final reason = _removeReason(id);
                  final preview = previewState.data;
                  final blockedReason = preview?.blockedProjectName == null
                      ? null
                      : 'This machine runs the ${c.snapshot?.coordinatorNameOf(preview!.blockedProjectId ?? '') ?? kDefaultCoordinatorName} of project ${preview!.blockedProjectName}. Delete the project first.';
                  final refusal = reason ?? blockedReason;
                  final enabled =
                      permitted &&
                      reason == null &&
                      blockedReason == null &&
                      (preview != null || checking) &&
                      !busy &&
                      !c.saving &&
                      (checking || !c.hasPendingAction);
                  return PopScope(
                    canPop: !busy,
                    child: AlertDialog(
                      title: Text(
                        available
                            ? 'Remove $name from this Swarm?'
                            : 'Machine unavailable',
                      ),
                      content: SizedBox(
                        width: 400,
                        child: SingleChildScrollView(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (refusal != null)
                                Text(refusal)
                              else if (!available || !permitted)
                                const Text(
                                  'This action is no longer available.',
                                )
                              else if (previewState.hasError)
                                Text(switch (previewState.error) {
                                  SuperTabFailure failure => failure.message,
                                  _ => 'Could not check this machine.',
                                })
                              else if (preview == null)
                                const Text('Checking what will happen…')
                              else ...[
                                const Text(
                                  'The Swarm stops using this machine for new work.',
                                ),
                                if (preview.agents.isNotEmpty) ...[
                                  const SizedBox(height: 12),
                                  const Text('These agents will stop:'),
                                  for (final agent in preview.agents) ...[
                                    const SizedBox(height: 4),
                                    Text(
                                      '${agent.name} · ${agent.projectName}',
                                    ),
                                    if (agent.task != null)
                                      Text(
                                        'The open task “${agent.task}” loses its agent.',
                                      ),
                                  ],
                                ],
                                if (preview.soleSourceProjects.isNotEmpty) ...[
                                  const SizedBox(height: 12),
                                  const Text(
                                    'These projects have code only on this machine:',
                                  ),
                                  for (final project
                                      in preview.soleSourceProjects)
                                    Text(project),
                                ],
                                const SizedBox(height: 12),
                                const Text(
                                  'The Swarm folders on this machine will be deleted, including uncommitted or unpushed work.',
                                ),
                              ],
                              if (attempted && c.operationError != null) ...[
                                const SizedBox(height: 12),
                                Text(c.operationError!),
                              ],
                            ],
                          ),
                        ),
                      ),
                      actions: [
                        TextButton(
                          autofocus: true,
                          onPressed: busy ? null : () => Navigator.pop(context),
                          child: Text(
                            checking || !available || !permitted
                                ? 'Close'
                                : 'Cancel',
                          ),
                        ),
                        if (available && permitted)
                          FilledButton(
                            key: const ValueKey('super-machine-remove-confirm'),
                            style: grid.dangerButtonStyle(),
                            onPressed: !enabled
                                ? null
                                : () async {
                                    update(() {
                                      busy = true;
                                      attempted = true;
                                    });
                                    final result = checking
                                        ? await c.retry()
                                        : await c.command({
                                            'type': 'machine.remove',
                                            'machineId': id,
                                          });
                                    if (!context.mounted) return;
                                    if (result != null) {
                                      Navigator.pop(context);
                                      _changed();
                                    } else {
                                      update(() => busy = false);
                                    }
                                  },
                            child: Text(
                              checking ? 'Retry' : 'Remove from Swarm',
                            ),
                          ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }

  /// A machine row's right-click: its details, and Remove from Swarm for whoever may.
  Future<void> _menu(_MachineView view, Offset at) async {
    final choice = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(at.dx, at.dy, at.dx, at.dy),
      items: [
        const PopupMenuItem(value: 'details', child: Text('Details')),
        if (_canRemove(view.id))
          PopupMenuItem(
            key: ValueKey('super-machine-menu-remove'),
            value: 'remove',
            enabled: _removeReason(view.id) == null,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Remove from Swarm'),
                if (_removeReason(view.id) case final reason?) Text(reason),
              ],
            ),
          ),
      ],
    );
    if (!mounted) return;
    if (choice == 'details') await _openDetails(view);
    if (choice == 'remove' &&
        _canRemove(view.id) &&
        _removeReason(view.id) == null) {
      await _remove(view);
    }
  }

  Future<void> _details(_MachineView v) {
    final id = v.id, name = v.name, person = v.owner, shared = v.shared;
    final contributor = v.contributor, paused = v.paused, dim = v.dim;
    final details = v.details, value = v.resources, allowed = v.engines;
    final accounts = v.accounts;
    return showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        requireWrite: false,
        child: ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            final removeReason = _removeReason(id);
            Future<void> pause() async {
              final result = await c.command({
                'type': 'machine.pause',
                'machineId': id,
                'paused': !paused,
              });
              if (context.mounted && result != null) Navigator.pop(context);
            }

            void attach() {
              final group = c.selected!;
              Navigator.pop(context);
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted) widget.onAddAgent(group);
              });
            }

            return SuperTabDetailDialog(
              title: superTabMachineName(name),
              headerActions: [
                // Out of the way of the everyday actions below: a quiet mark that turns red when pointed at, and says
                // why on hover when it cannot.
                if (_canRemove(id))
                  AppIconButton(
                    key: const ValueKey('super-machine-remove'),
                    icon: AppIcons.trash2,
                    tooltip: removeReason ?? 'Remove from Swarm',
                    color: DesktopChrome.muted,
                    destructive: true,
                    onPressed: removeReason != null
                        ? null
                        : () {
                            if (_removeReason(id) != null) return;
                            Navigator.pop(context);
                            WidgetsBinding.instance.addPostFrameCallback((_) {
                              if (mounted) unawaited(_remove(v));
                            });
                          },
                  ),
              ],
              body: SuperTabMachineDetails(
                name: name,
                owner: person?.username,
                status: details,
                // Details follow the same freshness rule as the row and its disclosure.
                resources: dim ? null : value,
                engines: allowed,
                accounts: dim ? const [] : accounts,
                footer: SuperTabMachineLocalModels(
                  controller: c,
                  machineId: id,
                  now: widget.now,
                ),
              ),
              // One clear action at the right; the rarer ones quiet at the left (Ken, 2026-10-28).
              leadingActions: [
                if (shared != null && contributor == c.accountId)
                  TextButton(
                    style: superTabQuietAction,
                    onPressed: () => unawaited(pause()),
                    child: Text(paused ? 'Resume new work' : 'Pause new work'),
                  ),
                if (c.canWrite && c.selected != null)
                  TextButton(
                    style: superTabQuietAction,
                    onPressed: attach,
                    child: const Text('Attach running agent'),
                  ),
              ],
              actions: [
                if (contributor == c.accountId)
                  TextButton(
                    onPressed: () {
                      Navigator.pop(context);
                      unawaited(
                        _settings(
                          existing: shared ?? {'machineId': id},
                          view: v,
                        ),
                      );
                    },
                    child: const Text('Configure'),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<void> _openDetails(_MachineView view) async {
    setState(() => _selectedMachineId = view.id);
    try {
      await _details(view);
    } finally {
      if (mounted) setState(() => _selectedMachineId = null);
    }
  }

  Widget _machine(_MachineView view) {
    final tipKey = _tips.putIfAbsent(view.id, GlobalKey<TooltipState>.new);
    final expanded = c.isMachineExpanded(view.id);
    final selected = _selectedMachineId == view.id;
    final row = Material(
      color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      // No chevron (Dee, 2026-10-27): a click expands the machine, and its
      // details are in the right-click menu, or a long press on a touch screen.
      child: InkWell(
        key: ValueKey('super-machine-${view.id}'),
        onTap: () {
          c.toggleMachineExpanded(view.id);
          _changed();
        },
        onLongPress: () => unawaited(_openDetails(view)),
        onSecondaryTapUp: (event) =>
            unawaited(_menu(view, event.globalPosition)),
        hoverColor: grid.AppSurface.hoverFill,
        focusColor: grid.AppSurface.hoverFill,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        onFocusChange: (focused) {
          if (focused &&
              FocusManager.instance.highlightMode ==
                  FocusHighlightMode.traditional) {
            tipKey.currentState?.ensureTooltipVisible();
          } else if (!focused) {
            Tooltip.dismissAllToolTips();
          }
        },
        child: Semantics(
          expanded: expanded,
          child: _MachineLine(
            view: view,
            onSetUpTeam: view.setUpTeam
                ? () async {
                    await showTeamAccountSetup(context, widget.app!);
                    await _readTeamSetup();
                  }
                : null,
          ),
        ),
      ),
    );
    return Column(
      key: ValueKey('super-machine-entry-${view.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: Semantics(
            container: true,
            selected: selected,
            label: [
              superTabMachineName(view.name),
              view.cleaning
                  ? 'Cleaning up'
                  : superTabMachineStateLabel(view.status),
              ?view.problem,
              if (view.tip.isNotEmpty) view.tip,
            ].join(', '),
            child: Tooltip(
              key: tipKey,
              message: view.tip.isEmpty
                  ? superTabMachineStateLabel(view.status)
                  : view.tip,
              excludeFromSemantics: true,
              child: row,
            ),
          ),
        ),
        if (expanded) ...[
          if (view.agents.isNotEmpty) _agentCount(view),
          _MachineReadings(view: view),
          if (view.agents.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(36, 4, 32, 8),
              child: Text(
                view.status == SuperTabMachineStatus.offline
                    ? 'Offline'
                    : view.status == SuperTabMachineStatus.unknown
                    ? "Can't reach Harness"
                    : view.status == SuperTabMachineStatus.refreshing
                    ? 'Refreshing…'
                    : 'No agents yet',
                style: DesktopChrome.metadata(),
              ),
            ),
        ],
      ],
    );
  }

  HarnessActivity _activity(_MachineView view, SuperTabAgent agent) {
    final app = widget.app;
    final native = app == null
        ? null
        : harnessActivity(app, agent.machineId, agent.harnessId);
    if (native == HarnessActivity.offline ||
        native == HarnessActivity.paused ||
        native == HarnessActivity.starting ||
        native == HarnessActivity.failed ||
        native == HarnessActivity.needsInput) {
      return native!;
    }
    // A direct session is better evidence than a missing capacity sample.
    // When no native lifecycle is available, stale remote work cannot imply
    // that an offline machine is still waiting for input.
    if (native == null || native == HarnessActivity.unknown) {
      if (view.status == SuperTabMachineStatus.offline) {
        return HarnessActivity.offline;
      }
      if (view.status == SuperTabMachineStatus.unknown) {
        return HarnessActivity.unknown;
      }
    }
    if (c.snapshot?.conversations.any(
          (group) =>
              !group.closed &&
              group.assignment?['agentId'] == agent.id &&
              superTabWorkWaits(group.assignment?['status']),
        ) ==
        true) {
      return HarnessActivity.needsInput;
    }
    return native ?? HarnessActivity.unknown;
  }

  /// One line for all of [view]'s agents, however many: a busy machine is not a
  /// screen of rows. The list opens over the sidebar, grouped by what each is doing.
  Widget _agentCount(_MachineView view) {
    final count = view.agents.length;
    final label = count == 1 ? '1 agent' : '$count agents';
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth.clamp(240.0, 320.0);
        return MenuAnchor(
          consumeOutsideTap: true,
          alignmentOffset: const Offset(0, grid.AppControl.menuGap),
          style: grid.AppMenu.style(minWidth: width, maxWidth: width),
          menuChildren: [
            KeyedSubtree(
              key: ValueKey('super-machine-agent-list-${view.id}'),
              child: SizedBox(
                width: width,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: _agentGroups(view),
                ),
              ),
            ),
          ],
          builder: (context, menu, _) => Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              key: ValueKey('super-machine-agents-${view.id}'),
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              hoverColor: grid.AppSurface.hoverFill,
              focusColor: grid.AppSurface.hoverFill,
              onTap: () => menu.isOpen ? menu.close() : menu.open(),
              child: Semantics(
                button: true,
                expanded: menu.isOpen,
                label: label,
                hint: 'Shows this machine’s agents',
                excludeSemantics: true,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 32),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(36, 6, 10, 6),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.control(),
                          ),
                        ),
                        Icon(
                          AppIcons.chevronRight,
                          size: grid.AppControl.iconSize,
                          color: DesktopChrome.muted,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  /// [view]'s agents under Working, Waiting and Idle, each by name; a group with none is left out.
  List<Widget> _agentGroups(_MachineView view) {
    final groups = <String, List<(SuperTabAgent, HarnessActivity)>>{
      'Working': [],
      'Waiting': [],
      'Idle': [],
    };
    for (final agent in view.agents) {
      final activity = _activity(view, agent);
      groups[switch (activity) {
            HarnessActivity.working || HarnessActivity.starting => 'Working',
            HarnessActivity.needsInput || HarnessActivity.failed => 'Waiting',
            _ => 'Idle',
          }]!
          .add((agent, activity));
    }
    final snapshot = c.snapshot!;
    return [
      for (final MapEntry(key: title, value: members) in groups.entries)
        if (members.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            child: Text(
              title,
              style: DesktopChrome.text(
                size: 11,
                medium: true,
                height: 1.3,
                color: DesktopChrome.muted,
              ).copyWith(fontWeight: FontWeight.w600),
            ),
          ),
          for (final (agent, activity)
              in members..sort(
                (a, b) => snapshot
                    .agentName(a.$1.id)
                    .toLowerCase()
                    .compareTo(snapshot.agentName(b.$1.id).toLowerCase()),
              ))
            _agent(view, agent, activity),
        ],
    ];
  }

  Widget _agent(
    _MachineView view,
    SuperTabAgent agent,
    HarnessActivity activity,
  ) {
    final name = c.snapshot!.agentName(agent.id);
    final (name: role, :badge) =
        c.snapshot!.roleOf(agent.id) ?? (name: 'Engineer', badge: 'Dev');
    final info = SuperTabAgentInfo(c, widget.app, agent, activity: activity);
    final theme = terminalThemeFor(
      grid.AppTheme.surfacePalette,
      terminalThemeStore.value,
    );
    return Tooltip(
      message: info.tooltip,
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: Builder(
          builder: (context) => InkWell(
            key: ValueKey('super-machine-agent-${view.id}-${agent.id}'),
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            hoverColor: grid.AppSurface.hoverFill,
            focusColor: grid.AppSurface.hoverFill,
            onTap: widget.onOpenAgent == null
                ? null
                : () {
                    MenuController.maybeOf(context)?.close();
                    final current = c.snapshot?.agent(agent.id);
                    if (current != null) widget.onOpenAgent!(current);
                  },
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 36),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    const SizedBox(width: 12),
                    Expanded(
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: DesktopChrome.control(),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Semantics(
                            label: role,
                            excludeSemantics: true,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 5,
                                vertical: 1,
                              ),
                              decoration: BoxDecoration(
                                color: grid.AppSurface.hoverFill,
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                badge,
                                style: DesktopChrome.metadata(),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    SizedBox(
                      width: 32,
                      child: Center(
                        child: ActivityMark(
                          activity: activity,
                          color: activityColor(
                            activity,
                            theme,
                            color: appearancePrefsStore.value.prompt.color,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Keep offline machines in the same list and on the same columns.
  List<Widget> _machines() {
    final views = [for (final id in _rowIds) _view(id)];
    String key(_MachineView view) =>
        superTabMachineName(view.name).toLowerCase();
    int rank(_MachineView view) => switch (view.status) {
      SuperTabMachineStatus.unknown => 1,
      SuperTabMachineStatus.offline => 2,
      _ => 0,
    };
    views.sort(
      (a, b) => rank(a) != rank(b)
          ? rank(a) - rank(b)
          : key(a) != key(b)
          ? key(a).compareTo(key(b))
          : a.id.compareTo(b.id),
    );
    return [for (final view in views) _machine(view)];
  }

  @override
  Widget build(BuildContext context) {
    final failingSince = c.backendUnreachable ? c.unreachableSince : null;
    final children = [
      SuperTabSectionHeading(
        'Machines',
        onAdd: c.canWrite && widget.app != null
            ? () => unawaited(
                showAddComputers(
                  context,
                  c,
                  widget.app!,
                  readResources: widget.readLocal,
                ),
              )
            : null,
        addTooltip: 'Add machine',
        // Only a Swarm that can't be read is news; a live one says nothing.
        trailing: c.backendUnreachable
            ? SuperTabMachinesPill(
                reconnectingFor: failingSince == null
                    ? Duration.zero
                    : widget.now().difference(failingSince),
              )
            : null,
        endInset: widget.embedded ? 0 : 12,
        collapsed: widget.onToggleCollapsed == null ? null : widget.collapsed,
        onToggleCollapsed: widget.onToggleCollapsed,
      ),
      if (!widget.collapsed) ...[
        if (_ids.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(36, 8, 16, 16),
            child: Text(
              "Add a machine for this Swarm's agents to use.",
              style: DesktopChrome.metadata(),
            ),
          )
        else
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: _machines(),
          ),
      ],
    ];
    return widget.embedded
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: children,
          )
        : ListView(children: children);
  }
}

/// The server's removal preview is authoritative for the confirmation.
class _RemovalPreview {
  const _RemovalPreview({
    required this.blockedProjectName,
    this.blockedProjectId,
    required this.agents,
    required this.soleSourceProjects,
  });

  factory _RemovalPreview.fromMap(Map<String, dynamic> value) {
    if (value['agents'] is! List || value['soleSourceProjects'] is! List) {
      throw const FormatException('Invalid machine removal preview');
    }
    final blocked = value['blockedBy'];
    if (blocked != null && blocked is! Map) {
      throw const FormatException('Invalid machine removal preview');
    }
    final blockedName = blocked == null
        ? null
        : superTabMap(blocked)['projectName'];
    if (blocked != null && (blockedName is! String || blockedName.isEmpty)) {
      throw const FormatException('Invalid machine removal preview');
    }
    final agents = <_RemovalAgent>[];
    for (final item in value['agents'] as List) {
      final agent = superTabMap(item);
      final name = agent['name'], projectName = agent['projectName'];
      final task = agent['task'];
      if (name is! String ||
          name.isEmpty ||
          projectName is! String ||
          projectName.isEmpty ||
          (task != null && task is! String)) {
        throw const FormatException('Invalid machine removal preview');
      }
      agents.add(_RemovalAgent(name, projectName, task as String?));
    }
    final projects = <String>[];
    for (final item in value['soleSourceProjects'] as List) {
      final name = superTabMap(item)['name'];
      if (name is! String || name.isEmpty) {
        throw const FormatException('Invalid machine removal preview');
      }
      projects.add(name);
    }
    return _RemovalPreview(
      blockedProjectName: blockedName as String?,
      blockedProjectId: switch (blocked) {
        {'projectId': final String id} => id,
        _ => null,
      },
      agents: agents,
      soleSourceProjects: projects,
    );
  }

  final String? blockedProjectName;

  /// The project whose coordinator runs there, to call it what that project calls it.
  final String? blockedProjectId;
  final List<_RemovalAgent> agents;
  final List<String> soleSourceProjects;
}

class _RemovalAgent {
  const _RemovalAgent(this.name, this.projectName, this.task);
  final String name, projectName;
  final String? task;
}

/// What [_SuperTabMachinesState._view] read of one machine.
class _MachineView {
  const _MachineView({
    required this.id,
    required this.name,
    required this.owner,
    required this.contributor,
    required this.shared,
    required this.agents,
    required this.status,
    required this.readingAt,
    required this.arrived,
    required this.paused,
    required this.cleaning,
    required this.dim,
    required this.details,
    required this.resources,
    required this.accounts,
    required this.engines,
    required this.allowances,
    required this.subscriptionsAside,
    required this.tip,
    this.problem,
    this.setUpTeam = false,
    this.apiModels = const [],
    this.localModels = const [],
  });

  final String id, name, details, tip;

  /// Its [problem] is this Mac's, its own person looking: no Harness Team account yet, which they can set up here.
  final bool setUpTeam;

  /// Its one line when teammates' agents cannot run there ([superTabTeammatesPaused]); null otherwise.
  final String? problem;
  final SuperTabPerson? owner;
  final String? contributor;
  final Map<String, dynamic>? shared;
  final List<SuperTabAgent> agents;
  final SuperTabMachineStatus status;

  /// When the reading shown was taken, and whether that is just now (the dot pings once).
  final DateTime? readingAt;
  final bool arrived, paused, cleaning;

  /// Offline, unknown or refreshing: its numbers are old.
  final bool dim;
  final MachineResources? resources;
  final List<Map<String, Object?>> accounts;
  final List<String>? engines;

  /// What the row's chips show, Claude first; empty while offline or out of reach.
  final List<_Allowance> allowances;

  /// Beside the Subscriptions heading: `left now`, or `offline, read 2 h ago` over the last figures.
  final String subscriptionsAside;

  /// What this machine offers the Swarm on its grid, as its reading says: the APIs its person shares, and its own
  /// models running for the Swarm (docs/plans/2026-10-23-swarm-local-models.md). Empty while the add-on is off.
  final List<_ServedModel> apiModels, localModels;
}

/// A model a machine offers its Swarm: its short name on the row, the whole of it on hover.
/// [starting]: run or shared here, not yet listed by the Swarm's grid (CLI `superTabs/machines.ts`).
typedef _ServedModel = ({String name, String tip, bool starting});

/// An allowance's note, from its detail lines: the window that stops work first, and its reset. Another machine's
/// lines put that window first (`5-hour: 44% remaining · resets in 2h 10m`); this computer's name it
/// (`Limiting window: 5-hour`) and list each window as `5-hour — 44% remaining · resets in 2h 10m`.
String? superMachineAllowanceNote(Iterable<String> lines) {
  const limiting = 'Limiting window: ', resets = ' · resets in ';
  final named = lines
      .where((line) => line.startsWith(limiting))
      .firstOrNull
      ?.substring(limiting.length);
  final String window;
  final String? line;
  if (named != null) {
    window = named;
    line = lines.where((l) => l.startsWith('$named — ')).firstOrNull;
  } else {
    final first = lines.firstOrNull;
    if (first == null || !first.contains(': ')) return null;
    window = first.substring(0, first.indexOf(': '));
    line = first;
  }
  return [
    '$window limit',
    if (line != null && line.contains(resets))
      line.substring(line.indexOf(resets) + 3),
  ].join(' · ');
}

/// A machine row's line when teammates' agents cannot run there, from the Swarm's refusal code (backend
/// superTabs/machines.ts `teamWorkRefusal`); null for a code this build does not know.
String? superTabTeammatesPaused(Object? code) {
  final why = switch (code) {
    'MACHINE_OFFLINE' => 'Harness Team account offline',
    'TEAM_ACCOUNT_REQUIRED' => 'not set up',
    'PRIVACY_UNCHECKED' => 'privacy not checked yet',
    'PRIVACY_CHECK_FAILED' => 'privacy check failed',
    'PRIVACY_CHECK_STALE' => 'privacy check out of date',
    _ => null,
  };
  return why == null ? null : "Teammates' agents paused: $why";
}

/// This Mac's own row, for its person, when its daemon remembers why it has no Harness Team account
/// (cli/src/team/autoSetup.ts `status`); null when it does not, and the Swarm's own line stands.
String? superTabTeamSetupLine(({String state, String? detail})? setup) {
  final detail = setup?.detail?.trim().replaceFirst(RegExp(r'[.]+$'), '');
  final why = switch (setup?.state) {
    'declined' => 'setup was cancelled',
    'failed' when detail != null && detail.isNotEmpty =>
      'setup failed: $detail',
    'failed' => 'setup failed',
    'running' => 'setting up',
    _ => null,
  };
  return why == null ? null : "Teammates' agents paused: $why";
}

/// One engine's allowance on a machine: its mark and remaining share on the row, its windows on hover.
class _Allowance {
  const _Allowance({
    required this.engine,
    required this.name,
    required this.figure,
    required this.left,
    required this.detail,
    this.note,
    this.stale = false,
    this.struck,
    this.notice,
  });

  final String engine, name, figure, detail;

  /// The window that stops work first and when it resets (`5-hour limit · resets in 2h 10m`), under the figure; or
  /// why there is no figure ([superMachineAllowanceReason]).
  final String? note;

  /// The share left, 0–100; null when there is no figure.
  final double? left;

  /// Why new work does not go to this engine here (the server suspended it after failed starts), shown on hover
  /// with its name struck through; null when it takes work.
  final String? struck;

  /// A fact said on hover, never struck: no quota left until it resets. Quota makes no machine unusable.
  final String? notice;

  /// The last figure an offline machine read: shown muted, never as now.
  final bool stale;

  /// The tone of what is left: amber below 20%, red below 10%; none for an old or missing figure.
  Color? get tone => left == null || stale
      ? null
      : left! < 10
      ? grid.AppPalette.usageCritical
      : left! < 20
      ? grid.AppPalette.usageLow
      : null;

  /// The figure's ink: its tone, muted when old or missing, otherwise the reading's own ink.
  Color get ink => statusLineInkOnSurface(
    tone ??
        (left == null || stale
            ? DesktopChrome.muted
            : DesktopChrome.foreground),
    DesktopChrome.surface,
  );
}

/// What hovering an engine with no quota left on a machine says: a fact, never a refusal.
const _noQuotaLeft = 'No quota left until it resets.';

/// The same leading icon/name and trailing status column as projects.
class _MachineLine extends StatelessWidget {
  const _MachineLine({required this.view, this.onSetUpTeam});

  final _MachineView view;

  /// This Mac's row, without its Harness Team account: Set up under the paused line.
  final VoidCallback? onSetUpTeam;

  @override
  Widget build(BuildContext context) {
    final muted =
        view.status == SuperTabMachineStatus.offline ||
        view.status == SuperTabMachineStatus.unknown;
    final name = superTabMachineName(view.name);
    final owner = view.owner;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 36),
      child: Row(
        children: [
          const SizedBox(width: 4),
          // A machine leads with what it is, a MacBook, a Mac Studio, beside
          // the sidebar's "# project" channels; dimmed with its name.
          SizedBox(
            width: 32,
            child: Center(
              child: SuperTabMachineIcon(
                deviceType: view.resources?.deviceType,
                color: muted ? DesktopChrome.muted : DesktopChrome.foreground,
              ),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final style = DesktopChrome.control(
                    color: muted
                        ? DesktopChrome.muted
                        : DesktopChrome.foreground,
                  );
                  final text = Text(
                    name,
                    key: ValueKey('super-machine-name-${view.id}'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: style,
                  );
                  final painter = TextPainter(
                    text: TextSpan(text: name, style: style),
                    textDirection: Directionality.of(context),
                    textScaler: MediaQuery.textScalerOf(context),
                    maxLines: 1,
                  )..layout(maxWidth: constraints.maxWidth);
                  final truncated = painter.didExceedMaxLines;
                  painter.dispose();
                  final title = truncated
                      ? Tooltip(
                          message: [
                            name,
                            if (view.tip.isNotEmpty) view.tip,
                          ].join('\n'),
                          excludeFromSemantics: true,
                          child: text,
                        )
                      : text;
                  final problem = view.problem;
                  if (problem == null) return title;
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      title,
                      Text(
                        problem,
                        key: ValueKey('super-machine-problem-${view.id}'),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.metadata(),
                      ),
                      if (onSetUpTeam != null)
                        TextButton(
                          key: ValueKey('super-machine-team-setup-${view.id}'),
                          onPressed: onSetUpTeam,
                          style: TextButton.styleFrom(
                            padding: EdgeInsets.zero,
                            minimumSize: const Size(0, 22),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            alignment: Alignment.centerLeft,
                          ),
                          child: const Text('Set up'),
                        ),
                    ],
                  );
                },
              ),
            ),
          ),
          if (owner != null)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Tooltip(
                message: 'Owned by ${owner.username}',
                child: SuperTabAvatar.person(owner, size: 20),
              ),
            ),
          if (view.cleaning)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Text('Cleaning up', style: DesktopChrome.metadata()),
            ),
          SizedBox(
            width: 32,
            child: Center(
              child: KeyedSubtree(
                key: ValueKey(
                  'super-machine-state-${view.id}-${view.status.name}',
                ),
                child: SuperTabMachineDot(
                  status: view.status,
                  readingAt: view.readingAt,
                  arrived: view.arrived,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The expanded reading block wraps complete values, without filling missing slots.
class _MachineReadings extends StatelessWidget {
  const _MachineReadings({required this.view});
  final _MachineView view;

  /// A share used, as a bar's tone: amber from 85%, red from 95%, else the reading's own quiet ink.
  static Color? _tone(double? used) => used == null
      ? null
      : used >= .95
      ? grid.AppPalette.usageCritical
      : used >= .85
      ? grid.AppPalette.usageLow
      : null;

  @override
  Widget build(BuildContext context) {
    // Offline or out of reach, only Subscriptions shows: the last figures, said to be old.
    final resources = view.dim ? null : view.resources;
    final memoryTotal = resources?.memoryTotalBytes;
    final memoryFree = memoryTotal == null || resources?.memoryUsedBytes == null
        ? null
        : (memoryTotal - resources!.memoryUsedBytes!).clamp(0, memoryTotal);
    final diskFree = resources?.projectDiskTotalBytes == null
        ? resources?.diskFreeBytes
        : resources?.projectDiskFreeBytes;
    final diskTotal =
        resources?.projectDiskTotalBytes ?? resources?.diskTotalBytes;
    final gpu = resources?.busiestGpu?.utilizationPercent;
    // What is in use as a share, for the bar; RAM and SSD say what is free, as the row's tooltip does.
    final hardware = <_Reading>[
      if (resources?.cpuPercent case final cpu?)
        (
          name: 'CPU',
          value: resourcePercent(cpu),
          used: (cpu / 100).clamp(0, 1).toDouble(),
          note: 'in use',
          meaning: 'CPU utilization',
        ),
      if (gpu != null)
        (
          name: 'GPU',
          value: resourcePercent(gpu),
          used: (gpu / 100).clamp(0, 1).toDouble(),
          note: 'in use',
          meaning: 'GPU utilization',
        ),
      if (memoryFree != null)
        (
          name: 'RAM',
          value: resourceBytes(memoryFree.toDouble()),
          used: memoryTotal! > 0 ? 1 - memoryFree / memoryTotal : null,
          note: 'free of ${resourceBytes(memoryTotal)}',
          meaning: 'Memory available',
        ),
      if (diskFree != null)
        (
          name: 'SSD',
          value: resourceBytes(diskFree),
          used: diskTotal != null && diskTotal > 0
              ? (1 - diskFree / diskTotal).clamp(0, 1).toDouble()
              : null,
          note: diskTotal == null
              ? 'free'
              : 'free of ${resourceBytes(diskTotal)}',
          meaning: 'Storage available',
        ),
    ];
    final sections = <(String, String?, Widget Function(double))>[
      if (hardware.isNotEmpty)
        (
          'Hardware',
          null,
          (width) => _grid(width, width >= 300 ? 4 : 2, [
            for (final reading in hardware) _hardware(reading),
          ]),
        ),
      (
        'Subscriptions',
        view.allowances.isEmpty ? null : view.subscriptionsAside,
        (width) => view.allowances.isEmpty
            ? Text(
                'No Claude or Codex allowance reported for this machine',
                style: DesktopChrome.text(
                  size: 11,
                  height: 1.3,
                  color: DesktopChrome.muted,
                ),
              )
            : _grid(width, width >= 260 ? 2 : 1, [
                for (final allowance in view.allowances) _allowance(allowance),
              ]),
      ),
      if (!view.dim &&
          (view.apiModels.isNotEmpty || view.localModels.isNotEmpty))
        (
          'Models for the Swarm',
          null,
          (_) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (view.apiModels.isNotEmpty)
                _models(AppIcons.cloud, 'API', view.apiModels, 'api'),
              if (view.apiModels.isNotEmpty && view.localModels.isNotEmpty)
                const SizedBox(height: 6),
              if (view.localModels.isNotEmpty)
                _models(AppIcons.cpu, 'Local', view.localModels, 'local'),
            ],
          ),
        ),
    ];
    return Padding(
      key: ValueKey('super-machine-readings-${view.id}'),
      padding: const EdgeInsets.fromLTRB(10, 4, 10, 12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: DesktopChrome.foreground.withValues(alpha: .035),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: DesktopChrome.rim),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: LayoutBuilder(
            builder: (context, constraints) {
              // Large text keeps the narrow arrangement: fewer, wider columns.
              final width = MediaQuery.textScalerOf(context).scale(12) > 16
                  ? constraints.maxWidth / 2
                  : constraints.maxWidth;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final (index, (title, aside, body))
                      in sections.indexed) ...[
                    if (index > 0) const SizedBox(height: 14),
                    Text.rich(
                      TextSpan(
                        text: title,
                        children: [
                          if (aside != null)
                            TextSpan(
                              text: ' · $aside',
                              style: DesktopChrome.text(
                                size: 11,
                                height: 1.3,
                                color: DesktopChrome.muted,
                              ),
                            ),
                        ],
                      ),
                      style: DesktopChrome.text(
                        size: 11,
                        medium: true,
                        height: 1.3,
                        color: DesktopChrome.muted,
                      ).copyWith(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 8),
                    body(width),
                  ],
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  /// [children] in [columns] equal columns, wrapping into rows.
  static Widget _grid(double width, int columns, List<Widget> children) =>
      LayoutBuilder(
        builder: (context, constraints) {
          const gap = 8.0;
          final cell = (constraints.maxWidth - gap * (columns - 1)) / columns;
          return Wrap(
            spacing: gap,
            runSpacing: 10,
            children: [
              for (final child in children) SizedBox(width: cell, child: child),
            ],
          );
        },
      );

  Widget _hardware(_Reading reading) {
    final tone = _tone(reading.used);
    final ink = tone == null
        ? DesktopChrome.foreground
        : statusLineInkOnSurface(tone, DesktopChrome.surface);
    return Tooltip(
      message: reading.meaning,
      child: Semantics(
        label: '${reading.name} ${reading.value} ${reading.note}',
        excludeSemantics: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  reading.name,
                  style: DesktopChrome.text(
                    size: 11,
                    height: 1.3,
                    color: DesktopChrome.muted,
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    reading.value,
                    key: ValueKey(
                      'super-machine-hw-${view.id}-${reading.name}',
                    ),
                    textAlign: TextAlign.right,
                    maxLines: 1,
                    overflow: TextOverflow.fade,
                    softWrap: false,
                    style:
                        DesktopChrome.text(
                          size: 12,
                          medium: true,
                          height: 1.3,
                          color: ink,
                        ).copyWith(
                          fontWeight: FontWeight.w600,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 5),
            _Meter(share: reading.used ?? 0, tone: tone),
            const SizedBox(height: 4),
            Text(
              reading.note,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.text(
                size: 10,
                height: 1.2,
                color: DesktopChrome.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _allowance(_Allowance allowance) {
    final left = allowance.left;
    final struck = allowance.struck;
    final said = struck ?? allowance.notice;
    return Tooltip(
      message: [
        ?said,
        if (allowance.detail.isNotEmpty) allowance.detail,
      ].join('\n\n'),
      child: Semantics(
        label:
            (left == null
                ? '${allowance.name}: ${allowance.note}'
                : '${allowance.name} ${allowance.figure} remaining') +
            (said == null ? '' : '. $said'),
        excludeSemantics: true,
        child: Container(
          key: ValueKey(
            'super-machine-allowance-${view.id}-${allowance.engine}',
          ),
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
          decoration: BoxDecoration(
            color: DesktopChrome.foreground.withValues(alpha: .045),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  EngineMark(engine: allowance.engine, size: 14),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      allowance.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.text(size: 12, height: 1.3).copyWith(
                        decoration: struck == null
                            ? null
                            : TextDecoration.lineThrough,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    allowance.figure,
                    key: ValueKey(
                      'super-machine-figure-${view.id}-${allowance.engine}',
                    ),
                    style:
                        DesktopChrome.text(
                          size: 12,
                          medium: true,
                          height: 1.3,
                          color: allowance.ink,
                        ).copyWith(
                          fontWeight: FontWeight.w600,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              // The bar is what is left, as the figure is; none without a figure.
              if (left != null) _Meter(share: left / 100, tone: allowance.tone),
              if (allowance.note case final note?) ...[
                const SizedBox(height: 5),
                Text(
                  note,
                  maxLines: left == null ? 2 : 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.text(
                    size: 10,
                    height: 1.2,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// A kind's label, then its models as chips: a long dashed name reads as one name inside its own chip.
  Widget _models(
    IconData icon,
    String label,
    List<_ServedModel> models,
    String kind,
  ) {
    final local = kind == 'local';
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 52,
          height: 22,
          child: Row(
            children: [
              Icon(icon, size: 12, color: DesktopChrome.muted),
              const SizedBox(width: 4),
              Text(
                label,
                style: DesktopChrome.text(
                  size: 11,
                  height: 1.3,
                  color: DesktopChrome.muted,
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final model in models)
                Tooltip(
                  message: model.tip,
                  child: Container(
                    height: 22,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(
                      color: local && !model.starting
                          ? grid.AppPalette.online.withValues(alpha: .13)
                          : DesktopChrome.foreground.withValues(alpha: .06),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (local || model.starting) ...[
                          Container(
                            width: 5,
                            height: 5,
                            decoration: BoxDecoration(
                              color: model.starting
                                  ? DesktopChrome.muted
                                  : grid.AppPalette.online,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 5),
                        ],
                        Flexible(
                          child: Text(
                            model.name,
                            key: ValueKey(
                              'super-machine-$kind-${view.id}-${model.name}',
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: grid.AppType.monoMeta(
                              color: model.starting
                                  ? DesktopChrome.muted
                                  : DesktopChrome.foreground,
                            ),
                          ),
                        ),
                        if (model.starting) ...[
                          const SizedBox(width: 5),
                          Text(
                            'starting…',
                            style: DesktopChrome.text(
                              size: 11,
                              height: 1.3,
                              color: DesktopChrome.muted,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// One hardware reading of a machine: its name and value, the share in use, and a word on what the value is.
typedef _Reading = ({
  String name,
  String value,
  double? used,
  String note,
  String meaning,
});

/// A thin bar: [share] of it filled, in [tone] when it warns.
class _Meter extends StatelessWidget {
  const _Meter({required this.share, this.tone});

  final double share;
  final Color? tone;

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(2),
    child: SizedBox(
      height: 4,
      child: Stack(
        fit: StackFit.expand,
        children: [
          ColoredBox(color: DesktopChrome.foreground.withValues(alpha: .09)),
          FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: share.clamp(0, 1),
            child: ColoredBox(
              color: tone ?? DesktopChrome.foreground.withValues(alpha: .72),
            ),
          ),
        ],
      ),
    ),
  );
}
