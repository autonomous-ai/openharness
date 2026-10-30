import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'buddy_machines.dart';
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

/// A person by the name the Swarm shows: their username.
String buddyPersonName(SuperTabController c, String personId) {
  return c.snapshot?.people
          .where((p) => p.id == personId)
          .firstOrNull
          ?.username ??
      'its owner';
}

/// The machine [machineId]'s name as the dialog and the chat show it.
String buddyMachineName(
  SuperTabController c,
  String machineId, {
  AppNotifier? app,
}) {
  // The name its person gave it, else the Swarm's (docs/naming-system.md). A
  // machine of the reader's own outside the Swarm is in no Swarm list
  // (backend buddyOnly), so their account names it.
  final given = app?.stateOf(machineId)?.machine.displayName;
  final name = given != null && given.isNotEmpty
      ? given
      : c.snapshot?.pool(machineId)?['name'];
  return name is String && name.isNotEmpty
      ? superTabMachineName(name)
      : 'another machine';
}

/// Add a Buddy: project, one of the reader's own machines, and engine. With
/// [app], every machine of their account is offered, this computer first; one
/// outside the Swarm stays out of it (buddyMachines).
Future<void> showAddBuddy(
  BuildContext context,
  SuperTabController c, {
  String? projectId,
  AppNotifier? app,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    child: _AddBuddyDialog(controller: c, projectId: projectId, app: app),
  ),
);

class _AddBuddyDialog extends StatefulWidget {
  const _AddBuddyDialog({required this.controller, this.projectId, this.app});
  final SuperTabController controller;
  final String? projectId;
  final AppNotifier? app;

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
  late final _adder = BuddyMachineAdder(widget.controller, widget.app);

  @override
  void initState() {
    super.initState();
    final projects = buddyProjects(c);
    _project =
        projects.where((p) => p.id == widget.projectId).firstOrNull?.id ??
        projects.where((p) => p.id == c.currentProjectId).firstOrNull?.id ??
        projects.firstOrNull?.id;
    _machine = _machines.firstOrNull?.id;
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

  List<BuddyMachine> get _machines => buddyMachines(c, app: widget.app);

  /// The chosen machine while it is still one the reader may use, else the
  /// first that is; null when none is left.
  BuddyMachine? get _picked => pickedBuddyMachine(_machines, _machine);

  Future<void> _submit() async {
    final project = _project, machine = _picked;
    if (_busy || project == null || machine == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final (:id, :setup, error: addError) = await _adder.resolve(
      machine,
      alive: () => mounted,
    );
    if (!mounted) return;
    if (id == null) {
      setState(() {
        _busy = false;
        _error = addError;
      });
      return;
    }
    final added = await c.addBuddy(
      projectId: project,
      machineId: id,
      engine: _engine,
      setup: setup,
    );
    // Its host reads the Swarm now rather than on its next pass.
    if (added && setup != null) unawaited(widget.app?.wakeSuperTabHost(id));
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
    final machines = _machines;
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
                // With no machine the label sits on the line it names.
                crossAxisAlignment: machines.isEmpty
                    ? CrossAxisAlignment.start
                    : CrossAxisAlignment.center,
                children: [
                  label('Machine'),
                  Expanded(
                    child: machines.isEmpty
                        ? BuddyNoMachine(machines: machines)
                        : BuddyMachineField(
                            key: const ValueKey('super-buddy-machine'),
                            machines: machines,
                            value: _picked?.id,
                            busy: _busy,
                            onChanged: (value) {
                              if (!_busy) setState(() => _machine = value);
                            },
                          ),
                  ),
                ],
              ),
              if (machines.isNotEmpty && _picked == null) ...[
                const SizedBox(height: 4),
                Padding(
                  padding: const EdgeInsets.only(left: _labelWidth),
                  child: BuddyNoMachine(machines: machines),
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
                Text(
                  error,
                  key: const ValueKey('super-buddy-error'),
                  style: DesktopChrome.control(),
                ),
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
          onPressed: _busy || _project == null || _picked == null
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

/// What the reader's Buddy is called until they name it, as the backend
/// names it: "ken's Buddy".
String buddyDefaultName(SuperTabController c) {
  final email = c.snapshot?.people
      .where((p) => p.id == c.accountId)
      .firstOrNull
      ?.email;
  return "${(email ?? '').split('@').first}'s Buddy";
}

/// Rename the reader's Buddy in [projectId] (mockup confirmed by Diego,
/// 10-29): the name everyone in the Swarm sees; empty goes back to
/// [buddyDefaultName]. The backend checks the name and says why it refuses.
Future<void> showRenameBuddy(
  BuildContext context,
  SuperTabController c,
  String projectId,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: projectId,
    child: _RenameBuddyDialog(controller: c, projectId: projectId),
  ),
);

class _RenameBuddyDialog extends StatefulWidget {
  const _RenameBuddyDialog({required this.controller, required this.projectId});
  final SuperTabController controller;
  final String projectId;

  @override
  State<_RenameBuddyDialog> createState() => _RenameBuddyDialogState();
}

class _RenameBuddyDialogState extends State<_RenameBuddyDialog> {
  SuperTabController get c => widget.controller;

  /// The backend's limit: a longer name is refused there anyway.
  static const _maxLength = 32;
  late final _name = TextEditingController(
    text: c.buddyChat(widget.projectId)?.buddyName ?? '',
  );
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final renamed = await c.renameBuddy(widget.projectId, _name.text);
    if (!mounted) return;
    if (renamed) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = false;
      _error = c.operationError ?? 'Could not rename the Buddy. Try again.';
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final fallback = buddyDefaultName(c);
    return AlertDialog(
      title: const Text('Rename your Buddy'),
      content: SizedBox(
        width: 440,
        // Scrolls in a short window or at large text, as Add a Buddy does.
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Everyone in this Swarm sees this name.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('super-buddy-name'),
                controller: _name,
                autofocus: true,
                enabled: !_busy,
                maxLength: _maxLength,
                decoration: InputDecoration(
                  hintText: fallback,
                  counterText: '',
                ),
                onSubmitted: (_) => _submit(),
              ),
              const SizedBox(height: 4),
              Text(
                'Leave it empty to go back to "$fallback".',
                style: DesktopChrome.control(color: DesktopChrome.muted),
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
          onPressed: _busy ? null : _submit,
          child: Text(_busy ? 'Saving…' : 'Save'),
        ),
      ],
    );
  }
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
    this.app,
  });
  final SuperTabController controller;
  final SuperTabConversation chat;

