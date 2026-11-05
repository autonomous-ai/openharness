import 'dart:async';

import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../terminal/terminal_theme_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'leaderboard/models_section.dart';
import 'leaderboard/reader.dart';
import 'scorecard.dart';
import 'scorecard_view.dart';
import 'message_row.dart' show SuperTabMessageRow;
import 'local_models.dart';
import 'machines.dart';
import 'backlog_view.dart';
import 'model.dart';
import 'pull_request_facts.dart';
import 'sharing.dart';
import 'swarm_delete.dart';
import 'swarm_switcher.dart' show PersonalSwarm;

/// What Manage shows (docs/plans/2026-11-02-quiet-swarm-design.md, screens 10,
/// 10b, 10c): what used to stand in the sidebar and the Swarm dropdown, one
/// click away. Devices is the devices pane the view already holds.
enum SuperTabManageTab { machines, models, devices, swarm, backlog, scorecard }

/// Machines, Models, Devices, Swarm, Backlog, Scorecard, under Manage's heading.
class SuperTabManageTabs extends StatelessWidget {
  const SuperTabManageTabs({
    super.key,
    required this.selected,
    required this.onChoose,
    this.devices = true,
  });

  final SuperTabManageTab selected;
  final ValueChanged<SuperTabManageTab> onChoose;

  /// Whether this build has the devices pane (`AppNotifier.devicesEnabled`).
  final bool devices;

  @override
  Widget build(BuildContext context) {
    Widget tab(SuperTabManageTab value, String label) => Padding(
      padding: const EdgeInsets.only(right: grid.AppDesktop.menuInset),
      child: AppTabPill(
        tapKey: ValueKey('super-manage-tab-${value.name}'),
        label: label,
        selected: selected == value,
        onTap: () => onChoose(value),
      ),
    );

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.groupGap,
        vertical: grid.AppDesktop.controlGap,
      ),
      child: Wrap(
        children: [
          tab(SuperTabManageTab.machines, 'Machines'),
          tab(SuperTabManageTab.models, 'Models'),
          if (devices) tab(SuperTabManageTab.devices, 'Devices'),
          tab(SuperTabManageTab.swarm, 'Swarm'),
          tab(SuperTabManageTab.backlog, 'Backlog'),
          tab(SuperTabManageTab.scorecard, 'Scorecard'),
        ],
      ),
    );
  }
}

/// Manage's Machines, Models, Swarm or Backlog. Each is built only while it
/// shows, so what it runs (the machines' clock, the Backlog's pull request
/// watch) stops when it does not.
class SuperTabManagePage extends StatelessWidget {
  const SuperTabManagePage({
    super.key,
    required this.controller,
    required this.tab,
    required this.onAddAgent,
    this.app,
    this.board,
    this.onOpenAgent,
    this.onOpenConversation,
    this.facts,
    this.readLocal,
    this.now = DateTime.now,
  });

  final SuperTabController controller;
  final SuperTabManageTab tab;
  final AppNotifier? app;
  final SuperTabLeaderboardReader? board;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final ValueChanged<SuperTabAgent>? onOpenAgent;

  /// Opens a task's chat from the Backlog; [facts] gives its rows' checks.
  final bool Function(String id)? onOpenConversation;
  final SuperTabPullRequestFacts? facts;

