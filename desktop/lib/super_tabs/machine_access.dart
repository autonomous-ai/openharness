import 'dart:async';

import 'package:flutter/foundation.dart' show mapEquals;
import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';

/// What a machine can reach, by macOS account (task #3047, docs/design/2026-11-05-machine-access.md): short names people
/// already use ("Lamp", "Fusion 360", "Email (dee@)"), kept on the Mac's own entry in the Swarm (backend
/// machineAccess.ts `AccessEntry`), both accounts' entries there. The server leaves out `note` for everyone but the
/// owner and the agents running in that entry's account; having access listed grants no permission.
class SuperTabAccessEntry {
  const SuperTabAccessEntry({
    required this.id,
    required this.name,
    required this.team,
    required this.state,
    this.teammates = false,
    this.production = false,
    this.note,
    this.saidBy,
  });

  final String id, name;

  /// In the Mac's Harness Team account; otherwise in its owner's own account.
  final bool team;

  /// `ok` or `unconfirmed` (phase 1); a newer server's `notWorking` reads as not working, as any other state does.
  final String state;

  /// An own-account entry its owner lets teammates' tasks use, in the owner's account.
  final bool teammates;
  final bool production;
  final String? note;

  /// Who said an unconfirmed entry, for "waiting for you: Dee said it".
  final String? saidBy;

  bool get ok => state == 'ok';
  bool get unconfirmed => state == 'unconfirmed';

  /// The entries [pool] carries, in its order; none for a pool without a list, and none of a shape this app cannot read.
  static List<SuperTabAccessEntry> listOf(Map<String, dynamic>? pool) => [
    for (final raw
        in pool?['access'] is List ? pool!['access'] as List : const [])
      if (raw case {
        'id': final String id,
        'name': final String name,
        'account': final String account,
        'state': final String state,
      })
        SuperTabAccessEntry(
          id: id,
          name: name,
          team: account == 'team',
          state: state,
          teammates: raw['teammates'] == true,
          production: raw['production'] == true,
          note: switch (raw['note']) {
            final String note when note.trim().isNotEmpty => note.trim(),
            _ => null,
          },
          saidBy: raw['saidBy'] as String?,
        ),
  ];
}

/// [owner]'s first name, for "waiting for Gray"; null without one.
String? _firstName(String? owner) {
  final words = owner?.trim().split(RegExp(r'\s+'));
  return words == null || words.first.isEmpty ? null : words.first;
}

/// The expanded machine row's Access lines, seen by every member who sees the machine: one per account with entries,
/// its owner's own first and named as the row names its owner ([ownerName], their shown name), then its Team account.
/// "Gray's account: Fusion 360 · Email (dee@) waiting for Gray".
class SuperTabMachineAccessLines extends StatelessWidget {
  const SuperTabMachineAccessLines({
    super.key,
    required this.entries,
    required this.ownerName,
  });

  final List<SuperTabAccessEntry> entries;
  final String? ownerName;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final owner = ownerName?.trim();
    final waitingFor = _firstName(owner) ?? 'the owner';
    final quiet = DesktopChrome.text(
      size: 12,
      height: 1.35,
      color: DesktopChrome.muted,
    );
    final plain = DesktopChrome.text(size: 12, height: 1.35);
    Widget line(String label, List<SuperTabAccessEntry> listed) => Text.rich(
      TextSpan(
        children: [
          TextSpan(text: '$label: ', style: quiet),
          for (final (index, entry) in listed.indexed) ...[
            if (index > 0) TextSpan(text: ' · ', style: quiet),
            TextSpan(text: entry.name),
            if (entry.production) TextSpan(text: ' (production)', style: quiet),
            if (!entry.ok)
              TextSpan(
                text: entry.unconfirmed
                    ? ' waiting for $waitingFor'
                    : ' not working',
                style: quiet,
              ),
          ],
        ],
      ),
      style: plain,
    );
    final own = [
      for (final e in entries)
        if (!e.team) e,
    ];
    final team = [
      for (final e in entries)
        if (e.team) e,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (own.isNotEmpty)
          line(
            owner == null || owner.isEmpty
                ? "Owner's account"
                : "$owner's account",
            own,
          ),
        if (own.isNotEmpty && team.isNotEmpty) const SizedBox(height: 4),
        if (team.isNotEmpty) line('Team account', team),
      ],
    );
  }
}

const _busyLine = 'Another action is still being sent. Try again in a moment.';

