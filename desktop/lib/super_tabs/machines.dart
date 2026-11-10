import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

import '../core/machine_resources.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/status_line_style.dart';
import '../shared/theme/machines_style.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/browser_menu_guard.dart';
import '../widgets/finger_target.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/harness_activity_mark.dart';
import '../widgets/pane_menu.dart' show showContextMenuAt;
import 'add_computers.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'local_models.dart';
import '../models/swarm_models_target.dart' show swarmSharedWithYouShown;
import 'machine_details.dart';
import 'machine_status.dart';
import 'model.dart';
import '../widgets/laid_out_list.dart';

export 'machine_status.dart';

part 'machines_manage.dart';

/// The backend's bounds for a machine's `maxAgents`.
const _agentSlotsMin = 1;
const _agentSlotsMax = 1024;

int _clampAgentSlots(num value) =>
    value.toInt().clamp(_agentSlotsMin, _agentSlotsMax);

/// Manage › Machines: one line per machine with its owner and status, search and filters, and Add machine.
class SuperTabMachines extends StatefulWidget {
  const SuperTabMachines({
    super.key,
    required this.controller,
    required this.onAddAgent,
    this.app,
    this.now = DateTime.now,
    this.readLocal,
    this.onOpenAgent,
    this.ticks,
  });
  final SuperTabController controller;
  final AppNotifier? app;

  /// Runs the one-second clock; by default everywhere but under `flutter test`.
  @visibleForTesting
  final bool? ticks;

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

/// The engines a machine offers the Swarm; a retired one (OpenCode) is left out.
const _swarmEngines = ['claude', 'codex'];

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
          .where((engine) => _swarmEngines.contains(engine))
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

/// Adds the reader's own computer [machineId] to the Swarm, running as many
/// agents as its memory allows. Resolves to [machineId], null when [alive]
/// ended first or the reader can no longer write. Throws a [SuperTabFailure]
/// saying why it could not. [setupId] is the caller's to keep between tries: a
/// setup still running answers the next try with the same one. With
/// [teamAccountOnly], teammates' work reaches it only through its Harness Team
/// account once that passes its privacy check (backend superTabs/machines.ts
/// `teamWorkRefusal`).
Future<String?> contributeComputer(
  SuperTabController c,
  AppNotifier app,
  String machineId, {
  required String setupId,
  required bool Function() alive,
  bool teamAccountOnly = false,
  bool ifMissing = false,
  bool unlessRemoved = false,
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
  if (!alive() || !c.canWrite) return null;
  // An earlier lost reply leaves an uncertain attempt holding its own
  // receipt, and only one action may be in flight: check that one first.
  if (c.pendingCommand?['type'] == 'machine.contribute') {
    // If that attempt cannot be confirmed, its own error is the one worth
    // showing: it says why it is still unclear.
    if (await c.retry() == null) {
      if (!alive()) return null;
      throw SuperTabFailure(
        c.operationErrorCode ?? 'CONTRIBUTION_FAILED',
        c.operationError ?? 'The earlier attempt is still not confirmed. Try again to check it.',
      );
    }
    if (!alive() || !c.canWrite) return null;
  }
  // With `agents: memory` the server sets no limit; `maxAgents` is only
  // preparation's own figure, which the command still carries.
  final offered = prepared['maxAgents'];
  final result = await c.command({
    'type': 'machine.contribute',
    'machineId': machineId,
    'name': app.stateOf(machineId)!.machine.displayName,
    'cwd': prepared['cwd'],
    if (prepared['scope'] != null) 'scope': prepared['scope'],
    'engines': engines,
    'maxAgents': offered is num ? _clampAgentSlots(offered) : _agentSlotsMin,
    'agents': 'memory',
    if (teamAccountOnly) 'teamAccountOnly': true,
    if (ifMissing) 'ifMissing': true,
    if (unlessRemoved) 'unlessRemoved': true,
  });
  if (result == null) {
    throw SuperTabFailure(
      'CONTRIBUTION_FAILED',
      c.operationError ?? 'Could not add this machine.',
    );
  }
  await app.wakeSuperTabHost(machineId);
  return machineId;
}

class _SuperTabMachinesState extends State<SuperTabMachines> {
  final _samples = <String, (MachineResources, DateTime)>{};
  String? _selectedMachineId;
  String? _focusedMachineId;
  String _machineSearch = '';
  String _machineFilter = 'all';
  Object? _manageLayoutDrawn;
  Map<String, String> _manageNames = const {};

  /// Samples from before foreground return stay cached, but their readings are
  /// hidden behind the refreshing state until the next read answers.
  final _awaiting = <String>{};

  /// How many reads of the Swarm's state had been answered when the app came back to the front; the machines
  /// reporting through it are refreshing until one more is. Null: the app has not been away.
  int? _swarmReadsAtReturn;

  /// Once a second while the list shows ([_syncTick]), so that ages and states
  /// follow the clock between the Swarm's reads.
  Timer? _tick;

  /// What each row last drew, and their order: a tick or a machine's report
  /// redraws only a row whose words moved, and the list only when rows move.
  final _rowsDrawn = <String, Object>{};
  List<String> _orderDrawn = const [];

  /// Each row's group as drawn: a machine can change group with the order of rows unchanged (Online to Offline),
  /// and its headings' counts must follow it (review of #3370).
  List<String> _groupsDrawn = const [];
  final _rowBeats = <String, ValueNotifier<int>>{};
  final _tips = <String, GlobalKey<TooltipState>>{};

  /// One per Swarm menu open now, each keeping the browser's menu off.
  final _menuHolds = <Object>{};
  Timer? _timer;
  bool _reading = false;
  int _revision = 0;

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
    c.machinesChanged.addListener(_machinesMoved);
    if ((!kUnderTest || widget.readLocal != null) && widget.app != null) {
      widget.app!.foreground.addListener(_foreground);
      unawaited(_refresh());
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncTick();
  }

  @override
  void didUpdateWidget(SuperTabMachines old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, c)) {
      old.controller.machinesChanged.removeListener(_machinesMoved);
      c.machinesChanged.addListener(_machinesMoved);
    }
    _syncTick();
  }

