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
typedef BuddyMachine = ({String id, String name, String ownerId});

/// The Swarm's machines, the reader's own first. A Harness Team account is
/// listed as its Mac, which it runs agents for. Who may use which is the
/// server's to decide: a refusal says so in the dialog.
List<BuddyMachine> buddyMachines(SuperTabController c) {
  final rows = [
    for (final m in c.snapshot?.machines ?? const <Map<String, dynamic>>[])
      if (m['hostMachineId'] == null && m['machineId'] is String)
        (
          id: m['machineId'] as String,
          name: superTabMachineName(m['name'] as String? ?? ''),
          ownerId: m['contributorId'] as String? ?? '',
        ),
  ];
  return [
    for (final m in rows)
      if (m.ownerId == c.accountId) m,
    for (final m in rows)
      if (m.ownerId != c.accountId) m,
  ];
}

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

/// Add a Buddy: project, machine and engine. The machine starts on the
/// reader's own, and someone else's machine says at once who can see its
/// terminal.
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

  /// The fields' labels share one column; the machine notice starts after it.
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
  }

  Future<void> _submit() async {
    final project = _project, machine = _machine;
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
    final chosen = machines.where((m) => m.id == _machine).firstOrNull;
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
                'A private agent to think things through with. It reads '
                '#$projectName and your chat with it. It posts to the PM '
                'only when you ask.',
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
                    child: AppSelectField<String>(
                      key: const ValueKey('super-buddy-machine'),
                      value: _machine ?? '',
                      semanticLabel: 'Machine',
                      textStyle: DesktopChrome.control(),
                      options: [
                        for (final m in machines)
                          SelectOption(
                            value: m.id,
                            label: m.name,
                            note: m.ownerId == c.accountId
                                ? 'yours'
                                : buddyPersonName(c, m.ownerId),
                          ),
                      ],
                      onChanged: (value) {
                        if (!_busy) setState(() => _machine = value);
                      },
                    ),
                  ),
                ],
              ),
              if (chosen != null && chosen.ownerId != c.accountId) ...[
                const SizedBox(height: 8),
                Row(
                  key: const ValueKey('super-buddy-machine-notice'),
                  children: [
                    const SizedBox(width: _labelWidth),
                    Expanded(
                      child: Text(
                        'Runs on ${chosen.name}, which belongs to '
                        '${buddyPersonName(c, chosen.ownerId)}. '
                        '${buddyPersonName(c, chosen.ownerId)} can see its terminal.',
                        style: DesktopChrome.metadata(),
                      ),
                    ),
                  ],
                ),
              ],
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
                                enabled: !_busy,
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
          onPressed: _busy || _project == null || _machine == null
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

  /// A start under way, or one that failed with Start again; nothing once
  /// there is no start (a removed Buddy: Add a Buddy brings it back).
  Widget _starting(SuperTabController c) {
    final start = c.buddyStart(chat.projectId);
    if (start == null) return const SizedBox.shrink();
    final request = superTabMap(start['request']);
    final engine = request['engine'] as String? ?? '';
    final machineId = request['machineId'] as String? ?? '';
    final error = start['error'];
    if (error is! String && start['harnessId'] != null) {
      return const SizedBox.shrink();
    }
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
                        engine: engine,
                      ),
                    ),
              child: const Text('Start again'),
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
    final where =
        '${buddyEngineName(agent.engine)} on $machine · '
        '${agent.machineOwnerId == c.accountId ? 'only you can read this chat' : '${buddyPersonName(c, agent.machineOwnerId)} can see its terminal'}';
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
                            engine: agent.engine,
                          ),
                        ),
                  child: const Text('Start again'),
                ),
              ],
            ),
        ],
      ),
    );
  }
}
