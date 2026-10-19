import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'pane.dart';
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
  (String, String, String?, String, bool)? _terminalRequest;
  (String, String, String?, String, bool)? _readyRequest;
  // Only Open terminal (Participants or a message) may relaunch a stopped
  // member. A restored or revisited selection must not undo `harness close`
  // or a person's stop.
  (String, String)? _resumeRequest;
  Future<void> _terminalChange = Future.value();
  TerminalPane? _nativePane;
  Timer? _nativeHeartbeat;

  void _clearNativeContext() {
    _nativeHeartbeat?.cancel();
    _nativeHeartbeat = null;
    final pane = _nativePane;
    _nativePane = null;
    _readyRequest = null;
    if (pane == null || (pane.inputContext == null && !pane.watchOnly)) return;
    pane.inputContext = null;
    pane.watchOnly = false;
    final session = pane.session;
    session?.stageInputContext(null);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (pane.inputContext == null && !pane.watchOnly) {
        unawaited(session?.setInputContext(null));
      }
    });
  }

  @override
  void dispose() {
    _clearNativeContext();
    super.dispose();
  }

  void _syncTerminal(SuperTabController controller, String swarmId) {
    final agent = controller.terminalAgent(controller.selectedId);
    final request = (
      swarmId,
      controller.selectedId,
      agent?.id,
      controller.accountId,
      controller.canWrite,
    );
    if (_terminalRequest == request) return;
    _clearNativeContext();
    _terminalRequest = request;
    final resume =
        agent != null && _resumeRequest == (controller.selectedId, agent.id);
    _resumeRequest = null;
    bool current() =>
        mounted &&
        _terminalRequest == request &&
        app.activeSwarmId == swarmId &&
        app.currentUser?.id == controller.accountId &&
        controller.canWrite == request.$5;
    // Native attachment may wait for machine discovery. Serialize replacements
    // and discard any request superseded by another group or account.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _terminalChange = _terminalChange.catchError((Object _) {}).then((
        _,
      ) async {
        if (!current()) return;
        if (agent != null) {
          await _open(agent, controller, swarmId, request.$2, current, resume);
          if (current()) setState(() => _readyRequest = request);
        } else {
          final tab = app.swarms.where((s) => s.id == swarmId).firstOrNull;
          for (final pane in tab?.panes.toList() ?? const []) {
            if (!current()) return;
            await app.closePane(pane.id, swarmId: swarmId);
          }
        }
      });
    });
  }

  Future<void> _open(
    SuperTabAgent agent,
    SuperTabController controller,
    String swarmId,
    String conversationId,
    bool Function() current,
    bool resume,
  ) async {
    try {
      final tab = app.swarms.where((s) => s.id == swarmId).firstOrNull;
      if (tab == null) return;
      var machine = app.stateOf(agent.machineId);
      if (machine?.agents.any((a) => a.id == agent.harnessId) != true) {
        await app.refreshMachines();
        if (!current() || !app.swarms.any((s) => s.id == swarmId)) return;
        machine = app.stateOf(agent.machineId);
      }
      if (machine?.agents.any((a) => a.id == agent.harnessId) != true) {
        throw const SuperTabFailure(
          'TERMINAL_UNAVAILABLE',
          'The shared terminal is not available yet. Its execution machine must be online.',
        );
      }
      if (!current()) return;
      String? inputContext;
      // A narrowly shared harness remains its existing read-only observer.
      // Controlling a machine and joining a Super Tab are separate grants.
      if (controller.canWrite && machine?.machine.isShared != true) {
        final stopped = machine?.agents
            .where((a) => a.id == agent.harnessId)
            .firstOrNull
            ?.isStopped;
        if (stopped == true) {
          if (!resume) {
            controller.selectTerminal(conversationId, null);
            return;
          }
          // Older idle cleanup may already have stopped a contributed harness.
          // Open its saved conversation through the existing resume receipt
          // before issuing a native context, so a failed resume leaves none.
          final resumeError = await app.resumeStoppedSession(
            agent.machineId,
            agent.harnessId,
          );
          if (!current()) return;
          if (resumeError != null) {
            throw SuperTabFailure('TERMINAL_UNAVAILABLE', resumeError);
          }
        }
        final issued = await controller.request(
          'POST',
          '/api/super-tabs/${controller.tabId}/native',
          body: {
            'operationId': superTabOperationId(),
            'conversationId': conversationId,
            'agentId': agent.id,
          },
        );
        if (!current()) return;
        inputContext = issued['contextId'] as String?;
        if (inputContext == null ||
            !RegExp(r'^[A-Za-z0-9_-]{16,160}$').hasMatch(inputContext)) {
          throw const SuperTabFailure(
            'NATIVE_UNAVAILABLE',
            'Could not prepare terminal sharing. Try opening it again.',
          );
        }
        final prepared = await app.superTabMachineRequest(agent.machineId, {
          'action': 'prepareNative',
          'tabId': controller.tabId,
          'contextId': inputContext,
        });
        if (!current()) return;
        if (prepared['inputContext'] != inputContext) {
          throw const SuperTabFailure(
            'NATIVE_UNAVAILABLE',
            'This machine could not confirm terminal sharing.',
          );
        }
      }
      await app.assignAgentToPane(
        tab.panes.firstOrNull?.id,
        agent.machineId,
        agent.harnessId,
        swarmId: swarmId,
        inputContext: inputContext,
        watchOnly: !controller.canWrite,
      );
      if (!current()) return;
      if (tab.panes.firstOrNull case final pane?) {
        pane.composerVisible = false;
        _nativePane = pane;
      }
      if (inputContext != null) {
        var renewing = false;
        _nativeHeartbeat = Timer.periodic(const Duration(seconds: 20), (
          timer,
        ) async {
          if (!current()) {
            timer.cancel();
            return;
          }
          if (renewing) return;
          renewing = true;
          try {
            await app.superTabMachineRequest(agent.machineId, {
              'action': 'renewNative',
              'tabId': controller.tabId,
              'contextId': inputContext,
            });
          } catch (failure) {
            if (mounted && current()) {
              controller.selectTerminal(conversationId, null);
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('Terminal sharing paused. $failure')),
              );
            }
            timer.cancel();
          } finally {
            renewing = false;
          }
        });
      }
    } catch (failure) {
      if (mounted && current()) {
        controller.selectTerminal(conversationId, null);
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
    if (!tab.isSuperTab || id == null) {
      _clearNativeContext();
      _terminalRequest = null;
      return canvas;
    }
    return FutureBuilder<SuperTabController>(
      future: app.superTabs.open(id),
      builder: (context, state) {
        final controller = state.data;
        if (controller == null ||
            controller.tabId != id ||
            controller.accountId != app.currentUser?.id) {
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
            _syncTerminal(controller, tab.id);
            final selectedTerminal = controller.terminalAgent(
              controller.selectedId,
            );
            final showTerminal =
                _readyRequest == _terminalRequest &&
                selectedTerminal != null &&
                tab.panes.any(
                  (pane) =>
                      pane.machineId == selectedTerminal.machineId &&
                      pane.agentId == selectedTerminal.harnessId,
                );
            final terminal = selectedTerminal == null
                ? canvas
                : SuperPane(
                    machineId: selectedTerminal.machineId,
                    harnessId: selectedTerminal.harnessId,
                    title:
                        controller.snapshot?.isLead(selectedTerminal.id) == true
                        ? 'Lead'
                        : null,
                    child: canvas,
                  );
            return Stack(
              fit: StackFit.expand,
              children: [
                if (!showTerminal) Offstage(child: terminal),
                SuperTabView(
                  key: ValueKey('${controller.accountId}:$id'),
                  controller: controller,
                  onInvite: () =>
                      unawaited(showSuperTabPeople(context, controller)),
                  onAddAgent: widget.onAddAgent,
                  onOpenTerminal: (agent) {
                    _terminalRequest = null;
                    _resumeRequest = (controller.selectedId, agent.id);
                    controller.selectTerminal(controller.selectedId, agent.id);
                    setState(() {});
                  },
                  machineName: (machine) =>
                      app.stateOf(machine)?.machine.displayName ??
                      'Offline machine',
                  terminal: showTerminal ? terminal : null,
                  onCloseTerminal: () {
                    controller.selectTerminal(controller.selectedId, null);
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
) => showAppDialog<void>(
  context: context,
  builder: (_) => SuperTabDialogScope(
    controller: controller,
    requireWrite: false,
    child: _People(controller: controller),
  ),
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
  void initState() {
    super.initState();
    _email.addListener(_emailChanged);
  }

  void _emailChanged() => setState(() {});
  @override
  void dispose() {
    _email.removeListener(_emailChanged);
    _email.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _invite() async {
    if (!c.isOwner ||
        c.saving ||
        c.hasPendingAction ||
        _email.text.trim().isEmpty) {
      return;
    }
    final result = await c.command({
      'type': 'invite.create',
      'email': _email.text.trim(),
      'role': _role,
      'conversationId': c.selectedId,
    });
    if (result != null && mounted) _email.clear();
  }

  Future<void> _remove(SuperTabPerson person) async {
    final yes = await showAppDialog<bool>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        requireWrite: false,
        child: AlertDialog(
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
      if (c.accessRevoked) {
        return AlertDialog(
          content: Text(c.error ?? 'This Super Tab is no longer available.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
            ),
          ],
        );
      }
      final query = _search.text.trim().toLowerCase();
      final people =
          c.snapshot?.people
              .where((p) => p.email.toLowerCase().contains(query))
              .toList() ??
          [];
      return Dialog(
        backgroundColor: Colors.transparent,
        elevation: 0,
        shape: const RoundedRectangleBorder(),
        child: DesktopDialogSurface(
          child: SizedBox(
            width: 460,
            height: 520,
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  DesktopDialogHeader(
                    title: 'People',
                    padding: EdgeInsets.zero,
                    onClose: () => Navigator.pop(context),
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
                          child: ExcludeFocus(
                            excluding: c.saving || c.hasPendingAction,
                            child: ExcludeSemantics(
                              excluding: c.saving || c.hasPendingAction,
                              child: IgnorePointer(
                                ignoring: c.saving || c.hasPendingAction,
                                child: AppSelectField<String>(
                                  value: _role,
                                  semanticLabel: 'Invitation access',
                                  textStyle: DesktopChrome.control(),
                                  options: const [
                                    SelectOption(
                                      value: 'collaborator',
                                      label: 'Can collaborate',
                                      detail: 'Read every conversation and send messages to the shared agents.',
                                    ),
                                    SelectOption(
                                      value: 'viewer',
                                      label: 'Can view',
                                      detail: 'Read every conversation without sending messages or changing work.',
                                    ),
                                  ],
                                  onChanged: (role) {
                                    if (!c.saving && !c.hasPendingAction) {
                                      setState(() => _role = role);
                                    }
                                  },
                                ),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        FilledButton(
                          onPressed:
                              c.saving ||
                                  c.hasPendingAction ||
                                  _email.text.trim().isEmpty
                              ? null
                              : _invite,
                          child: const Text('Invite'),
                        ),
                      ],
                    ),
                    Text(
                      'They’ll find the invitation in Harness Settings → Tab invites.',
                      style: DesktopChrome.metadata(),
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
                            subtitle: Text(
                              person.role == 'owner'
                                  ? 'Owner'
                                  : person.role == 'viewer'
                                  ? 'Viewer'
                                  : 'Collaborator',
                              style: DesktopChrome.metadata(),
                            ),
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