/// Sends one `machine.access` [command] as its owner, as `machine.ownAccountWork` is sent; null once the server took
/// it, else the server's refusal in its own words. A lost reply of this same change is checked again under its receipt.
Future<String?> _send(
  SuperTabController c,
  Map<String, dynamic> command,
) async {
  final retrying = c.hasPendingAction && mapEquals(c.pendingCommand, command);
  if (c.saving || (c.hasPendingAction && !retrying)) return _busyLine;
  final result = retrying ? await c.retry() : await c.command(command);
  if (result != null) return null;
  return c.operationError ?? "Couldn't change it. Try again.";
}

/// Configure's Access section, its owner's only (design section 6): what the Mac can reach, by account, each own-account
/// entry with Teammates may use, an entry someone else said with Confirm and Not right, and Add access…. Every change
/// is sent at once, as Projects that may use it is. Nothing for anyone else, nor for a Harness Team account's own
/// entry, whose list is on its Mac.
class SuperTabMachineAccessSetting extends StatefulWidget {
  const SuperTabMachineAccessSetting({
    super.key,
    required this.controller,
    required this.machineId,
    required this.machineName,
  });

  final SuperTabController controller;
  final String machineId;

  /// The machine as Configure titles it, for the warning before sharing.
  final String machineName;

  @override
  State<SuperTabMachineAccessSetting> createState() =>
      _SuperTabMachineAccessSettingState();
}

class _SuperTabMachineAccessSettingState
    extends State<SuperTabMachineAccessSetting> {
  bool _busy = false;
  String? _error;

  SuperTabController get c => widget.controller;

  Map<String, dynamic> _command(String action, SuperTabAccessEntry entry) => {
    'type': 'machine.access',
    'machineId': widget.machineId,
    'action': action,
    'entryId': entry.id,
  };

  Future<void> _change(Map<String, dynamic> command) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await _send(c, command);
    if (mounted) {
      setState(() {
        _busy = false;
        _error = error;
      });
    }
  }

  /// Teammates may use: on after the warning, naming the entry, which sends it itself; off at once.
  Future<void> _share(SuperTabAccessEntry entry, bool on) async {
    if (!on) {
      return _change({..._command('change', entry), 'teammates': false});
    }
    setState(() => _error = null);
    await showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        child: _ShareWarning(
          controller: c,
          entry: entry,
          machineName: widget.machineName,
          command: {..._command('change', entry), 'teammates': true},
        ),
      ),
    );
  }

  Future<void> _add(bool hasTeam) => showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      child: _AddAccess(
        controller: c,
        machineId: widget.machineId,
        hasTeam: hasTeam,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final snapshot = c.snapshot;
      final pool = snapshot?.pool(widget.machineId);
      if (snapshot == null ||
          pool == null ||
          pool['hostMachineId'] is String ||
          pool['contributorId'] != c.accountId ||
          !c.canWrite) {
        return const SizedBox.shrink();
      }
      final entries = SuperTabAccessEntry.listOf(pool);
      final hasTeam = snapshot.teamPoolsOf(widget.machineId).isNotEmpty;
      final own = [
        for (final e in entries)
          if (!e.team) e,
      ];
      final team = [
        for (final e in entries)
          if (e.team) e,
      ];
      String said(SuperTabAccessEntry e) {
        final who = snapshot.people
            .where((p) => p.id == e.saidBy)
            .firstOrNull
            ?.shownName;
        return who == null
            ? 'waiting for you'
            : 'waiting for you: $who said it';
      }

      Widget heading(String text) => Padding(
        padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
        child: Text(
          text,
          style: DesktopChrome.metadata().copyWith(fontWeight: FontWeight.w600),
        ),
      );

      return SuperTabDetailSection(
        key: const ValueKey('machine-access-section'),
        title: 'Access',
        children: [
          if (entries.isEmpty)
            Text(
              'Nothing listed yet. Add what this machine can reach, like Fusion 360 or Lamp, so tasks that need it run here.',
              style: DesktopChrome.metadata(),
            ),
          if (own.isNotEmpty) heading('Your account'),
          for (final e in own)
            _EntryRow(
              entry: e,
              state: e.unconfirmed ? said(e) : null,
              busy: _busy,
              onShare: (on) => unawaited(_share(e, on)),
              onConfirm: () => unawaited(_change(_command('confirm', e))),
              onRemove: () => unawaited(_change(_command('remove', e))),
            ),
          if (team.isNotEmpty) heading('Team account'),
          for (final e in team)
            _EntryRow(
              entry: e,
              state: e.unconfirmed ? said(e) : null,
              busy: _busy,
              onConfirm: () => unawaited(_change(_command('confirm', e))),
              onRemove: () => unawaited(_change(_command('remove', e))),
            ),
          if (_error case final error?)
            Padding(
              key: const ValueKey('machine-access-error'),
              padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
              child: Text(
                error,
                style: DesktopChrome.metadata(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ),
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
              child: TextButton.icon(
                key: const ValueKey('machine-access-add-open'),
                style: superTabQuietAction,
                onPressed: _busy ? null : () => unawaited(_add(hasTeam)),
                icon: const Icon(AppIcons.plus, size: 14),
                label: const Text('Add access…'),
              ),
            ),
          ),
        ],
      );
    },
  );
}