  /// The clock runs only while something it moves shows: not for a Swarm not
  /// on screen or a window at the back.
  void _syncTick() {
    final wanted =
        (widget.ticks ?? !kUnderTest) &&
        !c.away &&
        TickerMode.valuesOf(context).enabled &&
        widget.app?.foreground.value != false;
    if (!wanted) {
      _tick?.cancel();
      _tick = null;
    } else {
      _tick ??= Timer.periodic(
        const Duration(seconds: 1),
        (_) => _redrawMoved(),
      );
    }
  }

  /// A machine reported, or the Swarm came on screen or left it. Told outside
  /// a build but for that last, which may come from one.
  void _machinesMoved() {
    if (!mounted) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _machinesMoved());
      return;
    }
    _syncTick();
    _redrawMoved();
    if (!c.away &&
        _timer?.isActive != true &&
        !_reading &&
        widget.app?.foreground.value == true &&
        (!kUnderTest || widget.readLocal != null)) {
      unawaited(_refresh());
    }
  }

  /// Redraws what no longer says what it drew, and nothing else.
  void _redrawMoved() {
    if (!mounted || c.snapshot == null || c.accessRevoked) return;
    final views = _sortedViews();
    final groups = [
      for (final (key, _, group) in _groups(views))
        for (final v in group) '$key/${v.id}',
    ];
    if (_manageLayoutDrawn != _machineLayout(views) ||
        !listEquals(_groupsDrawn, groups)) {
      _changed();
      return;
    }
    for (final view in views) {
      if (_rowsDrawn[view.id] != _rowWords(view)) {
        _rowBeats[view.id]?.value++;
      }
    }
  }

  /// Everything a row's look goes by, but for what a rebuild of the list says.
  Object _rowWords(_MachineView view) => Object.hashAll([
    view.name,
    view.status,
    view.readingAt,
    // A line not online says when it was last seen, an age the one-second tick moves.
    if (view.readingAt case final at?
        when _machineStatusGroup(view) != 'online')
      superTabAgo(widget.now().difference(at)),
    view.paused,
    view.cleaning,
    view.dim,
    view.details,
    view.tip,
    view.agents.length,
    view.resources?.diskTotalBytes,
    view.resources?.diskFreeBytes,
    view.resources?.projectDiskTotalBytes,
    view.resources?.projectDiskFreeBytes,
  ]);

  void _foreground() {
    _syncTick();
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
      // A Swarm that isn't showing reads nothing; coming back reads at once ([_machinesMoved]).
      if (mounted && !c.away && widget.app?.foreground.value == true) {
        _timer = Timer(const Duration(seconds: 15), _refresh);
      }
    }
  }

  @override
  void dispose() {
    _menuHolds.forEach(BrowserMenuGuard.release);
    _menuHolds.clear();
    _revision++;
    _timer?.cancel();
    _tick?.cancel();
    c.machinesChanged.removeListener(_machinesMoved);
    for (final beat in _rowBeats.values) {
      beat.dispose();
    }
    widget.app?.foreground.removeListener(_foreground);
    super.dispose();
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
            ? "${person.shownName}'s computer"
            : 'Unavailable machine');
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
    return _MachineView(
      apiModels: apiModels,
      localModels: localModels,
      id: id,
      name: name,
      owner: person,
      contributor: contributor,
      shared: shared,
      agents: agents,
      status: status,
      readingAt: readingAt,
      paused: paused,
      cleaning: cleaning,
      dim: dim,
      details: details,
      resources: value,
      // The engines it was added with, as Add machine sent them.
      engines: (shared?['engines'] as List?)
          ?.whereType<String>()
          .where(_swarmEngines.contains)
          .toList(),
      // What the line leaves out, for hover, focus and a screen reader: whose machine it is and its hardware,
      // after its state when that is not online. Never an age. Only current readings are included.
      tip: [
        if (cleaning) 'Cleaning up' else ?superTabMachineTip(status),
        if (person != null) 'Owned by ${person.shownName}',
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
      '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/machines/${Uri.encodeComponent(machineId)}/removal/v2',
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
                  final blockedReason =
                      preview?.blockedReason ??
                      (preview?.blockedProjectName == null
                          ? null
                          : 'This machine runs the ${c.snapshot?.coordinatorNameOf(preview!.blockedProjectId ?? '') ?? kDefaultCoordinatorName} of project ${preview!.blockedProjectName}. Delete the project first.');
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
                              if (reason != null)
                                Text(reason)
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
                                if (blockedReason != null) Text(blockedReason),
                                const Text(
                                  'The Swarm stops using this machine for new work.',
                                ),
                                if (preview.agents.isNotEmpty) ...[
                                  const SizedBox(height: 12),
                                  const Text('These agents will stop:'),
                                  for (final agent in preview.agents) ...[
                                    const SizedBox(height: 4),
                                    Text(
                                      agent.projectName.isEmpty
                                          ? agent.name
                                          : '${agent.name} · ${agent.projectName}',
                                    ),
                                    if (agent.task != null)
                                      Text(
                                        'The open task “${agent.task}” loses its agent.',
                                      ),
                                  ],
                                ],
                                if (preview.hiddenAgentCount > 0) ...[
                                  const SizedBox(height: 12),
                                  Text(
                                    preview.hiddenAgentCount == 1
                                        ? '1 agent of a project you can\'t see will stop.'
                                        : '${preview.hiddenAgentCount} agents of projects you can\'t see will stop.',
                                  ),
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
                                if (preview.hiddenSoleSourceProjectCount >
                                    0) ...[
                                  const SizedBox(height: 12),
                                  Text(
                                    preview.hiddenSoleSourceProjectCount == 1
                                        ? '1 project you can\'t see has code only on this machine.'
                                        : '${preview.hiddenSoleSourceProjectCount} projects you can\'t see have code only on this machine.',
                                  ),
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
    // The menu's barrier takes the pointer from the row, so a second right-click would bring up the browser's menu
    // over this one. Off until it closes; dispose lets go too, for a screen that goes with the menu still up.
    final hold = Object();
    _menuHolds.add(hold);
    BrowserMenuGuard.hold(hold);
    final String? choice;
    try {
      choice = await showContextMenuAt<String>(
        context: context,
        at: at,
        width: 240,
        children: (close) => [
          AppMenuItem(
            label: 'Details',
            leadingSlot: false,
            onPressed: () => close('details'),
          ),
          if (_canRemove(view.id))
            AppMenuItem(
              key: const ValueKey('super-machine-menu-remove'),
              label: 'Remove from Swarm',
              detail: _removeReason(view.id),
              leadingSlot: false,
              onPressed: _removeReason(view.id) == null
                  ? () => close('remove')
                  : null,
            ),
        ],
      );
    } finally {
      _menuHolds.remove(hold);
      BrowserMenuGuard.release(hold);
    }
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
    final details = v.details, value = v.resources, engines = v.engines;
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
                owner: person?.shownName,
                status: details,
                // Details follow the same freshness rule as the row and its disclosure.
                resources: dim ? null : value,
                engines: engines,
                footer: SuperTabMachineLocalModels(
                  controller: c,
                  machineId: id,
                  now: widget.now,
                ),
              ),
              // Its rarer actions, quiet at the left (Ken, 2026-10-28).
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

  /// Where a long press opens the menu: under the middle of the row, which the touch gives no point for.
  Offset _longPressAt(BuildContext rowContext) {
    final box = rowContext.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return Offset.zero;
    return box.localToGlobal(Offset(box.size.width / 2, box.size.height));
  }

  Widget _machine(_MachineView view) {
    final tipKey = _tips.putIfAbsent(view.id, GlobalKey<TooltipState>.new);
    final expanded = c.isMachineExpanded(view.id);
    final selected = _selectedMachineId == view.id;
    final row = BrowserMenuOff(
      active: true,
      child: _RowHoverRegion(
        child: Material(
          key: ValueKey('machines-surface-${view.id}'),
          shape: RoundedRectangleBorder(
            borderRadius: MachinesStyle.radius,
            side: _focusedMachineId == view.id
                ? BorderSide(color: MachinesStyle.accent, width: 2)
                : BorderSide.none,
          ),
          color: view.owner?.id == c.accountId
              ? MachinesStyle.selected
              : selected
              ? grid.AppSurface.selectedFill
              : Colors.transparent,
          clipBehavior: Clip.antiAlias,
          // No chevron (Dee, 2026-10-27): a click expands the machine, and its
          // details are in the right-click menu, or a long press on a touch screen.
          child: Builder(
            builder: (rowContext) => CallbackShortcuts(
              bindings: {
                const SingleActivator(LogicalKeyboardKey.contextMenu): () =>
                    unawaited(_menu(view, _longPressAt(rowContext))),
                const SingleActivator(
                  LogicalKeyboardKey.f10,
                  shift: true,
                ): () =>
                    unawaited(_menu(view, _longPressAt(rowContext))),
              },
              child: InkWell(
                key: ValueKey('super-machine-${view.id}'),
                onTap: () {
                  c.toggleMachineExpanded(view.id);
                  _changed();
                },
                onLongPress: () =>
                    unawaited(_menu(view, _longPressAt(rowContext))),
                onSecondaryTapUp: (event) =>
                    unawaited(_menu(view, event.globalPosition)),
                hoverColor: grid.AppSurface.hoverFill,
                focusColor: grid.AppSurface.hoverFill,
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                onFocusChange: (focused) {
                  if (focused &&
                      FocusManager.instance.highlightMode ==
                          FocusHighlightMode.traditional) {
                    _focusedMachineId = view.id;
                  } else if (_focusedMachineId == view.id) {
                    _focusedMachineId = null;
                  }
                  _rowBeats[view.id]?.value++;
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
                  child: _ManageMachineLine(
                    view: view,
                    name:
                        _manageNames[view.id] ?? superTabMachineName(view.name),
                    own: view.owner?.id == c.accountId,
                    local: widget.app?.stateOf(view.id)?.isLocalMachine == true,
                    now: widget.now(),
                    port: widget.app
                        ?.stateOf(view.id)
                        ?.localEndpoint
                        ?.wsUri
                        .port,
                    onMore: (at) => _menu(view, at),
                  ),
                ),
              ),
            ),
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
                  : _machineStatusGroup(view)
                        .replaceAll('unknown', 'status unknown'),
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
        // The rest of the machine belongs to its menu too: a right-click on its readings is not the browser's.
        if (expanded)
          BrowserMenuOff(
            active: true,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onSecondaryTapUp: (event) =>
                  unawaited(_menu(view, event.globalPosition)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
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
              ),
            ),
          ),
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
    final total = count == 1 ? '1 agent' : '$count agents';
    // What is happening now, not only how many exist. A machine that reads offline runs nothing, whatever its agents
    // last did, unless a session this Desktop holds says one is working (the list below says the same); one the
    // Desktop cannot read says only the total, since nothing is known of what they do.
    final working = view.agents
        .where(
          (agent) => switch (_activity(view, agent)) {
            HarnessActivity.working || HarnessActivity.starting => true,
            _ => false,
          },
        )
        .length;
    final offline =
        view.status == SuperTabMachineStatus.offline && working == 0;
    final label = offline
        ? '$total · none running, machine offline'
        : view.status == SuperTabMachineStatus.live ||
              view.status == SuperTabMachineStatus.late ||
              view.status == SuperTabMachineStatus.offline
        ? '$total · $working working'
        : total;
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
                            style: DesktopChrome.control(
                              color: offline ? DesktopChrome.muted : null,
                            ),
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

  /// [view]'s agents under Working, Waiting, Idle and Kept (closed), each by name; a group with none is left out.
  List<Widget> _agentGroups(_MachineView view) {
    final groups = <String, List<(SuperTabAgent, HarnessActivity)>>{
      'Working': [],
      'Waiting': [],
      'Idle': [],
      'Kept (closed)': [],
    };
    for (final agent in view.agents) {
      final activity = _activity(view, agent);
      groups[switch (activity) {
            HarnessActivity.working || HarnessActivity.starting => 'Working',
            HarnessActivity.needsInput || HarnessActivity.failed => 'Waiting',
            // A kept agent whose session is closed on a machine that is
            // there: the Swarm removes the others, so this one says so.
            _ when agent.keptClosed && activity != HarnessActivity.offline =>
              'Kept (closed)',
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
  List<_MachineView> _sortedViews() {
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
    return views;
  }

  /// Status first (Scholes, task #3801): the reader's own machines pinned in Yours, then Online, Status unknown and
  /// Offline, each under a heading with its count. A group with no machine has no heading.
  List<(String, String, List<_MachineView>)> _groups([
    List<_MachineView>? sorted,
  ]) {
    final views = sorted ?? _sortedViews();
    final yours = <_MachineView>[];
    final online = <_MachineView>[];
    final asleep = <_MachineView>[];
    final unknown = <_MachineView>[];
    final offline = <_MachineView>[];
    for (final view in views) {
      if (!_matchesMachine(view)) continue;
      if (view.owner?.id != null && view.owner?.id == c.accountId) {
        yours.add(view);
      } else {
        (switch (view.status) {
          SuperTabMachineStatus.late => asleep,
          SuperTabMachineStatus.unknown => unknown,
          SuperTabMachineStatus.offline => offline,
          _ => online,
        }).add(view);
      }
    }
    return [
      ('yours', 'Yours', yours),
      ('online', 'Online', online),
      ('asleep', 'Asleep', asleep),
      ('unknown', 'Status unknown', unknown),
      ('offline', 'Offline', offline),
    ].where((g) => g.$3.isNotEmpty).toList();
  }

  /// A group's heading, announced as one.
  Widget _groupHeading(String key, String label, int count) => Semantics(
    key: ValueKey('super-machines-group-$key'),
    header: true,
    container: true,
    child: Padding(
      padding: MachinesStyle.groupInset,
      child: Text(
        key == 'yours' ? 'YOUR MACHINE' : '${label.toUpperCase()} · $count',
        style: MachinesStyle.small(heading: true),
      ),
    ),
  );

  /// Before the Swarm is read, a loading list; a Swarm that cannot be read and holds no machine says so with Retry,
  /// even when an earlier read found none; a read Swarm with none, the empty note (task #3801). Null when there are
  /// machines to list.
  Widget? _stateNote() {
    if (_ids.isNotEmpty) return null;
    if (c.backendUnreachable) {
      return Padding(
        key: const ValueKey('super-machines-error'),
        padding: MachinesStyle.headerInset,
        // Wraps: in a narrow window with large text, Retry goes under the sentence rather than squeezing it.
        child: Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              "Couldn't read this Swarm's machines.",
              style: DesktopChrome.metadata(),
            ),
            TextButton(
              key: const ValueKey('super-machines-retry'),
              onPressed: () => unawaited(c.refresh()),
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }
    if (c.snapshot == null) {
      return SkeletonList(
        key: const ValueKey('super-machines-loading'),
        rows: 3,
        itemBuilder: (_, i) => SizedBox(
          key: ValueKey('machines-loading-row-$i'),
          height: 56,
          child: const SkeletonListTile(
            leading: 8,
            padding: MachinesStyle.rowInset,
          ),
        ),
      );
    }
    return Padding(
      padding: MachinesStyle.headerInset,
      child: Text(
        "Add a machine for this Swarm's agents to use.",
        style: DesktopChrome.metadata(),
      ),
    );
  }

  /// One row each, redrawn on its own ([_redrawMoved]), under its group's heading.
  List<Widget> _machines([List<_MachineView>? sorted]) {
    final groups = _groups(sorted);
    _orderDrawn = [
      for (final (_, _, views) in groups)
        for (final v in views) v.id,
    ];
    _groupsDrawn = [
      for (final (key, _, views) in groups)
        for (final v in views) '$key/${v.id}',
    ];
    _rowBeats.removeWhere((id, beat) {
      if (_orderDrawn.contains(id)) return false;
      beat.dispose();
      return true;
    });
    return [
      for (final (key, label, views) in groups) ...[
        _groupHeading(key, label, views.length),
        for (final id in [for (final v in views) v.id])
          ValueListenableBuilder<int>(
            key: ValueKey('super-machine-row-$id'),
            valueListenable: _rowBeats.putIfAbsent(id, () => ValueNotifier(0)),
            builder: (context, _, _) {
              final view = _view(id);
              _rowsDrawn[id] = _rowWords(view);
              return _machine(view);
            },
          ),
      ],
    ];
  }

  @override
  Widget build(BuildContext context) {
    final add = c.canWrite && widget.app != null
        ? () => unawaited(showAddComputers(context, c, widget.app!))
        : null;
    return _manageScreen(add);
  }
}

/// The server's removal preview is authoritative for the confirmation.
class _RemovalPreview {
  const _RemovalPreview({
    required this.blockedProjectName,
    this.blockedProjectId,
    this.blockedReason,
    required this.agents,
    required this.hiddenAgentCount,
    required this.soleSourceProjects,
    required this.hiddenSoleSourceProjectCount,
  });

  factory _RemovalPreview.fromMap(Map<String, dynamic> value) {
    if (value['previewVersion'] != 2 ||
        value['agents'] is! List ||
        value['soleSourceProjects'] is! List) {
      throw const FormatException('Invalid machine removal preview');
    }
    final blocked = value['blockedBy'];
    if (blocked != null && blocked is! Map) {
      throw const FormatException('Invalid machine removal preview');
    }
    final blockedMap = blocked == null ? null : superTabMap(blocked);
    final blockedName = blockedMap?['projectName'];
    final blockedReason = blockedMap?['reason'];
    if (blocked != null &&
        !((blockedName is String && blockedName.isNotEmpty) ||
            (blockedReason is String && blockedReason.isNotEmpty))) {
      throw const FormatException('Invalid machine removal preview');
    }
    final hiddenAgentCount = value['hiddenAgentCount'] ?? 0;
    final hiddenSoleSourceProjectCount =
        value['hiddenSoleSourceProjectCount'] ?? 0;
    if (hiddenAgentCount is! int ||
        hiddenAgentCount < 0 ||
        hiddenSoleSourceProjectCount is! int ||
        hiddenSoleSourceProjectCount < 0) {
      throw const FormatException('Invalid machine removal preview');
    }
    final agents = <_RemovalAgent>[];
    for (final item in value['agents'] as List) {
      final agent = superTabMap(item);
      final name = agent['name'], projectName = agent['projectName'];
      final task = agent['task'];
      // A Swarm-wide Buddy has no project: the server sends an empty name.
      if (name is! String ||
          name.isEmpty ||
          projectName is! String ||
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
      blockedProjectId: switch (blockedMap) {
        {'projectId': final String id} => id,
        _ => null,
      },
      blockedReason: blockedReason as String?,
      agents: agents,
      hiddenAgentCount: hiddenAgentCount,
      soleSourceProjects: projects,
      hiddenSoleSourceProjectCount: hiddenSoleSourceProjectCount,
    );
  }

  final String? blockedProjectName;

  /// The project whose coordinator runs there, to call it what that project calls it.
  final String? blockedProjectId;
  final String? blockedReason;
  final List<_RemovalAgent> agents;
  final int hiddenAgentCount;
  final List<String> soleSourceProjects;
  final int hiddenSoleSourceProjectCount;
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
    required this.paused,
    required this.cleaning,
    required this.dim,
    required this.details,
    required this.resources,
    required this.engines,
    required this.tip,
    this.apiModels = const [],
    this.localModels = const [],
  });

  final String id, name, details, tip;

  final SuperTabPerson? owner;
  final String? contributor;
  final Map<String, dynamic>? shared;
  final List<SuperTabAgent> agents;
  final SuperTabMachineStatus status;

  /// When the reading shown was taken, and whether that is just now (the dot pings once).
  final DateTime? readingAt;
  final bool paused, cleaning;

  /// Offline, unknown or refreshing: its numbers are old.
  final bool dim;
  final MachineResources? resources;
  final List<String>? engines;

  /// What this machine offers the Swarm on its grid, as its reading says: the APIs its person shares, and its own
  /// models running for the Swarm (docs/plans/2026-10-23-swarm-local-models.md). Empty while the add-on is off.
  final List<_ServedModel> apiModels, localModels;
}

/// A model a machine offers its Swarm: its short name on the row, the whole of it on hover.
/// [starting]: run or shared here, not yet listed by the Swarm's grid (CLI `superTabs/machines.ts`).
typedef _ServedModel = ({String name, String tip, bool starting});

/// The ⋯ on a machine row. It takes no room until the row is pointed at or the button has focus, and stays in the
/// focus order the whole time, so a key can reach it.
class _MachineMore extends StatefulWidget {
  const _MachineMore({super.key, required this.onOpen});

  final Future<void> Function(Offset at) onOpen;

  /// The button's width and height when shown: [AppIconButton]'s target.
  static const width = 32.0;

  @override
  State<_MachineMore> createState() => _MachineMoreState();
}

class _MachineMoreState extends State<_MachineMore> {
  bool _focused = false;

  /// With its menu up the row loses the pointer to the menu's barrier; the ⋯ stays, so the row does not jump.
  bool _open = false;

  Future<void> _press() async {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return;
    setState(() => _open = true);
    try {
      await widget.onOpen(box.localToGlobal(Offset(0, box.size.height)));
    } finally {
      if (mounted) setState(() => _open = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // A touch screen has nothing to hover (Huy, 2026-11-02): the ⋯ stays, a finger's size.
    final touch = BrowserMenuGuard.onTouchScreen;
    final shown = touch || _focused || _open || _RowHover.of(context);
    final extent = touch ? kFingerTarget : _MachineMore.width;
    final button = AppIconButton(
      icon: AppIcons.ellipsis,
      tooltip: 'More',
      size: 16,
      onPressed: () => unawaited(_press()),
    );
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onFocusChange: (focused) => setState(() => _focused = focused),
      child: SizedBox(
        width: shown ? extent : 0,
        height: extent,
        child: OverflowBox(
          alignment: Alignment.centerRight,
          minWidth: extent,
          maxWidth: extent,
          child: Opacity(
            opacity: shown ? 1 : 0,
            child: IgnorePointer(
              ignoring: !shown,
              child: touch
                  ? GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => unawaited(_press()),
                      child: Center(child: button),
                    )
                  : button,
            ),
          ),
        ),
      ),
    );
  }
}

/// Whether the pointer is over the row below it.
class _RowHover extends InheritedWidget {
  const _RowHover({required this.hovered, required super.child});

  final bool hovered;

  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_RowHover>()?.hovered ?? false;

  @override
  bool updateShouldNotify(_RowHover oldWidget) => hovered != oldWidget.hovered;
}

/// Tells [_RowHover] readers below it when the pointer enters and leaves.
class _RowHoverRegion extends StatefulWidget {
  const _RowHoverRegion({required this.child});

  final Widget child;

  @override
  State<_RowHoverRegion> createState() => _RowHoverRegionState();
}

class _RowHoverRegionState extends State<_RowHoverRegion> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) => MouseRegion(
    opaque: false,
    onEnter: (_) => setState(() => _hovered = true),
    onExit: (_) => setState(() => _hovered = false),
    child: _RowHover(hovered: _hovered, child: widget.child),
  );
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
    // Offline or out of reach, no hardware shows: its figures are old.
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
    final sections = <(String, Widget Function(double))>[
      if (hardware.isNotEmpty)
        (
          'Hardware',
          (width) => _grid(width, width >= 300 ? 4 : 2, [
            for (final reading in hardware) _hardware(reading),
          ]),
        ),
      if (!view.dim &&
          (view.apiModels.isNotEmpty || view.localModels.isNotEmpty))
        (
          'Models for the Swarm',
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
    // Offline or out of reach with no models: nothing current to show.
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
                  for (final (index, (title, body)) in sections.indexed) ...[
                    if (index > 0) const SizedBox(height: 14),
                    Text(
                      title,
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
