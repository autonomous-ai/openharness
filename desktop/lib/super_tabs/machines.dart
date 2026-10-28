import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/status_line_style.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../usage/models_menu_controller.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/harness_activity_mark.dart';
import '../widgets/workspace_subscription_usage.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'local_models.dart';
import '../models/swarm_models_target.dart' show swarmSharedWithYouShown;
import 'machine_details.dart';
import 'machine_status.dart';
import 'model.dart';
import 'team_account_setup.dart';
import 'section_heading.dart';

export 'machine_status.dart';

/// The backend's upper bound. A machine's own total RAM may set a lower one.
const _agentSlotsMin = 1;
const _agentSlotsMax = 16;

/// What one more agent needs to start, the CLI's own figure
/// (`START_REQUIREMENTS.memoryBytes`, `cli/src/superTabs/capacity.ts`).
const _agentMemoryBytes = 2 * 1024 * 1024 * 1024;

int _clampAgentSlots(num value) =>
    value.toInt().clamp(_agentSlotsMin, _agentSlotsMax);

/// The machine's total-RAM limit and its half-sized starting suggestion.
/// The suggestion is capped separately, so 64 GiB suggests 16 of 16 slots.
int? _maxAgentSlots(MachineResources? resources) {
  final total = resources?.memoryTotalBytes;
  if (total == null) return null;
  return _clampAgentSlots((total / _agentMemoryBytes).floor());
}

int? _suggestedAgentSlots(MachineResources? resources) {
  final total = resources?.memoryTotalBytes;
  if (total == null) return null;
  return _clampAgentSlots((total / (2 * _agentMemoryBytes)).floor());
}

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

class _MachineChoice {
  const _MachineChoice({
    required this.id,
    required this.label,
    this.unavailable,
  });

  final String id, label;
  final ({IconData icon, String message})? unavailable;
}

/// "Agent slots" — how many agents this machine offers the Swarm — with the one
/// thing the number is not: a promise. Each start still checks free memory.
///
/// A stepper rather than a number field, so no keystroke can leave the dialog
/// holding a count the backend would refuse; both buttons go dead at the bounds
/// rather than staying lit and doing nothing.
class _AgentSlots extends StatelessWidget {
  const _AgentSlots({
    required this.value,
    required this.maximum,
    required this.busy,
    required this.onChanged,
  });

  final int value;
  final int maximum;
  final bool busy;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final value = this.value;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text('Agent slots', style: DesktopChrome.text())),
            Container(
              width: 96,
              constraints: const BoxConstraints(
                minHeight: grid.AppControl.height,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 4),
              decoration: BoxDecoration(
                // The same recessed well the picker's control sits in.
                color: grid.AppSurface.recess,
                borderRadius: BorderRadius.circular(grid.AppControl.radius),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  AppIconButton(
                    key: const ValueKey('agent-slots-fewer'),
                    icon: AppIcons.minus,
                    size: 16,
                    tooltip: 'Fewer slots',
                    onPressed: busy || value <= _agentSlotsMin
                        ? null
                        : () =>
                              onChanged(value > maximum ? maximum : value - 1),
                  ),
                  Text(
                    value.toString(),
                    key: const ValueKey('agent-slots-value'),
                    style: DesktopChrome.control(),
                  ),
                  AppIconButton(
                    key: const ValueKey('agent-slots-more'),
                    icon: AppIcons.plus,
                    size: 16,
                    tooltip: 'More slots',
                    onPressed: busy || value >= maximum
                        ? null
                        : () => onChanged(value + 1),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          'Each new agent still needs free memory when it starts.',
          style: DesktopChrome.metadata(),
        ),
      ],
    );
  }
}

/// Unlike an ordinary choice field, this inventory also explains computers
/// that cannot be selected. Standard menu buttons own their disabled semantics
/// and keyboard traversal; the shared menu theme supplies their appearance.
class _MachinePicker extends StatefulWidget {
  const _MachinePicker({
    required this.value,
    required this.choices,
    required this.busy,
    required this.onChanged,
  });

  final String? value;
  final List<_MachineChoice> choices;
  final bool busy;
  final ValueChanged<String> onChanged;

  @override
  State<_MachinePicker> createState() => _MachinePickerState();
}

