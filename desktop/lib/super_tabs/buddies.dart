import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';

/// The engines a Buddy runs on (spec: Buddies, 10-28).
const kBuddyEngines = {'claude': 'Claude', 'codex': 'Codex'};

/// Engines a Buddy cannot run on yet, and why, in the backend's own words
/// (`CODEX_BUDDY_REFUSAL`, backend superTabs/commands.ts): the dialog offers
/// them turned off, with this beside them (security review 1 of #2087).
const kBuddyEngineRefusals = {
  'codex': 'A Codex Buddy is not available yet: Codex would run some commands outside its sandbox without asking. Choose Claude Code.',
};

/// The engine Start again asks for: the Buddy's own, or Claude Code in place
/// of one the server refuses, which it would refuse again (review 2 of #2087).
String buddyRestartEngine(String engine) =>
    kBuddyEngineRefusals.containsKey(engine) ? 'claude' : engine;

/// Start again's label: "Start with Claude Code" where it changes the engine.
String buddyRestartLabel(String engine) => buddyRestartEngine(engine) == engine
    ? 'Start again'
    : 'Start with Claude Code';

/// An engine as people read it: "Claude", "Codex".
String buddyEngineName(String engine) =>
    kBuddyEngines[engine] ??
    (engine.isEmpty ? 'Agent' : engine[0].toUpperCase() + engine.substring(1));

/// The projects where the signed-in person may add a Buddy: those where they
/// have none running.
List<SuperTabProject> buddyProjects(SuperTabController c) => [
  for (final project in c.snapshot?.projects ?? const <SuperTabProject>[])
    if (c.buddy(project.id) == null) project,
];

/// A machine a Buddy may be added on, as the add dialog lists it.
typedef BuddyMachine = ({String id, String name});

/// The reader's own machines in the Swarm: a Buddy runs only there, like a
/// Lead, whatever its engine (Ken, 10-28). Not a machine the reader may use
/// but someone else owns, and not a Harness Team account. The backend
/// refuses any other.
List<BuddyMachine> buddyMachines(SuperTabController c) => [
  for (final m in c.snapshot?.machines ?? const <Map<String, dynamic>>[])
    if (m['hostMachineId'] == null &&
        m['contributorId'] == c.accountId &&
        m['machineId'] is String)
      (
        id: m['machineId'] as String,
        name: superTabMachineName(m['name'] as String? ?? ''),
      ),
];

/// A person by the name the Swarm shows: their address before the @.
String buddyPersonName(SuperTabController c, String personId) {
  final email = c.snapshot?.people
      .where((p) => p.id == personId)
      .firstOrNull
      ?.email;
  return email == null || email.isEmpty
      ? 'its owner'
      : superTabPersonName(email);
}

/// The machine [machineId]'s name as the dialog and the chat show it.
String buddyMachineName(SuperTabController c, String machineId) {
  final row = c.snapshot?.pool(machineId);
  final name = row?['name'];
  return name is String && name.isNotEmpty
      ? superTabMachineName(name)
      : 'another machine';
}

/// Add a Buddy: project, one of the reader's own machines, and engine.
Future<void> showAddBuddy(
  BuildContext context,
  SuperTabController c, {
  String? projectId,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    child: _AddBuddyDialog(controller: c, projectId: projectId),
  ),
);

class _AddBuddyDialog extends StatefulWidget {
  const _AddBuddyDialog({required this.controller, this.projectId});
  final SuperTabController controller;
  final String? projectId;

  @override
  State<_AddBuddyDialog> createState() => _AddBuddyDialogState();
}

class _AddBuddyDialogState extends State<_AddBuddyDialog> {
  SuperTabController get c => widget.controller;

