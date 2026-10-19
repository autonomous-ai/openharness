import 'dart:async';

import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../usage/models_menu_controller.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/remote_folder_picker.dart';
import '../widgets/workspace_subscription_usage.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';

class SuperTabMachines extends StatefulWidget {
  const SuperTabMachines({
    super.key,
    required this.controller,
    required this.onAddAgent,
    this.app,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final ValueChanged<SuperTabConversation> onAddAgent;
  @override
  State<SuperTabMachines> createState() => _SuperTabMachinesState();
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
    existing ??= c.pendingCommand?['type'] == 'machine.contribute'
        ? c.pendingCommand
        : null;
    final choices = app.machineStates.values
        .where(
          (m) =>
              !m.machine.isShared &&
              !m.machine.isSharedMachine &&
              !m.needsLink &&
              (m.nodeOnline != false ||
                  m.machine.machineId == existing?['machineId']),
        )
        .toList();
    String? machineId =
        existing?['machineId'] as String? ??
        choices.firstOrNull?.machine.machineId;
    String? folder = existing?['cwd'] as String?;
    var limit = (existing?['maxAgents'] as num?)?.toInt() ?? 2;
    final engines = {
      ...(existing?['engines'] as List? ?? const <String>[]).cast<String>(),
    };
    String? error;
    var busy = false;
    if (machineId != null) await app.probeEngines(machineId);
    if (!mounted) return;
    await showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        child: StatefulBuilder(
          builder: (context, update) {
            final recovering =
                c.pendingCommand?['type'] == 'machine.contribute';
            final locked = busy || recovering;
            final machine = app.stateOf(machineId ?? '');
            final installed = [
              'claude',
              'codex',
            ].where((e) => machine?.engines[e]?.installed == true).toList();
            Future<void> save() async {
              if (busy ||
                  machineId == null ||
                  folder == null ||
                  engines.isEmpty) {
                return;
              }
              update(() {
                busy = true;
                error = null;
              });
              try {
                final capability = await app.superTabMachineRequest(
                  machineId!,
                  {
                    'action': 'capacity',
                    'cwd': folder,
                    'tools': ['git'],
                    'devices': [],
                  },
                );
                if (capability['ok'] != true ||
                    (capability['resources']
                            as Map?)?['projectDiskFreeBytes'] ==
                        null) {
                  throw const SuperTabFailure(
                    'PROJECT_UNAVAILABLE',
                    'Choose an available project folder on this machine.',
                  );
                }
                final result = c.pendingCommand?['type'] == 'machine.contribute'
                    ? await c.retry()
                    : await c.command({
                        'type': 'machine.contribute',
                        'machineId': machineId,
                        'name': machine!.machine.displayName,
                        'cwd': folder,
                        'engines': engines.toList()..sort(),
                        'maxAgents': limit,
                      });
                if (result == null) {
                  throw SuperTabFailure(
                    'CONTRIBUTION_FAILED',
                    c.operationError ?? 'Could not contribute this machine.',
                  );
                }
                await app.wakeSuperTabHost(machineId!);
                if (context.mounted) Navigator.pop(context);
              } catch (failure) {
                if (context.mounted) {
                  update(() {
                    busy = false;
                    error = failure.toString();
                  });
                }
              }
            }

            return AlertDialog(
              title: const Text('Contribute a machine'),
              content: SizedBox(
                width: 400,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (choices.isEmpty)
                        const Text(
                          'Connect a computer to Harness first. You can then contribute it here.',
                        )
                      else
                        DropdownButtonFormField<String>(
                          initialValue: machineId,
                          decoration: const InputDecoration(
                            labelText: 'Machine',
                          ),
                          items: [
                            for (final m in choices)
                              DropdownMenuItem(
                                value: m.machine.machineId,
                                child: Text(m.machine.displayName),
                              ),
                          ],
                          onChanged: locked
                              ? null
                              : (id) async {
                                  update(() {
                                    machineId = id;
                                    folder = null;
                                    engines.clear();
                                  });
                                  if (id != null) await app.probeEngines(id);
                                  if (context.mounted) update(() {});
                                },
                        ),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        icon: const Icon(AppIcons.folder, size: 16),
                        label: Text(
                          folder ?? 'Choose project folder',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        onPressed: locked || machineId == null
                            ? null
                            : () async {
                                final picked = await showRemoteFolderPicker(
                                  context,
                                  notifier: app,
                                  machineId: machineId!,
                                  initialPath: folder,
                                  desktop: true,
                                );
                                if (context.mounted && picked != null) {
                                  update(() => folder = picked);
                                }
                              },
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Allow the lead to start agents with',
                        style: DesktopChrome.control(medium: true),
                      ),
                      for (final engine in installed)
                        CheckboxListTile(
                          contentPadding: EdgeInsets.zero,
                          dense: true,
                          title: Row(
                            children: [
                              EngineMark(engine: engine, size: 18),
                              const SizedBox(width: 8),
                              Text(engineIdentity(engine).label),
                            ],
                          ),
                          subtitle: const Text(
                            'Account signed in on this machine',
                          ),
                          value: engines.contains(engine),
                          onChanged: locked
                              ? null
                              : (value) => update(() {
                                  if (value == true) {
                                    engines.add(engine);
                                  } else {
                                    engines.remove(engine);
                                  }
                                }),
                        ),
                      if (installed.isEmpty)
                        Text(
                          'No supported engines reported by this machine.',
                          style: DesktopChrome.metadata(),
                        ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<int>(
                        initialValue: limit,
                        decoration: const InputDecoration(
                          labelText: 'Maximum agents at once',
                        ),
                        items: [
                          for (final n in [1, 2, 3, 4, 6, 8, 12, 16])
                            DropdownMenuItem(value: n, child: Text('$n')),
                        ],
                        onChanged: locked
                            ? null
                            : (n) => update(() => limit = n ?? limit),
                      ),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Text(error!),
                        ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed:
                      busy ||
                          machineId == null ||
                          folder == null ||
                          engines.isEmpty
                      ? null
                      : save,
                  child: Text(
                    busy
                        ? 'Contributing…'
                        : recovering
                        ? 'Check contribution'
                        : 'Contribute',
                  ),
                ),
              ],
            );
          },
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

  String? _resetSummary(String detail) {
    final lines = detail.split('\n');
    final limiting = lines
        .where((l) => l.startsWith('Limiting window: '))
        .firstOrNull
        ?.substring(17);
    final line = lines
        .where(
          (l) =>
              l.contains('resets in') &&
              (limiting == null || l.contains(limiting)),
        )
        .firstOrNull;
    final reset = line == null
        ? null
        : RegExp(r'resets in ([^·\n]+)').firstMatch(line)?.group(1)?.trim();
    return reset == null ? null : 'Resets in $reset';
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
    final disk = diskTotal == null || diskTotal <= 0 || diskFree == null
        ? null
        : (1 - diskFree / diskTotal) * 100;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
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
            child: Row(
              children: [
                Icon(
                  AppIcons.monitor,
                  size: 15,
                  color: online
                      ? DesktopChrome.foreground
                      : DesktopChrome.muted,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(medium: true),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  paused
                      ? 'Paused'
                      : !online
                      ? 'Offline'
                      : shared == null
                      ? '$running ${running == 1 ? 'agent' : 'agents'}'
                      : '$running/${shared['maxAgents']}',
                  style: DesktopChrome.metadata(),
                ),
              ],
            ),
          ),
          if (person != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                superTabPersonName(person.email),
                style: DesktopChrome.metadata(),
              ),
            ),
          if (value != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                [
                  if (value.deviceType != null) value.deviceType!,
                  if (value.chip != null) value.chip!,
                  if (value.os != null) value.os!,
                  '${resourceBytes(value.memoryTotalBytes)} RAM',
                ].join(' · '),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(),
              ),
            ),
          const SizedBox(height: 12),
          Row(
            children: [
              for (final metric in [
                ('CPU', value?.cpuPercent),
                ('GPU', value?.busiestGpu?.utilizationPercent),
                ('RAM', value?.memoryPercent),
                ('Disk', disk),
              ])
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(metric.$1, style: DesktopChrome.metadata()),
                      Text(
                        resourcePercent(metric.$2),
                        style: DesktopChrome.text(medium: true),
                      ),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Available: ${resourceBytes(value?.memoryTotalBytes == null ? null : value!.memoryTotalBytes! - value.memoryUsedBytes!)} RAM · ${resourceBytes(value?.projectDiskFreeBytes ?? value?.diskFreeBytes)} disk',
            style: DesktopChrome.metadata(),
          ),
          const SizedBox(height: 10),
          Text('Subscription remaining', style: DesktopChrome.metadata()),
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
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            EngineMark(engine: account.engine, size: 16),
                            const SizedBox(width: 6),
                            Text(
                              account.figure,
                              style: DesktopChrome.control(
                                medium: true,
                                color:
                                    account.tone == WorkspaceUsageTone.exhausted
                                    ? grid.AppPalette.warn
                                    : null,
                              ),
                            ),
                          ],
                        ),
                        if (_resetSummary(account.detail) case final reset?)
                          Text(reset, style: DesktopChrome.metadata()),
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
  Widget build(BuildContext context) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 12, 0),
        child: Row(
          children: [
            Expanded(
              child: Text(
                'Machines · ${_ids.length}',
                style: DesktopChrome.metadata().copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            if (c.canWrite && widget.app != null)
              AppIconButton(
                icon: AppIcons.plus,
                tooltip: 'Contribute a machine',
                onPressed: () => unawaited(_contribute()),
              ),
          ],
        ),
      ),
      Expanded(
        child: _ids.isEmpty
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'Contribute a machine so the lead can start agents.',
                    textAlign: TextAlign.center,
                    style: DesktopChrome.metadata(),
                  ),
                ),
              )
            : ListView.separated(
                itemCount: _ids.length,
                separatorBuilder: (_, _) => Divider(
                  height: 1,
                  indent: 16,
                  endIndent: 16,
                  color: DesktopChrome.rim,
                ),
                itemBuilder: (_, i) => _machine(_ids.elementAt(i)),
              ),
      ),
    ],
  );
}
