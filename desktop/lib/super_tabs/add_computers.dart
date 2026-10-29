import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/machine_resources.dart';
import '../models/model_search_catalog.dart' show thisComputerName;
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/link_another_machine_dialog.dart' show kHarnessDownloadUrl;
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'machines.dart' show contributeComputer;

/// Where one of the reader's computers stands in Add your computers.
enum AddComputerStatus { ready, offline, unlinked, added }

/// One row of Add your computers: a computer signed in to the reader's own
/// account. [note] is a second line in plain words, such as why teammates'
/// work does not run there yet.
class AddComputerRow {
  const AddComputerRow({
    required this.id,
    required this.name,
    required this.status,
    required this.here,
    this.note,
  });
  final String id, name;
  final AddComputerStatus status;

  /// The computer running this app.
  final bool here;
  final String? note;
}

/// The privacy line under the title. It has to be true for every computer the
/// box adds: in a Swarm that uses Harness Team accounts each one is added as
/// Team account only, so teammates' work runs only in that separate account;
/// elsewhere it runs signed in as the reader.
String addComputersPrivacyLine({required bool teamAccounts}) => teamAccounts
    ? "Teammates' agents use them when they're free, in a separate account "
          "that can't see your files."
    : "Teammates' agents use them when they're free, signed in as you.";

/// Why teammates' work does not run on an added computer yet, from the
/// Swarm's refusal code (backend superTabs/machines.ts `teamWorkRefusal`) and,
/// for this computer, what its daemon remembers of the Team account setup.
/// Null when it does run there, or for a code this build does not know.
String? _teamNote(Object? code, ({String state, String? detail})? setup) {
  const only = 'so only your projects run here.';
  return switch (code) {
    'TEAM_ACCOUNT_REQUIRED' => switch (setup?.state) {
      'failed' => 'Team account setup failed, $only',
      'running' => 'Setting up its Team account, $only',
      _ => 'No Team account yet, $only',
    },
    'PRIVACY_UNCHECKED' =>
      'Its Team account hasn’t passed the privacy check yet, $only',
    'PRIVACY_CHECK_FAILED' =>
      'Its Team account failed the privacy check, $only',
    'PRIVACY_CHECK_STALE' =>
      'Its Team account’s privacy check is out of date, $only',
    'MACHINE_OFFLINE' => 'Its Team account is offline, $only',
    _ => null,
  };
}

/// The rows of Add your computers: every computer signed in to the reader's
/// own account, never another account's, and a Mac's Harness Team account
/// only inside its Mac's row. This computer comes first while it is not
/// added; then those that can be added, those that cannot yet, and those
/// already in the Swarm. [added] are computers this box has just added.
List<AddComputerRow> addComputerRows(
  AppNotifier app,
  SuperTabController c, {
  Set<String> added = const {},
  ({String state, String? detail})? teamSetup,
}) {
  final snapshot = c.snapshot;
  final pools = snapshot?.machines ?? const <Map<String, dynamic>>[];
  final teamAccounts = snapshot?.teamAccounts ?? false;
  final rows = <AddComputerRow>[];
  for (final m in app.machineStates.values) {
    final id = m.machine.machineId;
    if (m.belongsToOtherAccount || m.machine.isTeamAccount) continue;
    if ((snapshot?.placeOf(id) ?? id) != id) continue;
    final here = m.isLocalMachine;
    final inSwarm =
        added.contains(id) || pools.any((p) => p['machineId'] == id);
    final status = inSwarm
        ? AddComputerStatus.added
        : m.needsLink
        ? AddComputerStatus.unlinked
        : m.isOffline
        ? AddComputerStatus.offline
        : AddComputerStatus.ready;
    String? note;
    if (teamAccounts && inSwarm) {
      final pool = pools.where((p) => p['machineId'] == id).firstOrNull;
      final team = pools.where((p) => p['hostMachineId'] == id).firstOrNull;
      final work = (team ?? pool)?['teamWork'];
      if (work is Map && work['allowed'] == false) {
        note = _teamNote(work['code'], here ? teamSetup : null);
      }
    } else if (teamAccounts && here && teamSetup?.state == 'failed') {
      note = 'Team account setup failed, so only your projects will run here.';
    }
    final name = superTabMachineName(m.machine.displayName);
    final label = thisComputerName();
    rows.add(
      AddComputerRow(
        id: id,
        name: here
            ? '${label[0].toUpperCase()}${label.substring(1)} · $name'
            : name,
        status: status,
        here: here,
        note: note,
      ),
    );
  }
  int rank(AddComputerRow r) => switch (r.status) {
    _ when r.here && r.status != AddComputerStatus.added => 0,
    AddComputerStatus.ready => 1,
    AddComputerStatus.offline || AddComputerStatus.unlinked => 2,
    AddComputerStatus.added => r.here ? 3 : 4,
  };
  rows.sort(
    (a, b) => rank(a) != rank(b)
        ? rank(a) - rank(b)
        : a.name.toLowerCase() != b.name.toLowerCase()
        ? a.name.toLowerCase().compareTo(b.name.toLowerCase())
        : a.id.compareTo(b.id),
  );
  return rows;
}