  /// Forwarded to [SuperTabMachines], for a test without a real machine.
  final Future<MachineResources?> Function(String machineId)? readLocal;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    // Machines' online state and marks do not touch the controller, as in the
    // sidebar group they came from.
    listenable: Listenable.merge([
      controller,
      if (app case final app?) ...[app, app.agentUnread],
      terminalThemeStore,
      appearancePrefsStore,
    ]),
    builder: (context, _) => DesktopChrome(
      child: switch (tab) {
        SuperTabManageTab.machines => SuperTabMachines(
          controller: controller,
          app: app,
          onAddAgent: onAddAgent,
          onOpenAgent: onOpenAgent,
          readLocal: readLocal,
          now: now,
          manage: true,
        ),
        SuperTabManageTab.models => _ManageModels(
          controller: controller,
          app: app,
          board: board,
          now: now,
        ),
        // The view holds the devices pane in this one's place.
        SuperTabManageTab.devices => const SizedBox.shrink(),
        SuperTabManageTab.swarm => _ManageSwarm(
          controller: controller,
          app: app,
        ),
        SuperTabManageTab.backlog => SuperTabBacklogView(
          controller: controller,
          facts: facts,
          now: now,
          onOpenConversation: (id) => onOpenConversation?.call(id),
        ),
        SuperTabManageTab.scorecard => _ManageScorecard(controller: controller),
      },
    ),
  );
}

/// The action at a Manage page's foot, on the right: quiet, as the design draws
/// it.
class _FootAction extends StatelessWidget {
  const _FootAction({
    required this.label,
    required this.onPressed,
    this.actionKey,
  });
  final String label;
  final VoidCallback? onPressed;
  final Key? actionKey;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerRight,
    child: TextButton(key: actionKey, onPressed: onPressed, child: Text(label)),
  );
}

/// What a model's row keeps inside its own edges.
const _modelRowInset = 12.0;

class _ManageModels extends StatelessWidget {
  const _ManageModels({
    required this.controller,
    required this.now,
    this.app,
    this.board,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final SuperTabLeaderboardReader? board;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    return LaidOutListView(
      // A model's row has its own 12 inside: its mark starts under the heading.
      padding: const EdgeInsets.symmetric(
        horizontal: SuperTabMessageRow.horizontalInset - _modelRowInset,
        vertical: grid.AppDesktop.controlGap,
      ),
      children: [
        if (board case final board?)
          LeaderboardModelsSection(
            board: board,
            // Whichever project the board asked about: Models is the Swarm's.
            projectId: board.projectId,
            collapsed: false,
            now: now,
            heading: false,
          ),
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.only(right: _modelRowInset),
          child: _FootAction(
            label: 'Your models…',
            actionKey: const ValueKey('super-local-models'),
            onPressed: controller.snapshot == null
                ? null
                : () => showSwarmLocalModels(
                    context,
                    controller,
                    app: app,
                    now: now,
                  ),
          ),
        ),
      ],
    );
  }
}

class _ManageSwarm extends StatefulWidget {
  const _ManageSwarm({required this.controller, this.app});
  final SuperTabController controller;
  final AppNotifier? app;

  @override
  State<_ManageSwarm> createState() => _ManageSwarmState();
}

class _ManageSwarmState extends State<_ManageSwarm> {
  SuperTabController get c => widget.controller;
  DeletedSwarms? get _deleted {
    final app = widget.app;
    return app == null ? null : DeletedSwarms.of(app);
  }

  @override
  void initState() {
    super.initState();
    if (_deleted case final deleted?) unawaited(deleted.read());
  }

  bool get _isPersonal {
    final app = widget.app;
    return app != null && PersonalSwarm.of(app).id == c.tabId;
  }

  /// Why this person can't leave yet (they contribute a project's coordinator);
  /// null when they can.
  String? get _leaveBlocked {
    final snapshot = c.snapshot;
    if (snapshot == null) return null;
    for (final agent in snapshot.agents) {
      if (agent.contributorId != c.accountId) continue;
      if (snapshot.leadProtectionReason(agent.id) case final reason?) {
        return reason;
      }
    }
    return null;
  }

  Future<void> _delete() async {
    if (!await showDeleteSwarmDialog(context, c)) return;
    final app = widget.app;
    if (app == null) return;
    unawaited(app.superTabs.refreshTabs());
    unawaited(_deleted?.read());
  }

