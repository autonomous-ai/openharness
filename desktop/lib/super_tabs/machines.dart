import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/status_line_style.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../usage/models_menu_controller.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/workspace_subscription_usage.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'machine_status.dart';
import 'machine_details.dart';
import 'model.dart';
import 'section_heading.dart';

export 'machine_status.dart';

/// The owner's agent slots run 1–8 here, though the backend itself accepts up
/// to 16: widening the UI to the backend's ceiling would only invite a number
/// the machine cannot run.
const _agentSlotsMin = 1;
const _agentSlotsMax = 8;

/// What one more agent needs to start, the CLI's own figure
/// (`START_REQUIREMENTS.memoryBytes`, `cli/src/superTabs/capacity.ts`).
const _agentMemoryBytes = 2 * 1024 * 1024 * 1024;

int _clampAgentSlots(num value) =>
    value.toInt().clamp(_agentSlotsMin, _agentSlotsMax);

/// What this machine's free memory suggests, by the CLI's own arithmetic: one
/// agent per [_agentMemoryBytes] free. Null when the reading does not say how
/// much memory there is.
int? _suggestedAgentSlots(MachineResources? resources) {
  final total = resources?.memoryTotalBytes;
  final used = resources?.memoryUsedBytes;
  if (total == null || used == null) return null;
  return _clampAgentSlots(((total - used) / _agentMemoryBytes).floor());
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
    this.onYourDevices,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final bool embedded;

  /// Whether the body below the heading is hidden. The heading itself, and
  /// its Your devices and Add machine actions, remain visible so the group
  /// stays reachable.
  final bool collapsed;
  final VoidCallback? onToggleCollapsed;

  /// The heading's Your devices action, just before Add machine; absent when null.
  final VoidCallback? onYourDevices;
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
/// thing the number is not: a promise. Its free memory is what it was suggested
/// from, and what is free moves.
///
/// A stepper rather than a number field, so no keystroke can leave the dialog
/// holding a count the backend would refuse; both buttons go dead at the bounds
/// rather than staying lit and doing nothing.
class _AgentSlots extends StatelessWidget {
  const _AgentSlots({
    required this.value,
    required this.busy,
    required this.onChanged,
    this.cappedFrom,
  });

  final int value;
  final bool busy;
  final ValueChanged<int> onChanged;

  /// The number this machine was contributed with, when it is above what this
  /// form offers: saving would lower it, and the owner is told so.
  final int? cappedFrom;

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
                        : () => onChanged(value - 1),
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
                    onPressed: busy || value >= _agentSlotsMax
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
        if (cappedFrom case final from?) ...[
          const SizedBox(height: 4),
          Text(
            'This machine was set to $from agent slots. This form offers up to '
            '$_agentSlotsMax, and saving here lowers it.',
            style: DesktopChrome.metadata(),
          ),
        ],
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

  /// Machines whose sample in [_samples] was taken before the app last came back to the front: it is shown, dimmed,
  /// as "refreshing…" until the read that follows replaces it.
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
      // Back in front: what was read before stays on the screen, dimmed, as refreshing — it used to vanish and
      // come back a second later. The Swarm is read again at once, and so are this computer's readings.
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
    // account's computers must never be offered for contribution.
    List<MachineState> ownedMachines() => app.machineStates.values
        .where((m) => !m.belongsToOtherAccount)
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
    // starts at the number it has; a new one starts at what its free memory
    // suggests, worked out here rather than by preparation (below).
    int? storedSlots(String? id) {
      final row = id == null
          ? null
          : c.snapshot?.machines.where((m) => m['machineId'] == id).firstOrNull;
      final current = row?['maxAgents'];
      return current is num ? current.toInt() : null;
    }

    /// A machine contributed before this form had a range keeps its number
    /// until the owner saves, and is told when saving would lower it.
    int? storedOverRange(String? id) {
      final stored = storedSlots(id);
      return stored != null && stored > _agentSlotsMax ? stored : null;
    }

    // Readings this dialog has taken itself, keyed by machine. The panel's own
    // samples stand in for a machine it already reads.
    final suggestions = <String, int>{};

    /// What this machine's own memory says, once a reading has answered. Null
    /// while one is still coming, or when it failed.
    int? memorySuggestion(String? id) => id == null
        ? null
        : suggestions[id] ?? _suggestedAgentSlots(_samples[id]?.$1);

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
    /// no reason to do that. A machine with a number of its own needs no
    /// reading at all.
    Future<void> suggestSlots() async {
      final id = machineId;
      if (id == null ||
          storedSlots(id) != null ||
          !canSelect(app.stateOf(id)) ||
          !reading.add(id)) {
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
      // Never over a number the owner has set meanwhile.
      if (slotsEdited) return;
      repaint?.call(() => slots = suggested);
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
                  // A machine with no number of its own whose reading failed,
                  // or had not answered yet, is showing the floor rather than
                  // a suggestion. The owner never chose that, so send what
                  // preparation offered instead — the number the field would
                  // have shown had the reading arrived.
                  final offered = prepared['maxAgents'];
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
                    'engines': prepared['engines'],
                    'maxAgents': slots,
                  });
                  if (result == null) {
                    throw SuperTabFailure(
                      'CONTRIBUTION_FAILED',
                      c.operationError ?? 'Could not add this machine.',
                    );
                  }
                  await app.wakeSuperTabHost(selected);
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
                            busy: busy,
                            cappedFrom: storedOverRange(machineId),
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
    final app = widget.app, state = app?.stateOf(id);
    final shared = c.snapshot?.machines
        .where((m) => m['machineId'] == id)
        .firstOrNull;
    final agents = c.snapshot!.agents.where((a) => a.machineId == id).toList();
    final contributor =
        shared?['contributorId'] as String? ??
        agents.firstOrNull?.contributorId;
    final person = c.snapshot!.people
        .where((p) => p.id == contributor)
        .firstOrNull;
    final observation = superTabMap(
      shared?['observation'] ?? const <String, dynamic>{},
    );
    final now = widget.now();
    final received = observation['receivedAt'];
    final observedAt = received is num
        ? DateTime.fromMillisecondsSinceEpoch(received.toInt())
        : null;
    final sample = _samples[id];
    final connected =
        state?.connectionStatus == ConnectionStatus.connected &&
        state?.nodeOnline != false;
    // Where the reading comes from. A computer this Desktop reads itself is known by that reading — and so is
    // this very computer when it contributes and its own sample is the newer, which is why it stays live while
    // the Swarm cannot be read. Any other contributing machine is known by what it reports through the Swarm.
    final direct =
        shared == null ||
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
          ? _awaiting.contains(id)
          : _swarmReadsAtReturn != null && c.stateReads <= _swarmReadsAtReturn!,
      connected: direct ? connected : null,
    );
    // Every state but live or late reads old numbers: kept in the tooltip, never blanked, but not taken as now.
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
    final name =
        shared?['name'] as String? ??
        state?.machine.displayName ??
        'Unavailable machine';
    final allowed = (shared?['engines'] as List?)?.cast<String>();
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
            _quotaRow(superTabMap(raw), id),
      ];
    }
    final paused = shared?['paused'] == true;
    final details = switch (status) {
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
    final allowances =
        status == SuperTabMachineStatus.offline ||
            status == SuperTabMachineStatus.unknown
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
    return _MachineView(
      id: id,
      name: name,
      owner: person,
      contributor: contributor,
      shared: shared,
      agents: [
        for (final agent in agents)
          (
            id: agent.id,
            name: c.snapshot!.agentName(agent.id),
            role: c.snapshot!.isLead(agent.id) ? 'Product Manager' : 'Engineer',
          ),
      ],
      status: status,
      readingAt: readingAt,
      arrived: age != null && age < const Duration(milliseconds: 1200),
      paused: paused,
      dim: dim,
      details: details,
      resources: value,
      accounts: accounts,
      engines: allowed,
      allowances: allowances,
      // What the line leaves out, for hover, focus and a screen reader: whose machine it is and its hardware,
      // after its state when that is not online. Never an age. Old numbers are kept here, never blanked.
      tip: [
        ?superTabMachineTip(status),
        if (person != null) 'Owned by ${superTabPersonName(person.email)}',
        if (paused) 'New work paused',
        if (value?.cpuPercent case final cpu?) 'CPU ${available(cpu)} free',
        if (value?.busiestGpu?.utilizationPercent case final gpu?)
          'GPU ${available(gpu)} free',
        if (memoryFree != null)
          'RAM ${resourceBytes(memoryFree.toDouble())} free',
        if (diskFree != null) 'SSD ${resourceBytes(diskFree)} free',
      ].join(' · '),
    );
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
        child: AlertDialog(
          title: Text(superTabMachineName(name)),
          content: SuperTabMachineDetails(
            name: name,
            owner: person?.email,
            status: details,
            // The row's tooltip keeps old numbers, aged; the details do not present them as capacity to use.
            resources: dim ? null : value,
            cwd: shared?['cwd'] as String?,
            engines: allowed,
            accounts: dim ? const [] : accounts,
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
                  unawaited(_contribute(existing: shared ?? {'machineId': id}));
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
        ),
      ),
    );
  }

  /// Where the trailing marks of a row center: on the heading's +, as the project rows' dots do.
  double get _anchor =>
      SuperTabSectionHeading.actionWidth / 2 + (widget.embedded ? 0 : 12);

  /// One machine on one line: its state's dot in the icon column, its name on the text column, its agents at
  /// the end. Everything else is in its tooltip and its details.
  Widget _machine(_MachineView v, _Columns columns, {int level = 1}) {
    final tipKey = _tips.putIfAbsent(v.id, GlobalKey<TooltipState>.new);
    final name = superTabMachineName(v.name);
    final row = Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey('super-machine-${v.id}'),
          onTap: () => unawaited(_details(v)),
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          // Hover shows the row's tooltip; so does keyboard focus, which a Tooltip does not do by itself.
          onFocusChange: (focused) {
            if (focused &&
                FocusManager.instance.highlightMode ==
                    FocusHighlightMode.traditional) {
              tipKey.currentState?.ensureTooltipVisible();
            } else if (!focused) {
              Tooltip.dismissAllToolTips();
            }
          },
          child: _MachineLine(view: v, columns: columns, level: level),
        ),
      ),
    );
    // One label for the row, so that colour is never the only signal: the machine, its state in words, and
    // what hovering it says. Its allowances and agents follow, each in its own words.
    return Semantics(
      // Rows move as states change; each keeps its own element, tooltip and all.
      key: ValueKey('super-machine-entry-${v.id}'),
      container: true,
      label: [
        name,
        superTabMachineStateLabel(v.status),
        if (v.tip.isNotEmpty) v.tip,
      ].join(', '),
      child: Tooltip(
        key: tipKey,
        message: v.tip.isEmpty ? superTabMachineStateLabel(v.status) : v.tip,
        excludeFromSemantics: true,
        child: row,
      ),
    );
  }

  /// "Offline · N": the disclosure the offline machines sit under, closed until opened.
  Widget _offlineToggle(int count) {
    final open = c.offlineMachinesOpen;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const ValueKey('super-machines-offline'),
          // The sidebar rebuilds on the controller; a list shown on its own does not.
          onTap: () {
            c.toggleOfflineMachines();
            _changed();
          },
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: Semantics(
            button: true,
            expanded: open,
            label: 'Offline machines, $count',
            excludeSemantics: true,
            child: Row(
              children: [
                SizedBox(width: SuperTabSectionHeading.indentFor(1)),
                SizedBox(
                  width: _MachineLine.iconColumn,
                  child: Icon(
                    open ? AppIcons.chevronDown : AppIcons.chevronRight,
                    size: AppIcons.inlineSize,
                    color: DesktopChrome.muted,
                  ),
                ),
                Expanded(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 36),
                    child: Padding(
                      padding: EdgeInsets.fromLTRB(
                        0,
                        8,
                        _anchor - _MachineLine.dotHalf,
                        8,
                      ),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          'Offline · $count',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata(),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The right side of every row, decided once for the whole list from its [width], so each column lines up:
  /// Claude's allowance, Codex's, then the agents. A column no machine uses is left out. When the name would
  /// have less than its minimum, the agents column becomes a count first, then the Codex column goes, then
  /// Claude's, for every row at once.
  _Columns _columns(
    BuildContext context,
    double width,
    List<_MachineView> views,
  ) {
    final scaler = MediaQuery.textScalerOf(context);
    final direction = Directionality.of(context);
    double measure(String text, TextStyle style) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: direction,
        textScaler: scaler,
        maxLines: 1,
      )..layout();
      final result = painter.width;
      painter.dispose();
      return result;
    }

    final count = _MachineLine.countStyle;
    final chip =
        _MachineLine.gap +
        _MachineLine.mark +
        _MachineLine.markGap +
        measure('100%', count);
    bool uses(String engine) =>
        views.any((v) => v.allowances.any((a) => a.engine == engine));
    final most = views.fold(0, (n, v) => math.max(n, v.agents.length));
    final stacked = math.min(most, _MachineLine.maxAvatars);
    final rest = most - stacked;
    final ringed = _MachineLine.ringed;
    final full = most == 0
        ? 0.0
        : _MachineLine.avatarsGap +
              ringed +
              (ringed - _MachineLine.overlap) * (stacked - 1) +
              (rest > 0 ? 4 + measure('+$rest', count) : 0);
    final counted = most == 0
        ? 0.0
        : _MachineLine.countGap + measure('+$most', count);
    // With agents, their last avatar centers on the heading +; without, the row ends where project dots do.
    final end = most == 0
        ? _anchor - _MachineLine.dotHalf
        : (_anchor - ringed / 2).clamp(0.0, _anchor);
    final style = DesktopChrome.control();
    final wanted = math.min(
      views.fold(
        0.0,
        (w, v) => math.max(w, measure(superTabMachineName(v.name), style)),
      ),
      scaler.scale(_MachineLine.minName),
    );
    // Decided for the online rows, so opening "Offline · N" never moves a column; the offline rows' names,
    // one step further in, give way a little sooner.
    final text =
        width -
        SuperTabSectionHeading.indentFor(1) -
        _MachineLine.iconColumn -
        end;
    final steps = [
      (
        agents: full,
        counted: false,
        claude: uses('claude'),
        codex: uses('codex'),
      ),
      (
        agents: counted,
        counted: true,
        claude: uses('claude'),
        codex: uses('codex'),
      ),
      (agents: counted, counted: true, claude: uses('claude'), codex: false),
      (agents: counted, counted: true, claude: false, codex: false),
    ];
    final pick = steps.firstWhere(
      (s) =>
          text - s.agents - (s.claude ? chip : 0) - (s.codex ? chip : 0) >=
          wanted,
      orElse: () => steps.last,
    );
    return _Columns(
      claude: pick.claude,
      codex: pick.codex,
      chip: chip,
      agents: pick.agents,
      counted: pick.counted,
      end: end,
    );
  }

  /// Online machines first, then "Offline · N" with the offline ones under it; each part by name.
  List<Widget> _machines(BuildContext context, double width) {
    final views = [for (final id in _ids) _view(id)];
    String key(_MachineView v) => superTabMachineName(v.name).toLowerCase();
    // A machine being refreshed keeps its place; one whose state cannot be read follows the ones that report.
    int rank(_MachineView v) => switch (v.status) {
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
    final offline = views
        .where((v) => v.status == SuperTabMachineStatus.offline)
        .toList();
    final open = offline.isNotEmpty && c.offlineMachinesOpen;
    final shown = [
      for (final v in views)
        if (v.status != SuperTabMachineStatus.offline || open) v,
    ];
    final columns = _columns(context, width, shown);
    return [
      for (final v in views)
        if (v.status != SuperTabMachineStatus.offline) _machine(v, columns),
      if (offline.isNotEmpty) ...[
        _offlineToggle(offline.length),
        if (open)
          for (final v in offline) _machine(v, columns, level: 2),
      ],
    ];
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
        actions: [
          if (widget.onYourDevices != null)
            AppIconButton(
              key: const ValueKey('super-your-devices'),
              icon: AppIcons.monitorSmartphone,
              tooltip: 'Your devices',
              onPressed: widget.onYourDevices,
            ),
        ],
        endInset: widget.embedded ? 0 : 12,
        collapsed: widget.onToggleCollapsed == null ? null : widget.collapsed,
        onToggleCollapsed: widget.onToggleCollapsed,
      ),
      if (!widget.collapsed) ...[
        if (_ids.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Text(
              'Add a machine for the product manager to use.',
              style: DesktopChrome.metadata(),
            ),
          )
        else
          // The rows share their columns, which depend on the list's width.
          LayoutBuilder(
            builder: (context, constraints) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: _machines(context, constraints.maxWidth),
            ),
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
    required this.dim,
    required this.details,
    required this.resources,
    required this.accounts,
    required this.engines,
    required this.allowances,
    required this.tip,
  });

  final String id, name, details, tip;
  final SuperTabPerson? owner;
  final String? contributor;
  final Map<String, dynamic>? shared;
  final List<({String id, String name, String role})> agents;
  final SuperTabMachineStatus status;

  /// When the reading shown was taken, and whether that is just now (the dot pings once).
  final DateTime? readingAt;
  final bool arrived, paused;

  /// Offline, unknown or refreshing: its numbers are old.
  final bool dim;
  final MachineResources? resources;
  final List<Map<String, Object?>> accounts;
  final List<String>? engines;

  /// What the row's chips show, Claude first; empty while offline or out of reach.
  final List<_Allowance> allowances;
}

/// One engine's allowance on a machine: its mark and remaining share on the row, its windows on hover.
class _Allowance {
  const _Allowance({
    required this.engine,
    required this.name,
    required this.figure,
    required this.left,
    required this.detail,
  });

  final String engine, name, figure, detail;

  /// The share left, 0–100.
  final double left;

  /// Amber below 20%, red below 10%, otherwise the row's quiet metadata ink.
  Color get ink => statusLineInkOnSurface(
    left < 10
        ? grid.AppPalette.usageCritical
        : left < 20
        ? grid.AppPalette.usageLow
        : DesktopChrome.muted,
    DesktopChrome.surface,
  );
}

/// The right side every machine row shares: which columns show, and how wide each one is.
class _Columns {
  const _Columns({
    required this.claude,
    required this.codex,
    required this.chip,
    required this.agents,
    required this.counted,
    required this.end,
  });

  /// Whether the Claude and Codex allowance columns show.
  final bool claude, codex;

  /// The width of an allowance column: a gap, the mark, and room for "100%".
  final double chip;

  /// The width of the agents column; 0 when no machine has an agent.
  final double agents;

  /// Whether the agents column only counts them ("+3") rather than stacking their avatars.
  final bool counted;

  /// The space after the last column, from the row's right edge.
  final double end;
}

/// A machine's line, at the height and on the columns of a project row: the dot centered in the icon column,
/// the name on the text column, then the list's shared [columns]: Claude's allowance, Codex's, and the agents.
/// A machine without an allowance leaves its column blank, so every row's figures line up.
class _MachineLine extends StatelessWidget {
  const _MachineLine({
    required this.view,
    required this.columns,
    required this.level,
  });

  final _MachineView view;
  final _Columns columns;

  /// 1 under the Machines heading, 2 under "Offline · N".
  final int level;

  static const iconColumn = SuperTabSectionHeading.actionWidth;

  /// Half the project rows' dot, so that a list without agents stops where their rows do.
  static const dotHalf = 3.0;
  static const _avatar = 16.0;
  static const _ring = 1.0;
  static const overlap = 5.0;
  static const maxAvatars = 3;
  static const mark = 14.0;
  static const markGap = 3.0;

  /// Before each column, and between the name and the first.
  static const gap = 6.0;

  /// Before the agents column when it shows their avatars, so the avatars stand apart from the figures. A count
  /// is a figure like the others and keeps their [gap], which leaves Claude's column room in the default 204 px
  /// sidebar.
  static const avatarsGap = 16.0;
  static const countGap = gap;

  /// What the name keeps, at the default text size, before a column gives way: a readable start of it, small
  /// enough that Claude's allowance still fits beside it in the default 204 px sidebar.
  static const minName = 48.0;

  static double get ringed => _avatar + 2 * _ring;

  /// The allowance figures and the agent count, in tabular figures, at the scale of the 16 px avatars beside
  /// them.
  static TextStyle get countStyle => DesktopChrome.metadata().copyWith(
    fontSize: 11,
    fontFeatures: const [FontFeature.tabularFigures()],
  );

  @override
  Widget build(BuildContext context) {
    final v = view;
    final muted =
        v.status == SuperTabMachineStatus.offline ||
        v.status == SuperTabMachineStatus.unknown;
    final style = DesktopChrome.control(
      color: muted ? DesktopChrome.muted : DesktopChrome.foreground,
    );
    final count = countStyle;
    final agents = v.agents.length;
    final shown = columns.counted ? 0 : math.min(agents, maxAvatars);
    final hidden = agents - shown;
    final roles = v.agents.map((a) => '${a.name} — ${a.role}').join('\n');

    Widget allowance(String engine) {
      final a = v.allowances.where((a) => a.engine == engine).firstOrNull;
      return SizedBox(
        width: columns.chip,
        child: a == null
            ? null
            : Tooltip(
                message: a.detail,
                child: Semantics(
                  label: '${a.name} ${a.figure} remaining',
                  excludeSemantics: true,
                  child: Row(
                    key: ValueKey('super-machine-allowance-${v.id}-$engine'),
                    children: [
                      const SizedBox(width: gap),
                      EngineMark(engine: engine, size: mark),
                      const SizedBox(width: markGap),
                      // Right after its mark, so every row's figure starts at the same x.
                      Expanded(
                        child: Text(
                          a.figure,
                          key: ValueKey('super-machine-figure-${v.id}-$engine'),
                          maxLines: 1,
                          softWrap: false,
                          overflow: TextOverflow.clip,
                          style: count.copyWith(color: a.ink),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
      );
    }

    return Row(
      children: [
        SizedBox(width: SuperTabSectionHeading.indentFor(level)),
        SizedBox(
          width: iconColumn,
          child: Center(
            child: KeyedSubtree(
              key: ValueKey('super-machine-state-${v.id}-${v.status.name}'),
              child: SuperTabMachineDot(
                status: v.status,
                readingAt: v.readingAt,
                arrived: v.arrived,
              ),
            ),
          ),
        ),
        Expanded(
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 36),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, constraints) => Align(
                        alignment: Alignment.centerLeft,
                        child: _name(
                          context,
                          superTabMachineName(v.name),
                          style,
                          constraints.maxWidth,
                        ),
                      ),
                    ),
                  ),
                  if (columns.claude) allowance('claude'),
                  if (columns.codex) allowance('codex'),
                  if (columns.agents > 0)
                    SizedBox(
                      key: ValueKey('super-machine-agents-slot-${v.id}'),
                      width: columns.agents,
                      child: agents == 0
                          ? null
                          : Align(
                              alignment: Alignment.centerRight,
                              child: Tooltip(
                                message: roles,
                                child: Semantics(
                                  label: v.agents
                                      .map((a) => '${a.name}, ${a.role}')
                                      .join('; '),
                                  excludeSemantics: true,
                                  child: Row(
                                    key: ValueKey(
                                      'super-machine-agents-${v.id}',
                                    ),
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      if (shown > 0) _stack(context, shown),
                                      if (hidden > 0) ...[
                                        if (shown > 0) const SizedBox(width: 4),
                                        Text('+$hidden', style: count),
                                      ],
                                    ],
                                  ),
                                ),
                              ),
                            ),
                    ),
                  SizedBox(width: columns.end),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  /// The name, fitted to [room]; a name cut short shows itself whole on hover.
  Widget _name(
    BuildContext context,
    String name,
    TextStyle style,
    double room,
  ) {
    double measure(String text) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
        maxLines: 1,
      )..layout();
      final result = painter.width;
      painter.dispose();
      return result;
    }

    var shown = name;
    if (measure(name) > room) {
      final chars = name.characters.toList();
      var keep = 0;
      for (var lo = 1, hi = chars.length - 1; lo <= hi;) {
        final mid = (lo + hi) ~/ 2;
        if (measure('${chars.take(mid).join().trimRight()}…') <= room) {
          keep = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      shown = '${chars.take(keep).join().trimRight()}…';
    }
    final text = Text(
      shown,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );
    return shown == name ? text : Tooltip(message: name, child: text);
  }

  /// The first [shown] agents, overlapping, each on a ring of the surface so the one behind reads as behind.
  Widget _stack(BuildContext context, int shown) {
    final step = ringed - overlap;
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1,
      child: SizedBox(
        width: ringed + step * (shown - 1),
        height: ringed,
        child: Stack(
          children: [
            // The first agent is drawn last, on top.
            for (var i = shown - 1; i >= 0; i--)
              Positioned(
                left: step * i,
                child: Container(
                  padding: const EdgeInsets.all(_ring),
                  decoration: BoxDecoration(
                    color: DesktopChrome.surface,
                    shape: BoxShape.circle,
                  ),
                  child: SuperTabAvatar(
                    identity: 'agent:${view.agents[i].id}',
                    name: view.agents[i].name,
                    size: _avatar,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
