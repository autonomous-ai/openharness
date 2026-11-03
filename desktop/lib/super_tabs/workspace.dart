import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../state/workspace_chrome.dart';
import 'agent_group_picker.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'pane.dart';
import 'personal_projects.dart';
import 'sharing.dart';
import 'swarm_switcher.dart' show PersonalSwarm;
import 'terminal_unavailable.dart';
import 'view.dart';

/// Keeps the app's one native canvas alive in the group's middle area.
/// Switching chat/terminals never constructs a second terminal renderer.
class SuperTabWorkspace extends StatefulWidget {
  const SuperTabWorkspace({
    super.key,
    required this.app,
    required this.canvas,
    required this.onAddAgent,
    this.onNewProject,
    this.onNewSwarm,
  });
  final AppNotifier app;
  final Widget canvas;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final VoidCallback? onNewProject;
  final VoidCallback? onNewSwarm;

  @override
  State<SuperTabWorkspace> createState() => _SuperTabWorkspaceState();
}

class _SuperTabWorkspaceState extends State<SuperTabWorkspace> {
  final _canvasKey = GlobalKey();
  AppNotifier get app => widget.app;
  (String, String, String?, String, bool, String)? _terminalRequest;
  (String, String, String?, String, bool, String)? _readyRequest;
  // Navigation never undoes a person's stop. Only the pane's explicit Resume
  // action may restart a saved session, with the Swarm's native context.
  (String, String)? _resumeRequest;
  (String, String)? _focusRequest;
  Future<void> _terminalChange = Future.value();
  final _nativePanes = <TerminalPane>[];
  final _failures = <(String, String?), String>{};
  final _nativeHeartbeats = <Timer>[];

  /// The Swarm tab last told to the client as the one on screen.
  String? _shown;
  late final _lifecycle = AppLifecycleListener(
    onStateChange: (state) => app.superTabs.pageVisible =
        state != AppLifecycleState.hidden &&
        state != AppLifecycleState.paused &&
        state != AppLifecycleState.detached,
  );

  @override
  void initState() {
    super.initState();
    _lifecycle;
  }