/// Add your computers (Dee, 10-29): the reader's other computers, added to
/// the Swarm in one step with today's defaults, one at a time. Their first
/// computer never comes through here: joining or creating a Swarm adds it.
/// [readResources] stands in for [AppNotifier.readMachineResources] and
/// [openDownload] for opening the download page.
Future<void> showAddComputers(
  BuildContext context,
  SuperTabController c,
  AppNotifier app, {
  Future<MachineResources?> Function(String machineId)? readResources,
  void Function(Uri url)? openDownload,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    child: _AddComputers(
      controller: c,
      app: app,
      readResources: readResources,
      openDownload: openDownload,
    ),
  ),
);

class _AddComputers extends StatefulWidget {
  const _AddComputers({
    required this.controller,
    required this.app,
    this.readResources,
    this.openDownload,
  });
  final SuperTabController controller;
  final AppNotifier app;
  final Future<MachineResources?> Function(String machineId)? readResources;
  final void Function(Uri url)? openDownload;

  @override
  State<_AddComputers> createState() => _AddComputersState();
}

class _AddComputersState extends State<_AddComputers> {
  SuperTabController get c => widget.controller;
  AppNotifier get app => widget.app;

  /// The account that opened the box: another one signing in closes it.
  late final String? _accountId = app.currentUser?.id;

  /// Ticks the person changed; every other row that can be added is ticked.
  final _ticks = <String, bool>{};

  /// Added from here, before the Swarm's next read shows them.
  final _added = <String>{};
  final _errors = <String, String>{};

  /// Each computer's setup, kept between tries so one still running is
  /// joined rather than started again.
  final _setups = <String, String>{};
  String? _adding;
  bool _busy = false, _closing = false;
  ({String state, String? detail})? _teamSetup;

  @override
  void initState() {
    super.initState();
    unawaited(_readTeamSetup());
  }

  /// Only this computer's own daemon is asked, and only where its Team
  /// account can be made; one that cannot say leaves the Swarm's own line.
  Future<void> _readTeamSetup() async {
    if (!app.canSetUpTeamAccount) return;
    final read = await app.teamSetupStatus();
    if (mounted) setState(() => _teamSetup = read);
  }

  bool get _sameAccount => app.currentUser?.id == _accountId;

  /// Whether adding may go on: the box is open, for the same account, which
  /// may still change this Swarm.
  bool _alive() => mounted && !_closing && _sameAccount && c.canWrite;

  List<AddComputerRow> get _rows =>
      addComputerRows(app, c, added: _added, teamSetup: _teamSetup);

  bool _ticked(AddComputerRow row) =>
      row.status == AddComputerStatus.ready && (_ticks[row.id] ?? true);

