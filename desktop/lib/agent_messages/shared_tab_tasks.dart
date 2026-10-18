import 'dart:async';

import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'shared_tab_errors.dart';
import 'task_step.dart';
import 'shared_tab_placement.dart' show plainSharedText, shortSharedText;
import 'shared_tabs.dart';
import 'shared_tabs_model.dart';

/// One line for why a tab's tasks could not be read (1c spec, Errors).
String sharedTasksErrorText(String code) => switch (code) {
  'GH_MISSING' => 'Install the GitHub CLI (gh) on this computer to see tasks.',
  'GH_SIGNED_OUT' => 'Run gh auth login on this computer to see tasks.',
  'RATE_LIMITED' ||
  'TIMEOUT' ||
  'GH_FAILED' => 'GitHub didn\'t answer. Try again later.',
  _ => sharedTabErrorText(SharedTabsFailure(code, '')),
};

/// Tasks: the GitHub issues agents of a shared tab work on, with their pull
/// request and CI. Enter or a click opens the issue; an assignee opens its
/// pane. Issue titles come from other accounts and are plain text.
class SharedTabTasks extends StatefulWidget {
  const SharedTabTasks({
    super.key,
    required this.app,
    this.sharedTabId,
    required this.deskTabId,
    required this.onOpenPane,
  });

  final AppNotifier app;

  /// Null for a tab that is not shared: its tasks are read by [deskTabId].
  final String? sharedTabId;
  final String deskTabId;

  /// Focuses the pane of a roster harness (the view closes first).
  final void Function(String machineId, String agentId) onOpenPane;

  @override
  State<SharedTabTasks> createState() => SharedTabTasksState();
}

class SharedTabTasksState extends State<SharedTabTasks> {
  @override
  void initState() {
    super.initState();
    // Not while the tree is building: the read notifies its listeners at once.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) reload();
    });
  }

  String get _key => widget.sharedTabId ?? 'tab:${widget.deskTabId}';

  void reload() => unawaited(
    widget.app.sharedTabs.loadTasks(
      _key,
      tabId: widget.sharedTabId == null ? widget.deskTabId : null,
    ),
  );

  void _open(String url) => unawaited(openInBrowser(Uri.parse(url)));

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final shares = widget.app.sharedTabs;
    return ListenableBuilder(
      listenable: shares,
      builder: (context, _) {
        final tasks = shares.tasksFor(_key);
        final tab = shares.tabForDesk(widget.deskTabId);
        // A tab made a moment ago is not known to the daemon for a while:
        // that is "no tasks yet" (Ctrl-R asks again), never an error.
        final young = widget.sharedTabId == null && tasks.error == 'NOT_A_TAB';
        final error = young ? null : tasks.error;
        if (!tasks.loaded && error == null && !young) {
          // Not read yet (or reading): the shape of the table, never "No tasks".
          return const SkeletonList(
            key: ValueKey('shared-tasks-loading'),
            rows: 4,
            semanticsLabel: 'Loading tasks',
          );
        }
        return ListView(
          key: const ValueKey('shared-tasks'),
          shrinkWrap: true,
          padding: EdgeInsets.zero,
          children: [
            if (error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: Text(
                  sharedTasksErrorText(error),
                  key: const ValueKey('shared-tasks-error'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.metadata(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
              ),
            if ((tasks.loaded || young) && tasks.rows.isEmpty && error == null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 24),
                child: Text(
                  'No tasks for this tab. Agents in it create them as GitHub issues.',
                  key: const ValueKey('shared-tasks-empty'),
                  textAlign: TextAlign.center,
                  style: DesktopChrome.text(
                    size: 13,
                    color: DesktopChrome.muted,
                  ),
                ),
              ),
            if (tasks.rows.isNotEmpty) ...[
              const _Header(),
              for (final row in tasks.rows)
                _TaskRow(
                  key: ValueKey('shared-task:${row.repo}#${row.issue}'),
                  row: row,
                  harness: taskRosterHarness(tab, row.assignee),
                  step: taskStepLabel(
                    taskStep(
                      row,
                      assigneeWorking: taskAssigneeWorking(
                        widget.app,
                        widget.deskTabId,
                        tab,
                        row.assignee,
                      ),
                    ),
                  ),
                  onOpenIssue: () => _open(row.url),
                  onOpenPr: row.pr == null ? null : () => _open(row.pr!.url),
                  onOpenPane: widget.onOpenPane,
                ),
              if (tasks.truncated)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  child: Text(
                    'Showing the newest tasks.',
                    style: DesktopChrome.metadata(),
                  ),
                ),
            ],
          ],
        );
      },
    );
  }
}

