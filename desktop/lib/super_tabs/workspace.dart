import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';
import 'view.dart';

/// Keeps the app's one native canvas alive while placing it beside a shared
/// conversation. Switching tabs never constructs a second terminal renderer.
class SuperTabWorkspace extends StatefulWidget {
  const SuperTabWorkspace({
    super.key,
    required this.app,
    required this.canvas,
    required this.onAddAgent,
  });
  final AppNotifier app;
  final Widget canvas;
  final ValueChanged<SuperTabConversation> onAddAgent;

  @override
  State<SuperTabWorkspace> createState() => _SuperTabWorkspaceState();
}

class _SuperTabWorkspaceState extends State<SuperTabWorkspace> {
  final _canvasKey = GlobalKey();
  AppNotifier get app => widget.app;

  Future<void> _open(SuperTabAgent agent, String swarmId) async {
    try {
      final tab = app.swarms.where((s) => s.id == swarmId).firstOrNull;
      if (tab == null) return;
      var machine = app.stateOf(agent.machineId);
      if (machine?.agents.any((a) => a.id == agent.harnessId) != true) {
        await app.refreshMachines();
        if (!mounted || !app.swarms.any((s) => s.id == swarmId)) return;
        machine = app.stateOf(agent.machineId);
      }
      if (machine?.agents.any((a) => a.id == agent.harnessId) != true) {
        throw const SuperTabFailure(
          'TERMINAL_UNAVAILABLE',
          'The shared terminal is not available yet. Its execution machine must be online.',
        );
      }
      await app.assignAgentToPane(
        tab.panes.firstOrNull?.id,
        agent.machineId,
        agent.harnessId,
        swarmId: swarmId,
      );
      if (tab.panes.firstOrNull case final pane?) {
        pane.composerVisible = false;
      }
    } catch (failure) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(failure.toString())));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final canvas = KeyedSubtree(key: _canvasKey, child: widget.canvas);
    final tab = app.activeSwarm;
    final id = tab.superTabId;
    if (!tab.isSuperTab || id == null) return canvas;
    return FutureBuilder<SuperTabController>(
      future: app.superTabs.open(id),
      builder: (context, state) {
        final controller = state.data;
        if (controller == null) {
          return Stack(
            children: [
              Offstage(child: canvas),
              Center(
                child: state.hasError
                    ? Text(state.error.toString())
                    : const CircularProgressIndicator(),
              ),
            ],
          );
        }
        return ListenableBuilder(
          listenable: controller,
          builder: (context, _) {
            final showTerminal =
                tab.panes.isNotEmpty && !controller.accessRevoked;
            return Stack(
              fit: StackFit.expand,
              children: [
                if (!showTerminal) Offstage(child: canvas),
                SuperTabView(
                  key: ValueKey('${controller.accountId}:$id'),
                  controller: controller,
                  onInvite: () =>
                      unawaited(showSuperTabPeople(context, controller)),
                  onAddAgent: widget.onAddAgent,
                  onOpenTerminal: (agent) => unawaited(_open(agent, tab.id)),
                  machineName: (machine) =>
                      app.stateOf(machine)?.machine.displayName ??
                      'Offline machine',
                  terminal: showTerminal ? canvas : null,
                  onCloseTerminal: () {
                    for (final pane in tab.panes.toList()) {
                      unawaited(app.closePane(pane.id, swarmId: tab.id));
                    }
                  },
                ),
              ],
            );
          },
        );
      },
    );
  }
}

Future<void> showSuperTabPeople(
  BuildContext context,
  SuperTabController controller,
) => showDialog<void>(
  context: context,
  builder: (_) => _People(controller: controller),
);

class _People extends StatefulWidget {
  const _People({required this.controller});
  final SuperTabController controller;
  @override
  State<_People> createState() => _PeopleState();
}

class _PeopleState extends State<_People> {
  final _email = TextEditingController();
  final _search = TextEditingController();
  String _role = 'collaborator';
  SuperTabController get c => widget.controller;
  @override
  void dispose() {
    _email.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _invite() async {
    final result = await c.command({
      'type': 'invite.create',
      'email': _email.text.trim(),
      'role': _role,
      'conversationId': c.selectedId,
    });
    if (result != null && mounted) _email.clear();
  }

  Future<void> _remove(SuperTabPerson person) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          person.id == c.accountId
              ? 'Leave Super Tab?'
              : 'Remove ${person.email}?',
        ),
        content: const Text(
          'Their access and agent contributions will be withdrawn. Running harnesses stay on their machines.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(person.id == c.accountId ? 'Leave' : 'Remove'),
          ),
        ],
      ),
    );
    if (yes != true) return;
    final result = await c.command({
      'type': 'member.remove',
      'userId': person.id,
    });
    if (result != null && person.id == c.accountId && mounted) {
      Navigator.pop(context);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final query = _search.text.trim().toLowerCase();
      final people =
          c.snapshot?.people
              .where((p) => p.email.toLowerCase().contains(query))
              .toList() ??
          [];
      return Dialog(
        child: DesktopDialogSurface(
          child: SizedBox(
            width: 460,
            height: 520,
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'People',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Close',
                        onPressed: () => Navigator.pop(context),
                        icon: const Icon(AppIcons.close, size: 18),
                      ),
                    ],
                  ),
                  if (c.isOwner) ...[
                    const SizedBox(height: 12),
                    TextField(
                      controller: _email,
                      autofocus: true,
                      decoration: const InputDecoration(
                        hintText: 'Email address',
                      ),
                      onSubmitted: (_) => _invite(),
                    ),
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButton<String>(
                            value: _role,
                            isExpanded: true,
                            items: const [
                              DropdownMenuItem(
                                value: 'collaborator',
                                child: Text('Can collaborate'),
                              ),
                              DropdownMenuItem(
                                value: 'viewer',
                                child: Text('Can view'),
                              ),
                            ],
                            onChanged: c.saving
                                ? null
                                : (role) => setState(() => _role = role!),
                          ),
                        ),
                        const SizedBox(width: 12),
                        FilledButton(
                          onPressed: c.saving ? null : _invite,
                          child: const Text('Invite'),
                        ),
                      ],
                    ),
                    const Text(
                      'They’ll find the invitation in Harness Settings → Tab invites.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ],
                  if (c.operationError != null)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text(c.operationError!),
                    ),
                  if (c.hasPendingAction)
                    TextButton(
                      onPressed: c.saving ? null : c.retry,
                      child: const Text('Check pending action'),
                    ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _search,
                    decoration: const InputDecoration(
                      hintText: 'Find a person',
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 8),
                  Expanded(
                    child: ListView(
                      children: [
                        for (final person in people)
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(person.email),
                            subtitle: Text(person.role),
                            trailing:
                                person.role != 'owner' &&
                                    (c.isOwner || person.id == c.accountId)
                                ? TextButton(
                                    onPressed: c.saving
                                        ? null
                                        : () => _remove(person),
                                    child: Text(
                                      person.id == c.accountId
                                          ? 'Leave'
                                          : 'Remove',
                                    ),
                                  )
                                : null,
                          ),
                        for (final invitation
                            in c.snapshot?.invitations ??
                                <Map<String, dynamic>>[])
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(invitation['email'] as String),
                            subtitle: const Text('Invited'),
                            trailing: TextButton(
                              onPressed: c.saving
                                  ? null
                                  : () => c.command({
                                      'type': 'invite.revoke',
                                      'inviteId': invitation['id'],
                                    }),
                              child: const Text('Revoke'),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}