/// One entry in Configure: its name and state, its note under it, and what its owner can do with it.
class _EntryRow extends StatelessWidget {
  const _EntryRow({
    required this.entry,
    required this.state,
    required this.busy,
    required this.onConfirm,
    required this.onRemove,
    this.onShare,
  });

  final SuperTabAccessEntry entry;

  /// An unconfirmed entry's words: who said it.
  final String? state;
  final bool busy;
  final VoidCallback onConfirm, onRemove;

  /// Teammates may use: own-account entries only, since a Team account runs teammates' work anyway.
  final ValueChanged<bool>? onShare;

  @override
  Widget build(BuildContext context) {
    final id = entry.id;
    final quiet = DesktopChrome.metadata();
    final controls = <Widget>[
      if (entry.unconfirmed) ...[
        TextButton(
          key: ValueKey('machine-access-confirm-$id'),
          onPressed: busy ? null : onConfirm,
          child: const Text('Confirm'),
        ),
        TextButton(
          key: ValueKey('machine-access-not-right-$id'),
          style: superTabQuietAction,
          onPressed: busy ? null : onRemove,
          child: const Text('Not right'),
        ),
      ] else ...[
        if (onShare case final share?)
          InkWell(
            borderRadius: BorderRadius.circular(grid.AppControl.radius),
            onTap: busy ? null : () => share(!entry.teammates),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Checkbox(
                  key: ValueKey('machine-access-teammates-$id'),
                  value: entry.teammates,
                  semanticLabel: 'Teammates may use ${entry.name}',
                  onChanged: busy ? null : (on) => share(on ?? false),
                ),
                Text('Teammates may use', style: DesktopChrome.control()),
                const SizedBox(width: grid.AppDesktop.controlGap / 2),
              ],
            ),
          ),
        AppIconButton(
          key: ValueKey('machine-access-remove-$id'),
          icon: AppIcons.trash2,
          tooltip: 'Remove ${entry.name}',
          color: DesktopChrome.muted,
          destructive: true,
          onPressed: busy ? null : onRemove,
        ),
      ],
    ];
    return Padding(
      key: ValueKey('machine-access-entry-$id'),
      padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap / 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Wrap(
                  spacing: grid.AppDesktop.controlGap,
                  crossAxisAlignment: WrapCrossAlignment.end,
                  children: [
                    Text(entry.name, style: DesktopChrome.control()),
                    if (entry.production) Text('(production)', style: quiet),
                    Text(
                      state ?? (entry.ok ? 'ok' : 'not working'),
                      style: quiet,
                    ),
                  ],
                ),
                if (entry.note case final note?)
                  Padding(
                    padding: const EdgeInsets.only(top: grid.AppDesktop.listRowGap),
                    child: Text('Note: $note', style: quiet),
                  ),
              ],
            ),
          ),
          ...controls,
        ],
      ),
    );
  }
}

/// The one warning before an own-account entry is shared, as own-account work's (#2806), naming the entry: teammates'
/// tasks that need it run as its owner. It sends the change itself and says a refusal's reason while open.
class _ShareWarning extends StatefulWidget {
  const _ShareWarning({
    required this.controller,
    required this.entry,
    required this.machineName,
    required this.command,
  });

  final SuperTabController controller;
  final SuperTabAccessEntry entry;
  final String machineName;
  final Map<String, dynamic> command;

  @override
  State<_ShareWarning> createState() => _ShareWarningState();
}

class _ShareWarningState extends State<_ShareWarning> {
  bool _busy = false;
  String? _error;

  Future<void> _allow() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await _send(widget.controller, widget.command);
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context);
    } else {
      setState(() {
        _busy = false;
        _error = error;
      });
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: AlertDialog(
      key: const ValueKey('machine-access-teammates-confirm'),
      title: const Text("Let teammates' work run in your account?"),
      content: SizedBox(
        width: 400,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              "Teammates' tasks in this Swarm that need ${widget.entry.name} will run as you on ${widget.machineName}. "
              'They can read your files, your keychain and your signed-in apps. Your other entries stay yours.',
            ),
            if (_error case final error?) ...[
              const SizedBox(height: 12),
              Text(
                error,
                key: const ValueKey('machine-access-teammates-reason'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          autofocus: true,
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('machine-access-teammates-allow'),
          onPressed: _busy ? null : () => unawaited(_allow()),
          child: const Text('Let them use it'),
        ),
      ],
    ),
  );
}