/// The roster harness a task marker names: its account (by id, or by the
/// address's label, `markerLabel`) and its harness (by `markerMatch`). Null
/// outside a shared tab, or when the roster has no such harness.
SharedTabHarness? taskRosterHarness(
  SharedTab? tab,
  ({String accountId, String harness})? assignee,
) {
  if (tab == null || assignee == null) return null;
  // The marker names an account by its address's label (`markerLabel`).
  final emails = {
    tab.ownerAccountId: tab.ownerEmail,
    for (final m in tab.members) m.accountId: m.email,
  };
  final mine = <SharedTabHarness>[];
  for (final h in tab.harnesses) {
    final email = emails[h.accountId];
    final sameAccount =
        h.accountId == assignee.accountId ||
        (email != null &&
            email.isNotEmpty &&
            markerLabel(email) == assignee.accountId);
    if (sameAccount) mine.add(h);
  }
  // Two harnesses of an account may make one marker name: told apart by the
  // id start in the note, and never given to the first (`markerMatch`).
  final i = markerMatch(assignee.harness, [
    for (final h in mine) (names: [h.name], agentId: h.agentId),
  ]);
  return i == null ? null : mine[i];
}

/// This account's own harness panes of [deskTabId] the marker names, by
/// their name under this account's marker label (a tab that is not shared).
Iterable<({String machineId, String agentId})> _ownAssigneePanes(
  AppNotifier app,
  String deskTabId,
  ({String accountId, String harness}) assignee,
) sync* {
  final me = app.sharedTabs.snapshot.me;
  if (me == null || assignee.accountId != markerLabel(me.email)) return;
  final swarm = app.swarms.where((s) => s.id == deskTabId).firstOrNull;
  final found = <({String machineId, String agentId, List<String> names})>[];
  for (final pane in swarm?.panes ?? const []) {
    final id = pane.agentId, state = app.machineStates[pane.machineId];
    if (id == null || state == null || state.belongsToOtherAccount) continue;
    final agent = state.agents.where((a) => a.id == id).firstOrNull;
    if (agent == null) continue;
    found.add((
      machineId: pane.machineId,
      agentId: id,
      names: [agent.name, agent.displayName],
    ));
  }
  // The note names it by its marker name (final review I2), with its id start
  // where two make the same one: never the first of them.
  final i = markerMatch(assignee.harness, [
    for (final f in found) (names: f.names, agentId: f.agentId),
  ]);
  if (i != null) {
    yield (machineId: found[i].machineId, agentId: found[i].agentId);
  }
}

/// The harness a task's assignee is in [deskTabId]: the roster's in a shared
/// tab, otherwise an own harness pane by its name. Null when none is known.
({String machineId, String agentId})? taskAssigneeHarness(
  AppNotifier app,
  String deskTabId,
  SharedTab? tab,
  ({String accountId, String harness})? assignee,
) {
  if (assignee == null) return null;
  final h = taskRosterHarness(tab, assignee);
  if (h != null) return (machineId: h.machineId, agentId: h.agentId);
  if (tab != null) return null;
  return _ownAssigneePanes(app, deskTabId, assignee).firstOrNull;
}

/// Whether the harness the marker names is working now: a roster harness of
/// a shared tab, or, in an unshared tab, an own harness pane by its name
/// under this account's marker label. Unknown is not working.
bool taskAssigneeWorking(
  AppNotifier app,
  String deskTabId,
  SharedTab? tab,
  ({String accountId, String harness})? assignee,
) {
  if (assignee == null) return false;
  final h = taskRosterHarness(tab, assignee);
  if (h != null) {
    return app.machineStates[h.machineId]?.processingAgentIds.contains(
          h.agentId,
        ) ==
        true;
  }
  if (tab != null) return false;
  return _ownAssigneePanes(app, deskTabId, assignee).any(
    (p) =>
        app.machineStates[p.machineId]?.processingAgentIds.contains(
          p.agentId,
        ) ==
        true,
  );
}