  Future<void> _leave() async {
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        requireWrite: false,
        child: AlertDialog(
          title: const Text('Leave Swarm?'),
          content: superTabLeaveWords(
            'Swarm access and agent contributions will be withdrawn.',
            autoJoin: c.snapshot?.autoJoin == true,
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const ValueKey('super-manage-leave-confirm'),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Leave'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !mounted || c.accessRevoked) return;
    await c.command({'type': 'member.remove', 'userId': c.accountId});
  }

  Widget _fact(String label, Widget value, {Widget? action}) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: 36),
    child: Row(
      children: [
        Expanded(child: Text(label, style: DesktopChrome.control())),
        value,
        ?action,
      ],
    ),
  );

  Text _value(String text) => Text(
    text,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: DesktopChrome.control(color: DesktopChrome.muted),
  );

  @override
  Widget build(BuildContext context) {
    final snapshot = c.snapshot;
    if (snapshot == null || c.accessRevoked) return const SizedBox.shrink();
    final owner = snapshot.people
        .where((p) => p.id == snapshot.ownerId)
        .firstOrNull;
    final deleted = _deleted;
    final blocked = _leaveBlocked;
    return LaidOutListView(
      padding: const EdgeInsets.symmetric(
        horizontal: SuperTabMessageRow.horizontalInset,
        vertical: grid.AppDesktop.controlGap,
      ),
      children: [
        _fact('Name', _value(snapshot.name)),
        if (owner != null) _fact('Owner', _value(owner.shownName)),
        _fact(
          'People',
          _value('${snapshot.people.length}'),
          action: Padding(
            padding: const EdgeInsets.only(left: grid.AppDesktop.controlGap),
            child: TextButton(
              key: const ValueKey('super-manage-people'),
              onPressed: () => showSuperTabSharing(context, c),
              child: const Text('Manage people'),
            ),
          ),
        ),
        const SizedBox(height: 16),
        // Its owner's alone, never Personal (backend deletion.ts). Everyone
        // else there may leave.
        if (!_isPersonal && c.isOwner)
          _FootAction(
            label: 'Delete Swarm…',
            actionKey: const ValueKey('super-manage-delete'),
            onPressed: _delete,
          )
        else if (!_isPersonal)
          Tooltip(
            message: blocked ?? '',
            child: _FootAction(
              label: 'Leave Swarm…',
              actionKey: const ValueKey('super-manage-leave'),
              onPressed: blocked == null ? _leave : null,
            ),
          ),
        if (deleted != null)
          ListenableBuilder(
            listenable: deleted,
            builder: (context, _) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final swarm in deleted.items)
                  _fact(
                    swarm.name,
                    _value(
                      deleted.restoreError?.id == swarm.id
                          ? deleted.restoreError!.message
                          : 'Deleted · ${restoreTimeLeft(swarm.purgeAt, DateTime.now())}',
                    ),
                    action: Padding(
                      padding: const EdgeInsets.only(
                        left: grid.AppDesktop.controlGap,
                      ),
                      child: TextButton(
                        key: ValueKey('super-manage-restore-${swarm.id}'),
                        onPressed: deleted.restoring(swarm.id)
                            ? null
                            : () => unawaited(
                                deleted.restore(swarm.id, tab: _activeTab),
                              ),
                        child: const Text('Restore'),
                      ),
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  /// The workspace tab showing this Swarm, for a restore to show it there.
  String? get _activeTab => widget.app?.swarms
      .where((tab) => tab.isSuperTab && tab.superTabId == c.tabId)
      .firstOrNull
      ?.id;
}

/// Manage's Scorecard: its reader lives while the tab shows.
class _ManageScorecard extends StatefulWidget {
  const _ManageScorecard({required this.controller});
  final SuperTabController controller;

  @override
  State<_ManageScorecard> createState() => _ManageScorecardState();
}

class _ManageScorecardState extends State<_ManageScorecard> {
  late final _reader = SuperTabScorecardReader(
    tabId: widget.controller.tabId,
    request: widget.controller.request,
  );

  @override
  void dispose() {
    _reader.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SuperTabScorecardView(
    projects: widget.controller.snapshot?.projects ?? const [],
    projectId: widget.controller.selected?.projectId,
    reader: _reader,
  );
}