/// Add access (design section 6): a name, which account it is in (the Team account only on a Mac that has one), whether
/// it is a production system, and an optional note on how to use it. Never the secret itself: the server refuses one.
class _AddAccess extends StatefulWidget {
  const _AddAccess({
    required this.controller,
    required this.machineId,
    required this.hasTeam,
  });

  final SuperTabController controller;
  final String machineId;
  final bool hasTeam;

  @override
  State<_AddAccess> createState() => _AddAccessState();
}

class _AddAccessState extends State<_AddAccess> {
  final _name = TextEditingController();
  final _note = TextEditingController();
  bool _team = false, _production = false, _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _note.dispose();
    super.dispose();
  }

  bool get _ready => !_busy && _name.text.trim().isNotEmpty;

  Future<void> _add() async {
    if (!_ready) return;
    final note = _note.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await _send(widget.controller, {
      'type': 'machine.access',
      'machineId': widget.machineId,
      'action': 'add',
      'name': _name.text.trim(),
      'account': _team && widget.hasTeam ? 'team' : 'own',
      if (_production) 'production': true,
      if (note.isNotEmpty) 'note': note,
    });
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context);
    } else {
      setState(() {
        _busy = false;
        _error = error;
      });
    }
  }

  Widget _where(bool team, String label) => InkWell(
    borderRadius: BorderRadius.circular(grid.AppControl.radius),
    onTap: _busy ? null : () => setState(() => _team = team),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Radio<bool>(
          key: ValueKey('machine-access-where-${team ? 'team' : 'own'}'),
          value: team,
          enabled: !_busy,
        ),
        Padding(
          padding: const EdgeInsets.only(right: grid.AppDesktop.controlGap),
          child: Text(label, style: DesktopChrome.control()),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return PopScope(
      canPop: !_busy,
      child: SuperTabDetailDialog(
        title: 'Add access',
        onClose: _busy ? () {} : null,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            SuperTabDetailRow(
              label: 'Name',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    key: const ValueKey('machine-access-name'),
                    controller: _name,
                    autofocus: true,
                    enabled: !_busy,
                    maxLength: 60,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(counterText: ''),
                    onChanged: (_) => setState(() => _error = null),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Like: Email (dee@), Prod DB read-only',
                    style: DesktopChrome.metadata(),
                  ),
                ],
              ),
            ),
            SuperTabDetailRow(
              label: 'Where',
              child: RadioGroup<bool>(
                groupValue: _team && widget.hasTeam,
                onChanged: (team) {
                  if (!_busy && team != null) setState(() => _team = team);
                },
                child: Wrap(
                  spacing: grid.AppDesktop.controlGap,
                  children: [
                    _where(false, 'Your account'),
                    if (widget.hasTeam) _where(true, 'Team account'),
                  ],
                ),
              ),
            ),
            SuperTabDetailRow(
              label: '',
              child: InkWell(
                borderRadius: BorderRadius.circular(grid.AppControl.radius),
                onTap: _busy
                    ? null
                    : () => setState(() => _production = !_production),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Checkbox(
                      key: const ValueKey('machine-access-production'),
                      value: _production,
                      onChanged: _busy
                          ? null
                          : (on) => setState(() => _production = on ?? false),
                    ),
                    Text('Production system', style: DesktopChrome.control()),
                  ],
                ),
              ),
            ),
            SuperTabDetailRow(
              label: 'Note',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    key: const ValueKey('machine-access-note'),
                    controller: _note,
                    enabled: !_busy,
                    maxLength: 200,
                    decoration: const InputDecoration(counterText: ''),
                    onChanged: (_) => setState(() => _error = null),
                    onSubmitted: (_) => unawaited(_add()),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Optional: where its connection info lives, never the password itself.',
                    style: DesktopChrome.metadata(),
                  ),
                ],
              ),
            ),
            if (_error case final error?) ...[
              const SizedBox(height: grid.AppDesktop.controlGap),
              Text(
                error,
                key: const ValueKey('machine-access-add-error'),
                style: DesktopChrome.metadata(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: _busy ? null : () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const ValueKey('machine-access-add'),
            onPressed: _ready ? () => unawaited(_add()) : null,
            child: Text(_busy ? 'Adding…' : 'Add'),
          ),
        ],
      ),
    );
  }
}