const _repoWidth = 88.0,
    _issueWidth = 48.0,
    _assigneeWidth = 96.0,
    _prWidth = 56.0,
    _ciWidth = 48.0,
    _stepWidth = 136.0;

class _Header extends StatelessWidget {
  const _Header();

  @override
  Widget build(BuildContext context) {
    Widget cell(String text, {double? width}) {
      final t = Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: DesktopChrome.metadata(),
      );
      return width == null
          ? Expanded(child: t)
          : SizedBox(width: width, child: t);
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
      child: Row(
        children: [
          cell('Repo', width: _repoWidth),
          cell('Issue', width: _issueWidth),
          cell('Title'),
          cell('Assignee', width: _assigneeWidth),
          cell('Pull request', width: _prWidth),
          cell('CI', width: _ciWidth),
          cell('Step', width: _stepWidth),
        ],
      ),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({
    super.key,
    required this.row,
    required this.harness,
    required this.step,
    required this.onOpenIssue,
    required this.onOpenPr,
    required this.onOpenPane,
  });

  final SharedTaskRow row;
  final SharedTabHarness? harness;
  final String step;
  final VoidCallback onOpenIssue;
  final VoidCallback? onOpenPr;
  final void Function(String machineId, String agentId) onOpenPane;

  Widget _link(
    String text,
    VoidCallback? onPressed, {
    Key? key,
    required double width,
  }) => SizedBox(
    width: width,
    child: TextButton(
      key: key,
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: DesktopChrome.accent,
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 4),
        alignment: Alignment.centerLeft,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        splashFactory: NoSplash.splashFactory,
      ),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: DesktopChrome.control(),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final highContrast = MediaQuery.highContrastOf(context);
    final repo = shortSharedText(row.repo, 40);
    final title = plainSharedText(row.title);
    final assignee = row.assignee;
    final assigneeName = assignee == null
        ? ''
        : shortSharedText(assignee.harness, 24);
    final pr = row.pr;
    final ci = pr == null || pr.ci == 'none' ? '' : shortSharedText(pr.ci, 12);
    return Row(
      children: [
        Expanded(
          child: TextButton(
            key: ValueKey('shared-task-open:${row.repo}#${row.issue}'),
            onPressed: onOpenIssue,
            style:
                TextButton.styleFrom(
                  foregroundColor: DesktopChrome.foreground,
                  minimumSize: const Size(0, 36),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  alignment: Alignment.centerLeft,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(
                      DesktopChrome.rowRadius,
                    ),
                  ),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  splashFactory: NoSplash.splashFactory,
                ).copyWith(
                  side: WidgetStateProperty.resolveWith(
                    (states) => BorderSide(
                      width: 1.5,
                      color: states.contains(WidgetState.focused)
                          ? (highContrast
                                ? DesktopChrome.accent
                                : DesktopChrome.focusRing)
                          : Colors.transparent,
                    ),
                  ),
                ),
            child: Row(
              children: [
                SizedBox(
                  width: _repoWidth - 12,
                  child: Text(
                    repo,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(),
                  ),
                ),
                SizedBox(
                  width: _issueWidth,
                  child: Text(
                    '#${row.issue}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(
                      color: row.state == 'open' ? null : DesktopChrome.muted,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(),
                  ),
                ),
              ],
            ),
          ),
        ),
        if (assignee == null)
          const SizedBox(width: _assigneeWidth)
        else if (harness case final h?)
          _link(
            assigneeName,
            () => onOpenPane(h.machineId, h.agentId),
            key: ValueKey('shared-task-assignee:${row.repo}#${row.issue}'),
            width: _assigneeWidth,
          )
        else
          SizedBox(
            width: _assigneeWidth,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                assigneeName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(),
              ),
            ),
          ),
        if (pr == null)
          const SizedBox(width: _prWidth)
        else
          _link(
            '#${pr.number}',
            onOpenPr,
            key: ValueKey('shared-task-pr:${row.repo}#${row.issue}'),
            width: _prWidth,
          ),
        SizedBox(
          width: _ciWidth,
          child: Text(
            ci,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(),
          ),
        ),
        SizedBox(
          width: _stepWidth,
          child: Tooltip(
            message: step,
            child: Text(
              step,
              key: ValueKey('shared-task-step:${row.repo}#${row.issue}'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(),
            ),
          ),
        ),
      ],
    );
  }
}
