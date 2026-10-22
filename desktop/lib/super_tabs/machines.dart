import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
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
    await showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        child: ListenableBuilder(
          listenable: app,
          builder: (context, _) => StatefulBuilder(
            builder: (context, update) {
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
                  final result =
                      c.pendingCommand?['type'] == 'machine.contribute'
                      ? await c.retry()
                      : await c.command({
                          'type': 'machine.contribute',
                          'machineId': selected,
                          'name': machine!.machine.displayName,
                          'cwd': prepared['cwd'],
                          if (prepared['scope'] != null)
                            'scope': prepared['scope'],
                          'engines': prepared['engines'],
                          'maxAgents': prepared['maxAgents'],
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
                            });
                          },
                        )
                      else
                        Text(
                          'No computer is connected to this account yet.',
                          style: DesktopChrome.text(),
                        ),
                      const SizedBox(height: 16),
                      if (own.isNotEmpty)
                        Text(
                          'Let the product manager run agents here using this machine’s signed-in accounts.',
                          style: DesktopChrome.text(),
                        ),
                      if (own.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          'Agents the Swarm starts on this machine run without asking for permission.',
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
                      if (error != null) ...[
                        const SizedBox(height: 12),
                        Text(error!, style: DesktopChrome.metadata()),
                      ],
                    ],
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

  /// Below this share of an allowance left, a machine's row shows its one warning.
  static const _lowAllowance = 10;

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
    // An old reading's allowance is not a warning about now.
    final low = dim
        ? const <String>[]
        : [
            for (final row in accounts)
              if (row['remainingPercent'] case final num left
                  when left < _lowAllowance)
                for (final account in WorkspaceSubscriptionUsage.fromRows([
                  row,
                ]).accounts)
                  '${account.name}: ${account.figure} left',
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
      low: low,
      // What the line leaves out, for hover, focus and a screen reader: how old the reading is, the numbers
      // behind it and an allowance running out. Old numbers are kept here, never blanked.
      tip: [
        superTabMachineTip(status, age),
        if (paused) 'New work paused',
        if (value?.cpuPercent case final cpu?) 'CPU ${available(cpu)} free',
        if (value?.busiestGpu?.utilizationPercent case final gpu?)
          'GPU ${available(gpu)} free',
        if (memoryFree != null)
          'RAM ${resourceBytes(memoryFree.toDouble())} free',
        if (diskFree != null) 'SSD ${resourceBytes(diskFree)} free',
        ...low,
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
  Widget _machine(_MachineView v, {String? owner, int level = 1}) {
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
          child: _MachineLine(
            view: v,
            owner: owner,
            anchor: _anchor,
            level: level,
          ),
        ),
      ),
    );
    // One label for the row, so that colour is never the only signal: the machine, its state in words, and
    // what hovering it says.
    return Semantics(
      // Rows move as states change; each keeps its own element, tooltip and all.
      key: ValueKey('super-machine-entry-${v.id}'),
      container: true,
      label:
          '$name${owner == null ? '' : ' · $owner'}, '
          '${superTabMachineStateLabel(v.status)}, ${v.tip}',
      child: Tooltip(
        key: tipKey,
        message: v.tip,
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

  /// Online machines first, then "Offline · N" with the offline ones under it; each part by name.
  List<Widget> _machines() {
    final views = [for (final id in _ids) _view(id)];
    // A name two machines share is told apart by whose each is.
    String key(_MachineView v) => superTabMachineName(v.name).toLowerCase();
    final named = <String, int>{};
    for (final v in views) {
      named.update(key(v), (n) => n + 1, ifAbsent: () => 1);
    }
    String? owner(_MachineView v) => named[key(v)]! > 1 && v.owner != null
        ? superTabPersonName(v.owner!.email)
        : null;
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
    return [
      for (final v in views)
        if (v.status != SuperTabMachineStatus.offline)
          _machine(v, owner: owner(v)),
      if (offline.isNotEmpty) ...[
        _offlineToggle(offline.length),
        if (c.offlineMachinesOpen)
          for (final v in offline) _machine(v, owner: owner(v), level: 2),
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
          ..._machines(),
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
    required this.low,
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

  /// Each allowance under [_SuperTabMachinesState._lowAllowance], as "Claude Code: 2% left".
  final List<String> low;
}

/// A machine's line, at the height and on the columns of a project row: the dot centered in the icon column,
/// the name on the text column, and at the end the allowance warning when there is one and up to three agents
/// overlapping, then +N. The last mark centers on [anchor], the heading +'s column.
class _MachineLine extends StatelessWidget {
  const _MachineLine({
    required this.view,
    required this.owner,
    required this.anchor,
    required this.level,
  });

  final _MachineView view;

  /// Whose machine it is, when another has the same name.
  final String? owner;

  /// From the row's right edge to the center of its last mark.
  final double anchor;

  /// 1 under the Machines heading, 2 under "Offline · N".
  final int level;

  static const iconColumn = SuperTabSectionHeading.actionWidth;

  /// Half the project rows' dot, so that a row with nothing at its end stops where theirs do.
  static const dotHalf = 3.0;
  static const _avatar = 16.0;
  static const _ring = 1.0;
  static const _overlap = 5.0;
  static const _maxAvatars = 3;
  static const _warning = 14.0;

  /// Agents give way to the name, down to +N, until it fits or has this share of the line.
  static const _nameShare = .5;

  static double get _ringed => _avatar + 2 * _ring;

  @override
  Widget build(BuildContext context) {
    final v = view;
    final muted =
        v.status == SuperTabMachineStatus.offline ||
        v.status == SuperTabMachineStatus.unknown;
    final style = DesktopChrome.control(
      color: muted ? DesktopChrome.muted : DesktopChrome.foreground,
    );
    final countStyle = DesktopChrome.metadata().copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    double measure(String text, [TextStyle? textStyle]) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: textStyle ?? countStyle),
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
        maxLines: 1,
      )..layout();
      final result = painter.width;
      painter.dispose();
      return result;
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
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final warning = v.low.isNotEmpty;
                  ({double width, double end}) end(int shown) {
                    final hidden = v.agents.length - shown;
                    final last = hidden > 0
                        ? measure('+$hidden')
                        : shown > 0
                        ? _ringed
                        : warning
                        ? _warning
                        : 2 * dotHalf;
                    final width =
                        (warning ? _warning : 0) +
                        (warning && v.agents.isNotEmpty ? 6 : 0) +
                        (shown > 0
                            ? _ringed + (_ringed - _overlap) * (shown - 1)
                            : 0) +
                        (hidden > 0 ? (shown > 0 ? 4 : 0) + last : 0);
                    return (
                      width: width == 0 ? 0 : width + 8,
                      end: (anchor - last / 2).clamp(0.0, anchor),
                    );
                  }

                  final name = superTabMachineName(v.name);
                  final suffix = owner == null ? null : ' · $owner';
                  final wanted = math.min(
                    measure(name, style) +
                        (suffix == null ? 0 : measure(suffix, style)),
                    constraints.maxWidth * _nameShare,
                  );
                  var shown = v.agents.length.clamp(0, _maxAvatars);
                  while (shown > 0) {
                    final e = end(shown);
                    if (constraints.maxWidth - e.width - e.end >= wanted) {
                      break;
                    }
                    shown--;
                  }
                  final hidden = v.agents.length - shown;
                  final room =
                      constraints.maxWidth - end(shown).width - end(shown).end;
                  final roles = v.agents
                      .map((a) => '${a.name} — ${a.role}')
                      .join('\n');
                  return Row(
                    children: [
                      Expanded(
                        child: _name(context, name, suffix, style, room),
                      ),
                      if (warning) ...[
                        const SizedBox(width: 8),
                        Tooltip(
                          message: v.low.join('\n'),
                          child: Semantics(
                            label: v.low.join(', '),
                            child: Icon(
                              AppIcons.triangleAlert,
                              key: ValueKey('super-machine-attention-${v.id}'),
                              size: _warning,
                              color: grid.AppPalette.warn,
                            ),
                          ),
                        ),
                      ],
                      if (v.agents.isNotEmpty) ...[
                        SizedBox(width: warning ? 6 : 8),
                        Tooltip(
                          message: roles,
                          child: Semantics(
                            label: v.agents
                                .map((a) => '${a.name}, ${a.role}')
                                .join('; '),
                            excludeSemantics: true,
                            child: Row(
                              key: ValueKey('super-machine-agents-${v.id}'),
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (shown > 0) _stack(context, shown),
                                if (hidden > 0) ...[
                                  if (shown > 0) const SizedBox(width: 4),
                                  Text('+$hidden', style: countStyle),
                                ],
                              ],
                            ),
                          ),
                        ),
                      ],
                      SizedBox(width: end(shown).end),
                    ],
                  );
                },
              ),
            ),
          ),
        ),
      ],
    );
  }

  /// The name, then a shared name's owner in muted ink. The name gives way first, since the owner is what
  /// tells it apart, and a name cut short shows itself whole on hover.
  Widget _name(
    BuildContext context,
    String name,
    String? suffix,
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

    // Up to half the room for the owner, so a long address cannot crowd the name out.
    final ownerWidth = suffix == null
        ? 0.0
        : math.min(measure(suffix), room / 2);
    final fits = room - ownerWidth;
    var shown = name;
    if (measure(name) > fits) {
      final chars = name.characters.toList();
      var keep = 0;
      for (var lo = 1, hi = chars.length - 1; lo <= hi;) {
        final mid = (lo + hi) ~/ 2;
        if (measure('${chars.take(mid).join().trimRight()}…') <= fits) {
          keep = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      shown = '${chars.take(keep).join().trimRight()}…';
    }
    final text = Text.rich(
      TextSpan(
        children: [
          TextSpan(text: shown),
          if (suffix != null)
            TextSpan(
              text: suffix,
              style: TextStyle(color: DesktopChrome.muted),
            ),
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );
    return shown == name ? text : Tooltip(message: name, child: text);
  }

  /// The first [shown] agents, overlapping, each on a ring of the surface so the one behind reads as behind.
  Widget _stack(BuildContext context, int shown) {
    final step = _ringed - _overlap;
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1,
      child: SizedBox(
        width: _ringed + step * (shown - 1),
        height: _ringed,
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