  /// The fields' labels share one column.
  static const _labelWidth = 72.0;
  String? _project, _machine;
  String _engine = 'claude';
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final projects = buddyProjects(c);
    _project =
        projects.where((p) => p.id == widget.projectId).firstOrNull?.id ??
        projects.where((p) => p.id == c.currentProjectId).firstOrNull?.id ??
        projects.firstOrNull?.id;
    _machine = buddyMachines(c).firstOrNull?.id;
    c.addListener(_swarmChanged);
  }

  @override
  void dispose() {
    c.removeListener(_swarmChanged);
    super.dispose();
  }

  /// The Swarm changed under the open dialog: its machines may have too.
  void _swarmChanged() {
    if (mounted) setState(() {});
  }

  /// The chosen machine while it is still one of the reader's, else the
  /// first that is; null when none is left.
  String? get _listedMachine {
    final machines = buddyMachines(c);
    return machines.any((m) => m.id == _machine)
        ? _machine
        : machines.firstOrNull?.id;
  }

  Future<void> _submit() async {
    final project = _project, machine = _listedMachine;
    if (_busy || project == null || machine == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final added = await c.addBuddy(
      projectId: project,
      machineId: machine,
      engine: _engine,
    );
    if (!mounted) return;
    if (added) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = false;
      _error = c.operationError ?? 'Could not add the Buddy. Try again.';
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final projects = buddyProjects(c);
    final machines = buddyMachines(c);
    final projectName =
        projects.where((p) => p.id == _project).firstOrNull?.name ?? '';
    Widget label(String text) => SizedBox(
      width: _labelWidth,
      child: Text(
        text,
        style: DesktopChrome.control(color: DesktopChrome.muted),
      ),
    );
    return AlertDialog(
      title: const Text('Add a Buddy'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'A private agent to think things through with. It runs on '
                'your own machine, reads #$projectName and your chat with '
                'it, and posts to the PM only when you ask.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  label('Project'),
                  Expanded(
                    child: AppSelectField<String>(
                      key: const ValueKey('super-buddy-project'),
                      value: _project ?? '',
                      semanticLabel: 'Project',
                      textStyle: DesktopChrome.control(),
                      options: [
                        for (final p in projects)
                          SelectOption(value: p.id, label: p.name),
                      ],
                      onChanged: (value) {
                        if (!_busy) setState(() => _project = value);
                      },
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  label('Machine'),
                  Expanded(
                    child: machines.isEmpty
                        ? Text(
                            'A Buddy runs on one of your own machines. Add '
                            'one of yours to this Swarm first.',
                            style: DesktopChrome.metadata(),
                          )
                        : AppSelectField<String>(
                            key: const ValueKey('super-buddy-machine'),
                            value: _listedMachine ?? '',
                            semanticLabel: 'Machine',
                            textStyle: DesktopChrome.control(),
                            options: [
                              for (final m in machines)
                                SelectOption(value: m.id, label: m.name),
                            ],
                            onChanged: (value) {
                              if (!_busy) setState(() => _machine = value);
                            },
                          ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  label('Agent'),
                  Expanded(
                    child: RadioGroup<String>(
                      groupValue: _engine,
                      onChanged: (value) {
                        if (!_busy && value != null) {
                          setState(() => _engine = value);
                        }
                      },
                      child: Row(
                        children: [
                          for (final MapEntry(:key, :value)
                              in kBuddyEngines.entries)
                            Flexible(
                              child: RadioListTile<String>(
                                value: key,
                                enabled:
                                    !_busy &&
                                    !kBuddyEngineRefusals.containsKey(key),
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: Text(value),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              for (final refusal in kBuddyEngineRefusals.values) ...[
                const SizedBox(height: 4),
                Padding(
                  padding: const EdgeInsets.only(left: _labelWidth),
                  child: Text(
                    refusal,
                    style: DesktopChrome.control(color: DesktopChrome.muted),
                  ),
                ),
              ],
              if (_error case final error?) ...[
                const SizedBox(height: 12),
                Text(error, style: DesktopChrome.control()),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy || _project == null || _listedMachine == null
              ? null
              : () => unawaited(_submit()),
          child: Text(_busy ? 'Adding…' : 'Add Buddy'),
        ),
      ],
    );
  }
}

/// Asks before removing the reader's Buddy in [projectId]; its chat stays.
Future<void> confirmRemoveBuddy(
  BuildContext context,
  SuperTabController c,
  String projectId,
) async {
  final remove = await showAppDialog<bool>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: projectId,
      child: AlertDialog(
        title: const Text('Remove Buddy?'),
        content: Text(
          'Its session stops. Your chat stays, and adding a Buddy here again '
          'picks it up.',
          style: DesktopChrome.text(),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    ),
  );
  if (remove == true) await c.removeBuddy(projectId);
}

/// Under a Buddy chat's header: what it runs on and who else can see its
/// terminal, and, while it is down, a way to start it again. Before its
/// agent is there, how its start is going (backend: the start carries the
/// add's progress and failure).
class SuperTabBuddyBar extends StatelessWidget {
  const SuperTabBuddyBar({
    super.key,
    required this.controller,
    required this.chat,
  });
  final SuperTabController controller;
  final SuperTabConversation chat;

  EdgeInsets get _padding => const EdgeInsets.fromLTRB(
    grid.AppDesktop.panelPadding,
    grid.AppDesktop.controlGap,
    grid.AppDesktop.panelPadding,
    grid.AppDesktop.menuInset,
  );

  /// A start under way, or one that failed with Start again; with none, the
  /// Start bar: the chat is there before any Buddy (Lead's ruling, 10-29).
  Widget _starting(SuperTabController c) {
    final start = c.buddyStart(chat.projectId);
    final error = start?['error'];
    if (start == null || (error is! String && start['harnessId'] != null)) {
      return _BuddyStart(
        controller: c,
        projectId: chat.projectId,
        padding: _padding,
      );
    }
    final request = superTabMap(start['request']);
    final engine = request['engine'] as String? ?? '';
    final machineId = request['machineId'] as String? ?? '';
    final busy = !c.canWrite || c.saving || c.hasPendingAction;
    return Padding(
      key: const ValueKey('super-buddy-bar'),
      padding: _padding,
      child: Row(
        children: [
          Expanded(
            child: Text(
              error is String
                  ? "Couldn't start: $error"
                  : 'Starting ${buddyEngineName(engine)} on '
                        '${buddyMachineName(c, machineId)}…',
              style: DesktopChrome.control(),
            ),
          ),
          if (error is String)
            TextButton(
              onPressed: busy || machineId.isEmpty
                  ? null
                  : () => unawaited(
                      c.addBuddy(
                        projectId: chat.projectId,
                        machineId: machineId,
                        engine: buddyRestartEngine(engine),
                      ),
                    ),
              child: Text(buddyRestartLabel(engine)),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final c = controller;
    final agent = c.buddy(chat.projectId);
    if (agent == null) return _starting(c);
    final name = c.snapshot!.agentName(agent.id, fallback: agent.name);
    final machine = buddyMachineName(c, agent.machineId);
    final project = c.snapshot!.projects
        .where((p) => p.id == chat.projectId)
        .firstOrNull;
    final where = [
      '${buddyEngineName(agent.engine)} on $machine',
      if (project != null) '#${project.name}',
      agent.machineOwnerId == c.accountId
          ? 'only you can read this chat'
          : '${buddyPersonName(c, agent.machineOwnerId)} can see its terminal',
    ].join(' · ');
    final busy = !c.canWrite || c.saving || c.hasPendingAction;
    return Padding(
      key: const ValueKey('super-buddy-bar'),
      padding: _padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(where, style: DesktopChrome.metadata()),
          if (agent.downSince != null)
            Row(
              children: [
                Expanded(
                  child: Text(
                    '$name is offline. Your chat stays.',
                    style: DesktopChrome.control(),
                  ),
                ),
                TextButton(
                  onPressed: busy
                      ? null
                      : () => unawaited(
                          c.addBuddy(
                            projectId: chat.projectId,
                            machineId: agent.machineId,
                            engine: buddyRestartEngine(agent.engine),
                          ),
                        ),
                  child: Text(buddyRestartLabel(agent.engine)),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// A Buddy chat with no Buddy: one click starts one, on the reader's own
/// machine and with Claude unless they pick otherwise (mockup A, Lead 10-29).
/// A viewer, who adds nothing, sees no bar.
class _BuddyStart extends StatefulWidget {
  const _BuddyStart({
    required this.controller,
    required this.projectId,
    required this.padding,
  });
  final SuperTabController controller;
  final String projectId;
  final EdgeInsets padding;

  @override
  State<_BuddyStart> createState() => _BuddyStartState();
}

class _BuddyStartState extends State<_BuddyStart> {
  SuperTabController get c => widget.controller;
  String? _machine;
  String _engine = 'claude';

  @override
  Widget build(BuildContext context) {
    if (!c.canWrite) return const SizedBox.shrink();
    final machines = buddyMachines(c);
    final machine = machines.any((m) => m.id == _machine)
        ? _machine
        : machines.firstOrNull?.id;
    final busy = c.saving || c.hasPendingAction;
    return Padding(
      key: const ValueKey('super-buddy-start'),
      padding: widget.padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Start your Buddy to brainstorm here',
            style: DesktopChrome.control(medium: true),
          ),
          const SizedBox(height: 8),
          if (machine == null)
            Text(
              'A Buddy runs on one of your own machines. Add one of yours to '
              'this Swarm first.',
              style: DesktopChrome.metadata(),
            )
          else
            Row(
              children: [
                Expanded(
                  child: AppSelectField<String>(
                    key: const ValueKey('super-buddy-start-machine'),
                    value: machine,
                    semanticLabel: 'Machine',
                    textStyle: DesktopChrome.control(),
                    options: [
                      for (final m in machines)
                        SelectOption(value: m.id, label: m.name),
                    ],
                    onChanged: (value) {
                      if (!busy) setState(() => _machine = value);
                    },
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 120,
                  child: AppSelectField<String>(
                    key: const ValueKey('super-buddy-start-engine'),
                    value: _engine,
                    semanticLabel: 'Agent',
                    textStyle: DesktopChrome.control(),
                    // Only engines the server takes; the refused ones say why
                    // below, as Add a Buddy does (#2087).
                    options: [
                      for (final MapEntry(:key, :value)
                          in kBuddyEngines.entries)
                        if (!kBuddyEngineRefusals.containsKey(key))
                          SelectOption(value: key, label: value),
                    ],
                    onChanged: (value) {
                      if (!busy) setState(() => _engine = value);
                    },
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: busy
                      ? null
                      : () => unawaited(
                          c.addBuddy(
                            projectId: widget.projectId,
                            machineId: machine,
                            engine: _engine,
                          ),
                        ),
                  child: const Text('Start'),
                ),
              ],
            ),
          if (machine != null)
            for (final refusal in kBuddyEngineRefusals.values) ...[
              const SizedBox(height: 4),
              Text(
                refusal,
                style: DesktopChrome.control(color: DesktopChrome.muted),
              ),
            ],
        ],
      ),
    );
  }
}