  Future<void> _add() async {
    final ids = [
      for (final row in _rows)
        if (_ticked(row)) row.id,
    ];
    if (_busy || ids.isEmpty || !_alive()) return;
    setState(() {
      _busy = true;
      for (final id in ids) {
        _errors.remove(id);
      }
    });
    final teamAccountOnly = c.snapshot?.teamAccounts ?? false;
    for (final id in ids) {
      // A computer that went offline meanwhile waits for the next try.
      final still = _rows.where((r) => r.id == id && _ticked(r)).firstOrNull;
      if (still == null) continue;
      if (!_alive()) break;
      setState(() => _adding = id);
      try {
        final setupId = _setups[id] ??= superTabOperationId();
        final done = await contributeComputer(
          c,
          app,
          id,
          setupId: setupId,
          alive: _alive,
          teamAccountOnly: teamAccountOnly,
          readResources: widget.readResources,
        );
        _setups.remove(id);
        if (done == null) break;
        _added.add(id);
      } catch (failure) {
        if (failure is! SuperTabFailure || failure.code != 'SETUP_PENDING') {
          _setups.remove(id);
        }
        _errors[id] = failure.toString();
      }
    }
    // One fresh read of the Swarm after a failure: an add whose reply was
    // lost may be there all the same.
    if (_errors.keys.any(ids.contains) && _alive()) {
      try {
        await c.refresh();
      } catch (_) {
        // The rows keep their reasons; the next try checks again.
      }
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _adding = null;
    });
    // Done once every one is in the Swarm: an add whose reply was lost may
    // show up there all the same.
    final inSwarm = {
      for (final row in _rows)
        if (row.status == AddComputerStatus.added) row.id,
    };
    if (_alive() && ids.every(inSwarm.contains)) Navigator.pop(context);
  }

  void _close() {
    _closing = true;
    Navigator.pop(context);
  }

  void _download() {
    final open = widget.openDownload;
    if (open != null) return open(kHarnessDownloadUrl);
    unawaited(
      launchUrl(
        kHarnessDownloadUrl,
        mode: LaunchMode.externalApplication,
      ).catchError((_) => false),
    );
  }

  String _statusOf(AddComputerRow row) {
    if (row.id == _adding) return 'adding…';
    return switch (row.status) {
      AddComputerStatus.ready => 'online',
      AddComputerStatus.offline => 'offline · turn it on to add',
      AddComputerStatus.unlinked => 'not linked · link it in Machines',
      AddComputerStatus.added => 'added',
    };
  }

  Widget _row(AddComputerRow row) {
    final ready = row.status == AddComputerStatus.ready;
    final canTick = ready && !_busy;
    void toggle() => setState(() => _ticks[row.id] = !_ticked(row));
    // A computer in the Swarm has nothing left to fail.
    final error = row.status == AddComputerStatus.added
        ? null
        : _errors[row.id];
    final note = error != null ? 'Couldn’t add: $error' : row.note;
    return KeyedSubtree(
      key: ValueKey('add-computer-${row.id}'),
      child: InkWell(
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        onTap: canTick ? toggle : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: grid.AppDesktop.listRowGap,
          ),
          child: Row(
            children: [
              SizedBox.square(
                dimension: grid.AppControl.height,
                child: row.status == AddComputerStatus.added
                    ? Icon(
                        AppIcons.circleCheck,
                        size: grid.AppControl.iconSize,
                        semanticLabel: 'Added',
                      )
                    : Checkbox(
                        value: _ticked(row),
                        onChanged: canTick ? (_) => toggle() : null,
                        semanticLabel: row.name,
                      ),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              Expanded(
                flex: 3,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      row.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.control(
                        color: ready || row.status == AddComputerStatus.added
                            ? null
                            : DesktopChrome.muted,
                      ),
                    ),
                    if (note != null)
                      Text(
                        note,
                        style: DesktopChrome.metadata(
                          color: error != null ? grid.AppPalette.warn : null,
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              Flexible(
                flex: 2,
                child: Text(
                  _statusOf(row),
                  textAlign: TextAlign.end,
                  style: DesktopChrome.metadata(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app, c]),
    builder: (context, _) {
      // Another account signed in: nothing of this one's stays on screen.
      if (!_sameAccount) {
        if (!_closing) {
          _closing = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) Navigator.pop(context);
          });
        }
        return const SizedBox.shrink();
      }
      final rows = _rows;
      final count = rows.where(_ticked).length;
      final listError = app.machineListError;
      return SuperTabDetailDialog(
        title: 'Add your computers',
        onClose: _close,
        body: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              addComputersPrivacyLine(
                teamAccounts: c.snapshot?.teamAccounts ?? false,
              ),
              style: DesktopChrome.text(),
            ),
            const SizedBox(height: grid.AppDesktop.groupGap),
            for (final row in rows) _row(row),
            if (listError != null) ...[
              const SizedBox(height: grid.AppDesktop.controlGap),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Couldn’t check your computers just now.',
                      style: DesktopChrome.metadata(),
                    ),
                  ),
                  TextButton(
                    onPressed: () => unawaited(app.retryMachines()),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ],
            const SizedBox(height: grid.AppDesktop.groupGap),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Not listed? Install Harness on it and sign in as you. '
                    'It shows up here.',
                    style: DesktopChrome.metadata(),
                  ),
                ),
                const SizedBox(width: grid.AppDesktop.controlGap),
                TextButton(
                  onPressed: _download,
                  child: const Text('Get Harness'),
                ),
              ],
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: _close, child: const Text('Cancel')),
          FilledButton(
            key: const ValueKey('add-computers'),
            onPressed: _busy || count == 0 || !c.canWrite
                ? null
                : () => unawaited(_add()),
            child: Text(
              _busy
                  ? 'Adding…'
                  : count == 0
                  ? 'Add'
                  : 'Add $count',
            ),
          ),
        ],
      );
    },
  );
}