  /// For the Start bar's Add this Mac, as Add a Buddy has it (#2105).
  final AppNotifier? app;

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
        // One bar per chat: another project's Buddy chat gets a bar of its
        // own, and leaving this one stops its start (Diego, 10-30: a Buddy
        // was created in whichever chat was open when setup ended).
        key: ValueKey(('super-buddy-start', chat.id)),
        controller: c,
        projectId: chat.projectId,
        padding: _padding,
        app: app,
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
                        '${buddyMachineName(c, machineId, app: app)}…',
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
    final machine = buddyMachineName(c, agent.machineId, app: app);
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
    super.key,
    required this.controller,
    required this.projectId,
    required this.padding,
    required this.app,
  });
  final SuperTabController controller;
  final String projectId;
  final EdgeInsets padding;
  final AppNotifier? app;

  @override
  State<_BuddyStart> createState() => _BuddyStartState();
}

class _BuddyStartState extends State<_BuddyStart> {
  SuperTabController get c => widget.controller;
  late final _adder = BuddyMachineAdder(widget.controller, widget.app);
  String? _machine, _error;
  String _engine = 'claude';
  bool _adding = false;

  /// Starts the Buddy on [machine], first preparing it when it is one of the
  /// reader's machines outside the Swarm. A failed setup says why and starts
  /// nothing. The Buddy is for the project whose chat was clicked: once the
  /// bar shows another chat, the start stops and sends nothing.
  Future<void> _start(BuddyMachine machine) async {
    if (_adding) return;
    final projectId = widget.projectId;
    bool here() => mounted && widget.projectId == projectId;
    setState(() {
      _adding = true;
      _error = null;
    });
    final (:id, :setup, :error) = await _adder.resolve(machine, alive: here);
    if (!mounted) return;
    final stillHere = here();
    setState(() {
      _adding = false;
      // Another chat's bar never shows this start's error.
      _error = stillHere ? error : null;
    });
    if (id == null || !stillHere) return;
    final app = widget.app;
    unawaited(
      c
          .addBuddy(
            projectId: projectId,
            machineId: id,
            engine: _engine,
            setup: setup,
          )
          .then((added) {
            // Its host reads the Swarm now rather than on its next pass.
            if (added && setup != null) unawaited(app?.wakeSuperTabHost(id));
          }),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!c.canWrite) return const SizedBox.shrink();
    final machines = buddyMachines(c, app: widget.app);
    final machine = pickedBuddyMachine(machines, _machine);
    final busy = c.saving || c.hasPendingAction || _adding;
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
          if (machines.isEmpty)
            BuddyNoMachine(machines: machines)
          else
            Row(
              children: [
                BuddyMachineField(
                  key: const ValueKey('super-buddy-start-machine'),
                  machines: machines,
                  value: machine?.id,
                  busy: busy,
                  fitNames: true,
                  onChanged: (value) {
                    if (!busy) setState(() => _machine = value);
                  },
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
                  onPressed: busy || machine == null
                      ? null
                      : () => unawaited(_start(machine)),
                  child: const Text('Start'),
                ),
              ],
            ),
          if (machines.isNotEmpty && machine == null) ...[
            const SizedBox(height: 4),
            BuddyNoMachine(machines: machines),
          ],
          if (_error case final error?) ...[
            const SizedBox(height: 4),
            Text(
              error,
              key: const ValueKey('super-buddy-start-error'),
              style: DesktopChrome.control(),
            ),
          ],
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