  /// Which Swarm tab is on screen, told after the frame: a change can start
  /// a read, and a read notifies listeners this build may be one of.
  void _showTab(String? id) {
    if (_shown == id) return;
    _shown = id;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _shown == id) app.superTabs.show(id);
    });
  }

  void _clearNativeContext() {
    for (final timer in _nativeHeartbeats) {
      timer.cancel();
    }
    _nativeHeartbeats.clear();
    final panes = _nativePanes.toList();
    _nativePanes.clear();
    _readyRequest = null;
    for (final pane in panes) {
      if (pane.inputContext == null && pane.watchOnly) continue;
      pane.inputContext = null;
      pane.watchOnly = true;
      final session = pane.session;
      session?.stageInputContext(null, watchOnly: true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (pane.inputContext == null && pane.watchOnly) {
          unawaited(session?.setInputContext(null, watchOnly: true));
        }
      });
    }
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _clearNativeContext();
    super.dispose();
  }

  /// The person's own panes a Personal project shows behind its [term]: the
  /// panes their tabs hold, never a copy (personal_projects.dart).
  List<TerminalPane> _localPanes(SuperTabController controller) =>
      controller.groupTerminalsOpen(controller.selectedId)
      ? PersonalProjects.of(app).panesFor(controller, controller.selectedId)
      : const [];

  void _syncTerminal(SuperTabController controller, String swarmId) {
    final local = _localPanes(controller);
    final devices =
        controller.devicesSelected &&
        app.devicesEnabled &&
        !controller.accessRevoked;
    final agents = controller.terminalAgents(controller.selectedId);
    final request = (
      swarmId,
      devices ? r'$devices' : controller.selectedId,
      agents.isEmpty
          ? null
          : agents
                .map((a) {
                  final machine = app.stateOf(a.machineId);
                  final native = machine?.agents
                      .where((n) => n.id == a.harnessId)
                      .firstOrNull;
                  return '${a.id}:${a.harnessId}:${native?.isStopped}:${machine?.connectionStatus}:${native != null}';
                })
                .join(','),
      controller.accountId,
      controller.canWrite,
      local.map((p) => '${p.machineId}/${p.agentId}').join(','),
    );
    if (_terminalRequest == request) return;
    _clearNativeContext();
    _failures.clear();
    _terminalRequest = request;
    final resume = _resumeRequest;
    _resumeRequest = null;
    final focus = _focusRequest;
    _focusRequest = null;
    bool current() =>
        mounted &&
        _terminalRequest == request &&
        app.activeSwarmId == swarmId &&
        (controller.devicesSelected &&
                app.devicesEnabled &&
                !controller.accessRevoked) ==
            devices &&
        app.currentUser?.id == controller.accountId &&
        controller.canWrite == request.$5;
    // Native attachment may wait for machine discovery. Serialize replacements
    // and discard any request superseded by another group or account.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _terminalChange = _terminalChange.catchError((Object _) {}).then((
        _,
      ) async {
        if (!current()) return;
        final tab = app.swarms.where((s) => s.id == swarmId).firstOrNull;
        // Closing a terminal also removes its owned viewer. Do that first so
        // navigation never records a web/Finder preview as manually dismissed.
        final oldPanes = tab?.panes.toList() ?? <TerminalPane>[];
        oldPanes.sort(
          (a, b) => (a.isViewer ? 1 : 0).compareTo(b.isViewer ? 1 : 0),
        );
        for (final pane in oldPanes) {
          // Keep only the dashboard when revisiting Devices, also removing
          // the chat slot or session restored from its former split layout.
          if (devices && pane.isDevices) continue;
          final shown =
              agents.any(
                (a) =>
                    a.machineId == pane.machineId &&
                    a.harnessId == pane.agentId,
              ) ||
              local.any(
                (p) =>
                    p.machineId == pane.machineId && p.agentId == pane.agentId,
              );
          if (!shown) {
            if (!current()) return;
            // One of the person's own panes leaves this view only: its tab
            // keeps it, or its tab's close already put it in recently closed.
            if (_isPersonsOwn(pane, swarmId) || _shownFromTab[pane] == true) {
              _shownFromTab[pane] = null;
              await app.releaseSuperTabView(swarmId, pane.id);
            } else {
              await app.closePane(pane.id, swarmId: swarmId);
            }
          }
        }
        if (devices) {
          if (!current()) return;
          app.prepareSuperTabDevices(swarmId);
          setState(() => _readyRequest = request);
          return;
        }
        for (final agent in agents) {
          if (!current()) return;
          await _open(
            agent,
            controller,
            swarmId,
            request.$2,
            current,
            resume == (request.$2, agent.id),
          );
        }
        for (final pane in local) {
          if (!current()) return;
          // The very pane its tab shows, as it is there: same session, same
          // input and composer. No Swarm terminal sharing is asked for.
          _shownFromTab[pane] = true;
          await app.assignAgentToPane(
            null,
            pane.machineId,
            pane.agentId!,
            swarmId: swarmId,
            inputContext: pane.inputContext,
            watchOnly: pane.watchOnly,
            autoTile: true,
            focus: false,
            intent: AttachIntent.automatic,
          );
        }
        if (current() && agents.isEmpty && tab != null) {
          if (PersonalProjects.of(app).soleTab(local) case final source?) {
            app.copySuperTabLayout(swarmId, source);
          }
        }
        if (current()) {
          if (tab != null) tab.zoomedPaneId = null;
          final focused = agents.where((a) => a.id == focus?.$2).firstOrNull;
          if (focused != null || agents.length + local.length == 1) {
            if ((focused == null
                    ? tab?.panes.firstOrNull
                    : tab?.panes
                          .where(
                            (p) =>
                                p.machineId == focused.machineId &&
                                p.agentId == focused.harnessId,
                          )
                          .firstOrNull)
                case final pane?) {
              app.focusPane(pane.id);
              pane.session?.focusInput();
            }
          }
          setState(() => _readyRequest = request);
        }
      });
    });
  }

  /// The person's own panes this view showed from their tabs. One of them
  /// stays theirs after its tab closes: that close already went into recently
  /// closed, so the view lets the pane go without a second entry. Weak, so a
  /// pane gone everywhere is forgotten with it.
  static final _shownFromTab = Expando<bool>('shownFromTab');

  /// Whether [pane] in Swarm tab [swarmId] is one of the person's own panes,
  /// held by one of their other tabs too.
  bool _isPersonsOwn(TerminalPane pane, String swarmId) => app.swarms.any(
    (tab) =>
        tab.id != swarmId &&
        !tab.isSuperTab &&
        tab.panes.any((p) => identical(p, pane)),
  );

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
      final snapshot = controller.snapshot;
      // Another person's private session never arrives as an invitation: re-reading the machine list for one is wasted.
      final private =
          snapshot != null &&
          agent.machineOwnerId != controller.accountId &&
          superTabTerminalPrivate(snapshot, agent);
      if (!private &&
          machine?.agents.any((a) => a.id == agent.harnessId) != true) {
        await app.refreshMachines();
        if (!current() || !app.swarms.any((s) => s.id == swarmId)) return;
        machine = app.stateOf(agent.machineId);
      }
      if (private ||
          machine?.agents.any((a) => a.id == agent.harnessId) != true) {
        throw SuperTabFailure(
          'TERMINAL_UNAVAILABLE',
          superTabTerminalUnavailable(
            snapshot: controller.snapshot,
            agent: agent,
            accountId: controller.accountId,
            machine: machine,
          ),
        );
      }
      if (!current()) return;
      String? inputContext;
      // A narrowly shared harness remains its existing read-only observer.
      // Controlling a machine and joining a Swarm are separate grants.
      if (controller.canWrite && machine?.machine.isShared != true) {
        final stopped = machine?.agents
            .where((a) => a.id == agent.harnessId)
            .firstOrNull
            ?.isStopped;
        if (stopped == true && resume) {
          final resumeError = await app.resumeStoppedSession(
            agent.machineId,
            agent.harnessId,
          );
          if (!current()) return;
          if (resumeError != null) {
            throw SuperTabFailure('TERMINAL_UNAVAILABLE', resumeError);
          }
        }
        if (stopped != true || resume) {
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
      }
      await app.assignAgentToPane(
        null,
        agent.machineId,
        agent.harnessId,
        swarmId: swarmId,
        inputContext: inputContext,
        watchOnly: !controller.canWrite,
        autoTile: true,
        focus: false,
      );
      if (!current()) return;
      if (tab.panes
              .where(
                (p) =>
                    p.machineId == agent.machineId &&
                    p.agentId == agent.harnessId,
              )
              .firstOrNull
          case final pane?) {
        pane.composerVisible = false;
        _nativePanes.add(pane);
      }
      if (inputContext != null) {
        var renewing = false;
        _nativeHeartbeats.add(
          Timer.periodic(const Duration(seconds: 20), (timer) async {
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
                _failures[(agent.machineId, agent.harnessId)] =
                    'Terminal sharing paused. $failure';
                final pane = tab.panes
                    .where(
                      (p) =>
                          p.machineId == agent.machineId &&
                          p.agentId == agent.harnessId,
                    )
                    .firstOrNull;
                pane?.session?.stageInputContext(null, watchOnly: true);
                if (pane != null) {
                  pane.inputContext = null;
                  pane.watchOnly = true;
                  unawaited(
                    pane.session?.setInputContext(null, watchOnly: true),
                  );
                }
                setState(() {});
              }
              timer.cancel();
            } finally {
              renewing = false;
            }
          }),
        );
      }
    } catch (failure) {
      if (mounted && current()) {
        _failures[(agent.machineId, agent.harnessId)] = failure.toString();
        app.reserveSuperTabPane(swarmId, agent.machineId, agent.harnessId);
        setState(() {});
      }
    }
  }

  void _focusAgent(
    SuperTabController controller,
    String tabId,
    SuperTabAgent agent,
    String groupId, {
    bool resume = false,
  }) {
    final group = controller.snapshot?.conversation(groupId);
    if (!mounted ||
        app.activeSwarmId != tabId ||
        controller.accountId != app.currentUser?.id ||
        controller.accessRevoked ||
        controller.snapshot?.agent(agent.id) == null ||
        group == null ||
        group.archived ||
        !group.agentIds.contains(agent.id)) {
      return;
    }
    controller.select(groupId);
    _terminalRequest = null;
    _focusRequest = (groupId, agent.id);
    _resumeRequest = resume ? (groupId, agent.id) : null;
    controller.selectTerminal(groupId, agent.id);
    setState(() {});
  }

  Future<void> _chooseAgentGroup(
    SuperTabController controller,
    String tabId,
    SuperTabAgent agent,
  ) async {
    final groups =
        controller.snapshot?.conversations
            .where((g) => !g.closed && g.agentIds.contains(agent.id))
            .toList() ??
        <SuperTabConversation>[];
    if (groups.isEmpty) return;
    if (groups.length == 1) {
      _focusAgent(controller, tabId, agent, groups.single.id);
      return;
    }
    final chosen = await showAppDialog<String>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: controller,
        requireWrite: false,
        projectId: agent.projectId,
        child: SuperTabAgentGroupPicker(
          controller: controller,
          agentId: agent.id,
        ),
      ),
    );
    if (chosen != null) _focusAgent(controller, tabId, agent, chosen);
  }

  @override
  Widget build(BuildContext context) {
    final canvas = KeyedSubtree(key: _canvasKey, child: widget.canvas);
    final tab = app.activeSwarm;
    final id = tab.superTabId;
    // Before any open below: a controller starts reading the way it is made.
    app.superTabs.reading = WorkspaceChrome.of(context).superTabReading;
    _showTab(tab.isSuperTab ? id : null);
    if (!tab.isSuperTab || id == null) {
      _clearNativeContext();
      _terminalRequest = null;
      return canvas;
    }
    Widget waiting(Object? error) => Stack(
      children: [
        Offstage(child: canvas),
        Center(
          child: error != null
              ? Text(error.toString())
              : const CircularProgressIndicator(),
        ),
      ],
    );
    // A restored Swarm draws before the signed-in account's profile answers:
    // it waits for the account rather than opening as nobody's.
    if (app.currentUser == null) return waiting(null);
    return FutureBuilder<SuperTabController>(
      future: app.superTabs.open(id),
      builder: (context, state) {
        final controller = state.data;
        if (controller == null ||
            controller.tabId != id ||
            controller.accountId != app.currentUser?.id) {
          return waiting(state.hasError ? state.error : null);
        }
        return ListenableBuilder(
          listenable: controller,
          builder: (context, _) {
            if (PersonalSwarm.of(app).id == controller.tabId) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted) {
                  unawaited(PersonalProjects.of(app).sync(controller));
                }
              });
            }
            _syncTerminal(controller, tab.id);
            final agents = controller.terminalAgents(controller.selectedId);
            final local = _localPanes(controller);
            final devices =
                controller.devicesSelected &&
                app.devicesEnabled &&
                !controller.accessRevoked;
            final showTerminal =
                _readyRequest == _terminalRequest &&
                (devices || agents.isNotEmpty || local.isNotEmpty) &&
                tab.panes.isNotEmpty;
            // The terminal canvas is mounted either way; whether a person can see it is this.
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) app.setSuperTabTerminalsShown(tab.id, showTerminal);
            });
            final lead = controller.snapshot?.agents
                .where((a) => controller.snapshot!.isLead(a.id))
                .firstOrNull;
            final terminal = SuperPane(
              machineId: lead?.machineId ?? '',
              harnessId: lead?.harnessId ?? '',
              title: lead == null
                  ? kDefaultCoordinatorName
                  : controller.snapshot!.coordinatorNameOf(
                      controller.snapshot!.leadProjectForAgent(lead.id)?.id ??
                          '',
                    ),
              titles: {
                for (final p in local)
                  if (app
                          .stateOf(p.machineId)
                          ?.agents
                          .where((a) => a.id == p.agentId)
                          .firstOrNull
                      case final agent?)
                    (p.machineId, p.agentId!): agent.name,
                for (final a in agents)
                  (a.machineId, a.harnessId): controller.snapshot!.agentName(
                    a.id,
                  ),
              },
              failures: Map.of(_failures),
              onRetry: () => setState(() => _terminalRequest = null),
              onResume: !controller.canWrite
                  ? null
                  : (machineId, harnessId) {
                      if (!controller.canWrite ||
                          app.stateOf(machineId)?.belongsToOtherAccount !=
                              false) {
                        return;
                      }
                      final agent = controller
                          .terminalAgents(controller.selectedId)
                          .where(
                            (a) =>
                                a.machineId == machineId &&
                                a.harnessId == harnessId,
                          )
                          .firstOrNull;
                      if (agent != null) {
                        _focusAgent(
                          controller,
                          tab.id,
                          agent,
                          controller.selectedId,
                          resume: true,
                        );
                      }
                    },
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
                  onNewProject: widget.onNewProject,
                  onNewSwarm: widget.onNewSwarm,
                  onOpenTerminal: (agent) => _focusAgent(
                    controller,
                    tab.id,
                    agent,
                    controller.selectedId,
                  ),
                  onChooseAgentTerminal: (agent) =>
                      unawaited(_chooseAgentGroup(controller, tab.id, agent)),
                  onOpenGroupTerminals: () =>
                      controller.selectGroupTerminals(controller.selectedId),
                  terminalsVisible: agents.isNotEmpty || local.isNotEmpty,
                  app: app,
                  machineName: (machine) =>
                      app.stateOf(machine)?.machine.displayName ??
                      'Offline machine',
                  isThisComputer: (machine) =>
                      app.stateOf(machine)?.isLocalMachine == true,
                  terminal: showTerminal
                      ? terminal
                      : devices || agents.isNotEmpty || local.isNotEmpty
                      ? const Center(child: CircularProgressIndicator())
                      : null,
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
) => showSuperTabSharing(context, controller);
