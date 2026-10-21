import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../usage/models_menu_controller.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/workspace_subscription_usage.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';
import 'section_heading.dart';

class SuperTabMachines extends StatefulWidget {
  const SuperTabMachines({
    super.key,
    required this.controller,
    required this.onAddAgent,
    this.app,
    this.embedded = false,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final bool embedded;
  final ValueChanged<SuperTabConversation> onAddAgent;
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
    if (!kUnderTest && widget.app != null) {
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
    _samples.clear();
    _changed();
    if (widget.app?.foreground.value == true) unawaited(_refresh());
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
            final value = await widget.app!.readMachineResources(id);
            if (!mounted || revision != _revision || !_ids.contains(id)) return;
            if (value == null) {
              _samples.remove(id);
            } else {
              _samples[id] = (value, DateTime.now());
            }
          }),
        );
        if (!mounted || revision != _revision) return;
      }
      _changed();
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
                          'Let the lead run agents here using this machine’s signed-in accounts.',
                          style: DesktopChrome.text(),
                        )
                      else ...[
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

  Widget _machine(String id) {
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
    final received = observation['receivedAt'];
    final fresh =
        received is num &&
        DateTime.now().millisecondsSinceEpoch - received < 45000;
    final online = shared == null
        ? state?.connectionStatus == ConnectionStatus.connected &&
              state?.nodeOnline != false
        : fresh;
    final sample = _samples[id];
    final resource = superTabMap(
      observation['resources'] ?? const <String, dynamic>{},
    );
    final value = fresh
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
        : online &&
              sample != null &&
              DateTime.now().difference(sample.$2) < const Duration(seconds: 45)
        ? sample.$1
        : null;
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
    if (accounts.isEmpty && fresh) {
      accounts = [
        for (final raw in observation['quotas'] as List? ?? [])
          _quotaRow(superTabMap(raw), id),
      ];
    }
    final usage = WorkspaceSubscriptionUsage.fromRows(online ? accounts : []);
    final running = fresh
        ? (observation['runningHarnessIds'] as List? ?? []).length
        : agents
              .where(
                (a) =>
                    state?.agents
                        .where((n) => n.id == a.harnessId && !n.isStopped)
                        .isNotEmpty ==
                    true,
              )
              .length;
    final paused = shared?['paused'] == true;
    final diskTotal = value?.projectDiskTotalBytes ?? value?.diskTotalBytes;
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
    String available(double? used) =>
        resourcePercent(used == null ? null : (100 - used).clamp(0, 100));
    String compactBytes(num? bytes) =>
        resourceBytes(bytes?.toDouble())
            .replaceAll(' GB', 'G')
            .replaceAll(' TB', 'T')
            .replaceAll(' MB', 'M');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: ValueKey('super-machine-$id'),
            borderRadius: BorderRadius.circular(8),
            onTap: () => showAppDialog<void>(
              context: context,
              builder: (context) => AlertDialog(
                title: Text(name),
                content: Text(
                  [
                    if (person != null) person.email,
                    paused
                        ? 'New work paused'
                        : online
                        ? 'Online'
                        : 'Offline',
                    if (value?.deviceType != null) value!.deviceType!,
                    if (value?.chip != null) value!.chip!,
                    if (value?.os != null) value!.os!,
                    if (shared?['cwd'] != null) shared!['cwd'] as String,
                    if (allowed != null) 'Engines: ${allowed.join(', ')}',
                    'RAM: ${resourceBytes(value?.memoryTotalBytes)}',
                    'Disk: ${resourceBytes(value?.diskTotalBytes)}',
                    for (final gpu in value?.gpus ?? const <MachineGpu>[])
                      'GPU: ${gpu.name}',
                    if (usage.accounts.isNotEmpty) usage.detail,
                  ].join('\n'),
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
                      child: Text(
                        paused ? 'Resume new work' : 'Pause new work',
                      ),
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
              ),
            ),
            child: Tooltip(
              message: [name, if (person != null) person.email].join('\n'),
              child: Row(
                children: [
                  Flexible(
                    flex: 3,
                    child: Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.control(medium: true),
                    ),
                  ),
                  if (person != null) ...[
                    const SizedBox(width: 8),
                    Flexible(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 64),
                        child: Text(
                          superTabPersonName(person.email),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata(),
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(width: 8),
                  Text(
                    paused
                        ? 'Paused'
                        : !online
                        ? 'Offline'
                        : '$running ${running == 1 ? 'agent' : 'agents'}',
                    style: DesktopChrome.metadata(),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 4),
          Tooltip(
            message:
                'Available capacity\nCPU and GPU: idle percentage at the latest reading\nRAM: ${resourceBytes(memoryFree?.toDouble())} free of ${resourceBytes(value?.memoryTotalBytes)}\nSSD: ${resourceBytes(diskFree)} free of ${resourceBytes(diskTotal)}',
            child: Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final metric in [
                  'CPU ${available(value?.cpuPercent)}',
                  'GPU ${available(value?.busiestGpu?.utilizationPercent)}',
                  'RAM ${compactBytes(memoryFree)}',
                  'SSD ${compactBytes(diskFree)}',
                ])
                  Text(metric, style: DesktopChrome.metadata()),
              ],
            ),
          ),
          const SizedBox(height: 4),
          if (usage.accounts.isEmpty)
            Text('—', style: DesktopChrome.control())
          else
            Wrap(
              spacing: 16,
              runSpacing: 8,
              children: [
                for (final account in usage.accounts)
                  Tooltip(
                    message: account.detail,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        EngineMark(engine: account.engine, size: 16),
                        const SizedBox(width: 6),
                        Text(
                          account.figure,
                          style: DesktopChrome.control(
                            medium: true,
                            color: account.tone == WorkspaceUsageTone.exhausted
                                ? grid.AppPalette.warn
                                : null,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final children = [
      SuperTabSectionHeading(
        'Machines',
        onAdd: c.canWrite && widget.app != null
            ? () => unawaited(_contribute())
            : null,
        addTooltip: 'Add machine',
      ),
      if (_ids.isEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: Text(
            'Add a machine for the lead to use.',
            style: DesktopChrome.metadata(),
          ),
        )
      else
        for (final id in _ids) _machine(id),
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