class _MachinePickerState extends State<_MachinePicker> {
  final _menu = MenuController();
  final _focus = FocusNode(debugLabel: 'Machine');

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  void _open() {
    if (!widget.busy) _menu.open();
  }

  Widget _status(({IconData icon, String message}) status) => Tooltip(
    message: status.message,
    excludeFromSemantics: true,
    child: Icon(status.icon, size: grid.AppControl.iconSize),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final current = widget.choices
        .where((choice) => choice.id == widget.value)
        .firstOrNull;
    final firstAvailable = widget.choices
        .where((choice) => choice.unavailable == null)
        .firstOrNull;
    final focusId = current?.unavailable == null && current != null
        ? current.id
        : firstAvailable?.id;
    final label = current?.label ?? 'Choose a machine';
    return LayoutBuilder(
      builder: (context, constraints) => MenuAnchor(
        controller: _menu,
        childFocusNode: _focus,
        consumeOutsideTap: true,
        alignmentOffset: const Offset(0, grid.AppControl.menuGap),
        style: grid.AppMenu.style(
          minWidth: constraints.maxWidth,
          maxWidth: constraints.maxWidth,
        ),
        onOpen: () => setState(() {}),
        onClose: () => setState(() {}),
        menuChildren: [
          for (final choice in widget.choices)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              child: SizedBox(
                width: constraints.maxWidth - 12,
                child: MenuItemButton(
                  key: ValueKey('swarm-machine-option-${choice.id}'),
                  autofocus: choice.id == focusId,
                  overflowAxis: Axis.vertical,
                  semanticsLabel: [
                    choice.label,
                    ?choice.unavailable?.message,
                  ].join(', '),
                  style: ButtonStyle(
                    side: const WidgetStatePropertyAll(BorderSide.none),
                    padding: WidgetStatePropertyAll(
                      AppMenuRowMetrics.roomy.padding,
                    ),
                  ),
                  onPressed: widget.busy || choice.unavailable != null
                      ? null
                      : () => widget.onChanged(choice.id),
                  trailingIcon: choice.unavailable != null
                      ? _status(choice.unavailable!)
                      : choice.id == widget.value
                      ? const Icon(
                          AppIcons.check,
                          size: grid.AppControl.iconSize,
                        )
                      : null,
                  child: Tooltip(
                    message: choice.label,
                    excludeFromSemantics: true,
                    child: Text(
                      choice.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
              ),
            ),
        ],
        builder: (context, menu, _) => CallbackShortcuts(
          bindings: {
            const SingleActivator(LogicalKeyboardKey.arrowDown): _open,
            const SingleActivator(LogicalKeyboardKey.arrowUp): _open,
          },
          child: Semantics(
            label: 'Machine',
            value: [label, ?current?.unavailable?.message].join(', '),
            expanded: menu.isOpen,
            child: TextButton(
              key: const ValueKey('swarm-machine-picker'),
              focusNode: _focus,
              style: TextButton.styleFrom(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(grid.AppControl.radius),
                ),
              ),
              onPressed: widget.busy
                  ? null
                  : () => menu.isOpen ? menu.close() : _open(),
              child: ExcludeSemantics(
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (current?.unavailable != null) ...[
                      const SizedBox(width: 8),
                      _status(current!.unavailable!),
                    ],
                    const SizedBox(width: 8),
                    const Icon(
                      AppIcons.chevronDown,
                      size: grid.AppControl.iconSize,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
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
  SuperTabController get c => widget.controller;
  Set<String> get _ids => {
    for (final a in c.snapshot?.agents ?? const <SuperTabAgent>[]) a.machineId,
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
    if ((!kUnderTest || widget.readLocal != null) && widget.app != null) {
      _updateUsage();
      widget.app!.foreground.addListener(_foreground);
      unawaited(_refresh());
    }
  }

  void _changed() {
    if (mounted) setState(() {});
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

  Future<void> _contribute({Map<String, dynamic>? existing}) async {
    final app = widget.app;
    if (app == null) return;
    final isConfigure = existing != null;
    final existingId = existing?['machineId'] as String?;
    bool isExisting(MachineState m) =>
        existingId != null && m.machine.machineId == existingId;
    // "Already in this tab" means already CONTRIBUTED — an agent already
    // running there (unconfirmed) does not count, or a freshly created tab
    // whose lead runs on this Mac could never contribute it. `_ids` (agents
    // too) is for the machine-card panel below, not this dialog.
    final contributed = {
      for (final m in c.snapshot?.machines ?? const <Map<String, dynamic>>[])
        m['machineId'] as String,
    };
    // Unavailable computers stay inspectable in the picker, but another
    // account's computers must never be offered for contribution. One choice
    // per computer: a Mac's Harness Team account in this Swarm is part of its
    // Mac's row, and joins and leaves with it (SuperTabSnapshot.placeOf).
    bool ownRow(MachineState m) =>
        (c.snapshot?.placeOf(m.machine.machineId) ?? m.machine.machineId) ==
        m.machine.machineId;
    List<MachineState> ownedMachines() => app.machineStates.values
        .where((m) => !m.belongsToOtherAccount && ownRow(m))
        .toList();
    ({IconData icon, String message})? unavailable(MachineState m) {
      if (!isExisting(m) && contributed.contains(m.machine.machineId)) {
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

    bool canSelect(MachineState? m) =>
        m != null && !m.belongsToOtherAccount && unavailable(m) == null;
    final addable = ownedMachines().where(canSelect).toList();
    String labelFor(MachineState m) => m.isLocalMachine
        ? 'This Mac (${m.machine.displayName})'
        : m.machine.displayName;
    String? machineId =
        existingId ??
        addable.where((m) => m.isLocalMachine).firstOrNull?.machine.machineId ??
        addable.firstOrNull?.machine.machineId;
    String? error;
    var busy = false;
    String? setupId;
    // The agent slots the owner is choosing. A machine already in this Swarm
    // starts at the number it has; a new one starts at what its total memory
    // suggests, worked out here rather than by preparation (below).
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

    /// What this machine's own memory says, once a reading has answered. Null
    /// while one is still coming, or when it failed.
    int? memorySuggestion(String? id) => id == null
        ? null
        : suggestions[id] ?? _suggestedAgentSlots(_samples[id]?.$1);

    int maximumFor(String? id) => id == null
        ? _agentSlotsMin
        : maximums[id] ??
              _maxAgentSlots(_samples[id]?.$1) ??
              _clampAgentSlots(storedSlots(id) ?? _agentSlotsMin);

    int slotsFor(String? id) {
      final stored = storedSlots(id);
      if (stored != null) return _clampAgentSlots(stored);
      return memorySuggestion(id) ?? _agentSlotsMin;
    }

    var slots = slotsFor(machineId);
    var slotsEdited = false;
    // The open dialog and its own setState, once it is built: a reading
    // answers while the form is open, and the field has to repaint when it
    // does. Both are read only while the dialog is still there — one that
    // arrives after it closed has nothing to repaint.
    BuildContext? dialog;
    void Function(void Function())? repaint;
    final reading = <String>{};

    /// Start the field where this machine's own memory says, without asking
    /// preparation: preparation sets the project up, probes engines and takes
    /// one of its 32 setup slots, and opening a form the owner may cancel is
    /// no reason to do that. A configured machine still needs its RAM reading
    /// for the stepper limit, but its chosen number is never replaced.
    Future<void> suggestSlots() async {
      final id = machineId;
      if (id == null || !canSelect(app.stateOf(id)) || !reading.add(id)) {
        return;
      }
      MachineResources? resources;
      try {
        resources = await (widget.readLocal ?? app.readMachineResources)(id);
      } catch (_) {
        return;
      }
      final suggested = _suggestedAgentSlots(resources);
      // The picker may have moved on to another machine, whose own reading is
      // the one that belongs in the field now — or the dialog may have closed.
      if (suggested == null || machineId != id || dialog?.mounted != true) {
        return;
      }
      suggestions[id] = suggested;
      maximums[id] = _maxAgentSlots(resources)!;
      // Repaint the limit, but never replace a number the owner chose.
      repaint?.call(() {
        if (!slotsEdited && storedSlots(id) == null) slots = suggested;
      });
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
              // Not awaited: the form is usable immediately, and the number
              // only has to be there by the time the owner reads it. Each
              // machine is read once, so a rebuild does not read again.
              unawaited(suggestSlots());
              Future<void> save() async {
                if (busy ||
                    !c.canWrite ||
                    machineId == null ||
                    !canSelect(app.stateOf(machineId!))) {
                  return;
                }
                final selected = machineId!;
                update(() {
                  busy = true;
                  error = null;
                });
                try {
                  setupId ??= superTabOperationId();
                  final deadline = DateTime.now().add(
                    const Duration(minutes: 5),
                  );
                  Map<String, dynamic> prepared;
                  while (true) {
                    if (!context.mounted || !c.canWrite) return;
                    prepared = await app.superTabMachineRequest(selected, {
                      'action': 'prepareContribution',
                      'tabId': c.tabId,
                      'scope': 'swarm',
                      'operationId': setupId,
                    });
                    if (prepared['state'] == 'ready' &&
                        prepared['scope'] == 'swarm') {
                      break;
                    }
                    if (prepared['state'] != 'preparing') {
                      throw const SuperTabFailure(
                        'UPDATE_REQUIRED',
                        'Update Harness on this machine, then try again.',
                      );
                    }
                    if (DateTime.now().isAfter(deadline)) {
                      throw const SuperTabFailure(
                        'SETUP_PENDING',
                        'Project setup is still running. Try again to check its progress.',
                      );
                    }
                    await Future<void>.delayed(const Duration(seconds: 1));
                  }
                  if (!context.mounted || !c.canWrite) return;
                  final machine = app.stateOf(selected);
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
                  // A machine with no number of its own whose reading failed,
                  // or had not answered yet, is showing the floor rather than
                  // a suggestion. The owner never chose that, so send what
                  // preparation offered instead — the number the field would
                  // have shown had the reading arrived.
                  final offered = prepared['maxAgents'];
                  final offeredMaximum = prepared['maxAvailableAgents'];
                  if (offeredMaximum is num) {
                    maximums[selected] = _clampAgentSlots(offeredMaximum);
                  }
                  if (!slotsEdited &&
                      storedSlots(selected) == null &&
                      memorySuggestion(selected) == null &&
                      offered is num) {
                    slots = _clampAgentSlots(offered);
                  }
                  // An earlier lost reply leaves an uncertain attempt holding
                  // its own receipt, and only one action may be in flight:
                  // check that one first, then send the number the owner is
                  // looking at — the stored attempt cannot know it was changed.
                  if (c.pendingCommand?['type'] == 'machine.contribute') {
                    // If that attempt cannot be confirmed, its own error is
                    // the one worth showing: it says why it is still unclear.
                    if (await c.retry() == null) {
                      if (!context.mounted) return;
                      throw SuperTabFailure(
                        c.operationErrorCode ?? 'CONTRIBUTION_FAILED',
                        c.operationError ??
                            'The earlier attempt is still not confirmed. '
                                'Try again to check it.',
                      );
                    }
                    if (!context.mounted || !c.canWrite) return;
                  }
                  final result = await c.command({
                    'type': 'machine.contribute',
                    'machineId': selected,
                    'name': machine!.machine.displayName,
                    'cwd': prepared['cwd'],
                    if (prepared['scope'] != null) 'scope': prepared['scope'],
                    'engines': engines,
                    'maxAgents': slots,
                  });
                  if (result == null) {
                    throw SuperTabFailure(
                      'CONTRIBUTION_FAILED',
                      c.operationError ?? 'Could not add this machine.',
                    );
                  }
                  await app.wakeSuperTabHost(selected);
                  // This Mac, added while its person is here: macOS asks once
                  // for the Harness Team account (cli/src/team/autoSetup.ts).
                  if (app.stateOf(selected)?.isLocalMachine == true) {
                    unawaited(app.offerTeamAccount('contribute'));
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

              final own = ownedMachines();
              final canSave =
                  machineId != null && canSelect(app.stateOf(machineId!));
              return AlertDialog(
                title: Text(isConfigure ? 'Configure machine' : 'Add machine'),
                content: SizedBox(
                  width: 360,
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (own.isNotEmpty)
                          _MachinePicker(
                            value: machineId,
                            busy: busy,
                            choices: [
                              for (final m in own)
                                _MachineChoice(
                                  id: m.machine.machineId,
                                  label: labelFor(m),
                                  unavailable: unavailable(m),
                                ),
                            ],
                            onChanged: (id) {
                              if (busy || !canSelect(app.stateOf(id))) return;
                              update(() {
                                machineId = id;
                                setupId = null;
                                error = null;
                                // Another machine has its own number: the one it
                                // already offers, or its own suggestion.
                                slots = slotsFor(id);
                                slotsEdited = false;
                              });
                              unawaited(suggestSlots());
                            },
                          )
                        else
                          Text(
                            'No computer is connected to this account yet.',
                            style: DesktopChrome.text(),
                          ),
                        const SizedBox(height: 16),
                        if (own.isNotEmpty) ...[
                          Text(
                            'Let the product manager run agents here using this machine’s signed-in accounts.',
                            style: DesktopChrome.text(),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Agents the Swarm starts on this machine run without asking for permission.',
                            style: DesktopChrome.text(),
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'Harness clones each project into ~/harnesses/swarms and lets '
                            "the Swarm's agents work in it.",
                            style: DesktopChrome.text(),
                          ),
                        ] else ...[
                          Text(
                            'To add another computer, install Harness on it and sign in with '
                            'this account, or approve a device with no screen from Machines.',
                            style: DesktopChrome.text(),
                          ),
                          const SizedBox(height: 4),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: TextButton(
                              onPressed: () {
                                Navigator.pop(context);
                                app.requestMachines();
                              },
                              child: const Text('Open Machines'),
                            ),
                          ),
                        ],
                        if (own.isNotEmpty) ...[
                          const SizedBox(height: 16),
                          _AgentSlots(
                            value: slots,
                            maximum: maximumFor(machineId),
                            busy: busy,
                            onChanged: (next) => update(() {
                              slots = next;
                              slotsEdited = true;
                            }),
                          ),
                        ],
                        if (error != null) ...[
                          const SizedBox(height: 12),
                          Text(error!, style: DesktopChrome.metadata()),
                        ],
                      ],
                    ),
                  ),
                ),
                actions: [
                  if (own.isNotEmpty)
                    FilledButton(
                      onPressed: busy || !canSave ? null : save,
                      child: Text(
                        busy
                            ? (isConfigure ? 'Saving…' : 'Preparing…')
                            : (isConfigure ? 'Save' : 'Add machine'),
                      ),
                    )
                  else
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('Close'),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Map<String, Object?> _quotaRow(Map<String, dynamic> quota, String machineId) {
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
    final expired = windows.any(
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
          '${w['name']}: ${100 - (w['usedPercent'] as num)}% remaining${reset(w['resetsAt']) == null ? '' : ' · resets in ${_until(reset(w['resetsAt'])!)}'}',
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

  /// The engines whose allowance a machine row shows, in this order.
  static const _chipEngines = ['claude', 'codex'];

  /// Everything a machine's row, its tooltip and its details say of it, read once per build.
  _MachineView _view(String id) {
    final app = widget.app, snapshot = c.snapshot!;
    final shared = snapshot.pool(id);
    // The Mac's Harness Team account is part of its row: its agents are listed here, and everyone but the Mac's owner
    // reads its availability, since it runs their agents, also while the owner is away from the Mac. The owner reads
    // their own computer. Actions stay the Mac's; the backend changes its team account with it.
    final team = snapshot.teamPoolOf(id);
    final teamId = team?['machineId'] as String?;
    final agents = snapshot.agents
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
    final status = superTabMachineStatus(
      age: age,
      // The Swarm cannot be read: a machine's silence is not known to be its own, so it is not offline.
      unreachable: !direct && c.backendUnreachable,
      refreshing: direct
          ? _awaiting.contains(readId)
          : _swarmReadsAtReturn != null && c.stateReads <= _swarmReadsAtReturn!,
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
        'Unavailable machine';
    final configured = (reading?['engines'] as List?)
        ?.whereType<String>()
        .toList();
    final allowed =
        configured?.any((engine) => !_chipEngines.contains(engine)) == true
        ? [
            for (final raw in observation['quotas'] as List? ?? [])
              if (_chipEngines.contains(superTabMap(raw)['engine']))
                superTabMap(raw)['engine'] as String,
          ]
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
    if (accounts.isEmpty && observedAt != null) {
      accounts = [
        for (final raw in observation['quotas'] as List? ?? [])
          // Routing reads quota for these two only; other engines drew "—".
          if (const {'claude', 'codex'}.contains(superTabMap(raw)['engine']))
            _quotaRow(superTabMap(raw), readId),
      ];
    }
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
    // Each engine with a known, unexpired allowance, Claude first. Offline or out of reach, an allowance is an
    // old reading and no chip shows it as now.
    final allowances = dim
        ? const <_Allowance>[]
        : [
            for (final engine in _chipEngines)
              if (accounts
                      .where(
                        (row) =>
                            row['engine'] == engine &&
                            row['remainingPercent'] is num,
                      )
                      .firstOrNull
                  case final row?)
                for (final account in WorkspaceSubscriptionUsage.fromRows([
                  row,
                ]).accounts.take(1))
                  _Allowance(
                    engine: engine,
                    name: account.name,
                    figure: account.figure,
                    left: (row['remainingPercent'] as num).toDouble().clamp(
                      0,
                      100,
                    ),
                    note: superMachineAllowanceNote(switch (row['details']) {
                      final List lines => lines.whereType<String>(),
                      _ => const <String>[],
                    }),
                    detail: [
                      account.name,
                      ...switch (row['details']) {
                        final List lines when lines.isNotEmpty =>
                          lines.whereType<String>(),
                        _ => ['${account.figure} remaining'],
                      },
                    ].join('\n'),
                  ),
          ];
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
    final problem = _teammatesLine(shared, team, contributor);
    return _MachineView(
      apiModels: apiModels,
      localModels: localModels,
      id: id,
      name: name,
      problem: problem,
      setUpTeam:
          problem != null &&
          team == null &&
          (shared?['teamWork'] as Map?)?['code'] == 'TEAM_ACCOUNT_REQUIRED' &&
          contributor == c.accountId &&
          app != null &&
          app.canSetUpTeamAccount &&
          app.stateOf(id)?.isLocalMachine == true,
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
      allowances: allowances,
      // What the line leaves out, for hover, focus and a screen reader: whose machine it is and its hardware,
      // after its state when that is not online. Never an age. Only current readings are included.
      tip: [
        if (cleaning) 'Cleaning up' else ?superTabMachineTip(status),
        if (person != null) 'Owned by ${superTabPersonName(person.email)}',
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
                      : 'This machine runs the Product Manager of project ${preview!.blockedProjectName}. Delete the project first.';
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
                                        'The open task “${agent.task}” goes back to the Product Manager.',
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
            return AlertDialog(
              title: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: Text(superTabMachineName(name))),
                      // Out of the way of the everyday actions below: a quiet mark that turns red when pointed at.
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
                                  WidgetsBinding.instance.addPostFrameCallback((
                                    _,
                                  ) {
                                    if (mounted) unawaited(_remove(v));
                                  });
                                },
                        ),
                    ],
                  ),
                  if (_canRemove(id) && removeReason != null)
                    Text(removeReason, style: DesktopChrome.metadata()),
                ],
              ),
              content: SuperTabMachineDetails(
                name: name,
                owner: person?.email,
                status: details,
                // Details follow the same freshness rule as the row and its disclosure.
                resources: dim ? null : value,
                cwd: shared?['cwd'] as String?,
                engines: allowed,
                accounts: dim ? const [] : accounts,
                footer: SuperTabMachineLocalModels(
                  controller: c,
                  machineId: id,
                  now: widget.now,
                ),
              ),
              actions: [
                if (shared != null && contributor == c.accountId)
                  TextButton(
                    onPressed: () async {
                      final result = await c.command({
                        'type': 'machine.pause',
                        'machineId': id,
                        'paused': !paused,
                      });
                      if (context.mounted && result != null) {
                        Navigator.pop(context);
                      }
                    },
                    child: Text(paused ? 'Resume new work' : 'Pause new work'),
                  ),
                if (contributor == c.accountId)
                  TextButton(
                    onPressed: () {
                      Navigator.pop(context);
                      unawaited(
                        _contribute(existing: shared ?? {'machineId': id}),
                      );
                    },
                    child: const Text('Configure'),
                  ),
                if (c.canWrite && c.selected != null)
                  TextButton(
                    onPressed: () {
                      final group = c.selected!;
                      Navigator.pop(context);
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        if (mounted) widget.onAddAgent(group);
                      });
                    },
                    child: const Text('Attach running agent'),
                  ),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Close'),
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
                ? () => showTeamAccountSetup(context, widget.app!)
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
          for (final agent in view.agents) _agent(view, agent),
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

  Widget _agent(_MachineView view, SuperTabAgent agent) {
    final name = c.snapshot!.agentName(agent.id);
    final activity = _activity(view, agent);
    final lead = c.snapshot!.isLead(agent.id);
    final customRole = c.snapshot!.activeRoleForAgent(agent);
    final role =
        customRole?.name ??
        (lead
            ? 'Product Manager'
            : agent.isReviewer
            ? 'Reviewer'
            : 'Engineer');
    final badge =
        customRole?.name ??
        (lead
            ? 'PM'
            : agent.isReviewer
            ? 'Rev'
            : 'Dev');
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
        child: InkWell(
          key: ValueKey('super-machine-agent-${view.id}-${agent.id}'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          onTap: widget.onOpenAgent == null
              ? null
              : () {
                  final current = c.snapshot?.agent(agent.id);
                  if (current != null) widget.onOpenAgent!(current);
                },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 36),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  const SizedBox(width: 4),
                  SizedBox(
                    width: 32,
                    child: Center(
                      child: SuperTabAvatar.agent(agent, name: name, size: 22),
                    ),
                  ),
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, constraints) {
                        final label = Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(),
                        );
                        final roleBadge = Semantics(
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
                            child: Text(badge, style: DesktopChrome.metadata()),
                          ),
                        );
                        if (constraints.maxWidth <
                            MediaQuery.textScalerOf(context).scale(100)) {
                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [label, roleBadge],
                          );
                        }
                        return Row(
                          children: [
                            Flexible(child: label),
                            const SizedBox(width: 6),
                            roleBadge,
                          ],
                        );
                      },
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
                  const SizedBox(width: 32),
                ],
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
            ? () => unawaited(_contribute())
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
              'Add a machine for the product manager to use.',
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
      agents: agents,
      soleSourceProjects: projects,
    );
  }

  final String? blockedProjectName;
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

/// One engine's allowance on a machine: its mark and remaining share on the row, its windows on hover.
class _Allowance {
  const _Allowance({
    required this.engine,
    required this.name,
    required this.figure,
    required this.left,
    required this.detail,
    this.note,
  });

  final String engine, name, figure, detail;

  /// The window that stops work first and when it resets (`5-hour limit · resets in 2h 10m`), under the figure.
  final String? note;

  /// The share left, 0–100.
  final double left;

  /// Amber below 20%, red below 10%, otherwise the reading's own ink.
  Color get ink => statusLineInkOnSurface(
    left < 10
        ? grid.AppPalette.usageCritical
        : left < 20
        ? grid.AppPalette.usageLow
        : DesktopChrome.foreground,
    DesktopChrome.surface,
  );
}

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
          // A machine reads as a home directory, "~ Diego's Mac", beside the
          // sidebar's "# project" channels.
          SizedBox(
            width: 32,
            child: Text(
              '~',
              textAlign: TextAlign.center,
              style: DesktopChrome.control(
                color: DesktopChrome.muted,
                medium: true,
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
                message: 'Owned by ${superTabPersonName(owner.email)}',
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
    if (view.dim) return const SizedBox.shrink();
    final resources = view.resources;
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
      if (view.allowances.isNotEmpty)
        (
          'Subscriptions',
          'left now',
          (width) => _grid(width, width >= 260 ? 2 : 1, [
            for (final allowance in view.allowances) _allowance(allowance),
          ]),
        ),
      if (view.apiModels.isNotEmpty || view.localModels.isNotEmpty)
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
    if (sections.isEmpty) return const SizedBox.shrink();
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
    final tone = allowance.left < 10
        ? grid.AppPalette.usageCritical
        : allowance.left < 20
        ? grid.AppPalette.usageLow
        : null;
    return Tooltip(
      message: allowance.detail,
      child: Semantics(
        label: '${allowance.name} ${allowance.figure} remaining',
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
                      style: DesktopChrome.text(size: 12, height: 1.3),
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
              // The bar is what is left, as the figure is.
              _Meter(share: allowance.left / 100, tone: tone),
              if (allowance.note case final note?) ...[
                const SizedBox(height: 5),
                Text(
                  note,
                  maxLines: 1,
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
