import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/skeleton.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/laid_out_list.dart';
import '../controller.dart';
import '../identity.dart';
import '../model.dart';
import '../task_card.dart';
import 'personal_task_card.dart';
import 'personal_tasks.dart';
import 'tasks_pane_header.dart';

/// Activity (task #4689): every task the person may read, what waits on their Accept first, from the same
/// authenticated cursor as the chat.
class SuperTabPersonalTasksPane extends StatefulWidget {
  const SuperTabPersonalTasksPane({
    super.key,
    required this.controller,
    required this.onOpenTask,
    this.selectedId,
  });
  final SuperTabController controller;
  final ValueChanged<String> onOpenTask;

  /// The task open in the middle, whose card shows as selected.
  final String? selectedId;
  @override
  State<SuperTabPersonalTasksPane> createState() => _TasksPaneState();
}

/// Who asked and who is doing it, both at 18 (anh Dee, 11-07).
const _faceSize = 18.0;

/// Why Accept, Decline and the approval mode are disabled while a change is unconfirmed.
const _waitingWhy = 'Waiting for the last change to be confirmed';

class _TasksPaneState extends State<SuperTabPersonalTasksPane> {
  String? _error, _operationId;
  Map<String, dynamic>? _action;
  bool _sending = false, _olderFailed = false;

  /// Mine: only the reader's tasks and their agents'; else Everyone's (task #4689).
  bool _mine = false;
  SuperTabController get c => widget.controller;

  /// Everyone reads every task's pages, once the backend sends them; Mine and an older backend read the reader's.
  bool get _everyone => !_mine && c.allTasks?.supported == true;

  /// Near the end of the list, the next older page is read; the controller sends one read at a time.
  bool _onScroll(ScrollNotification note) {
    final m = note.metrics;
    final feed = _everyone ? c.allTasks : c.personalTasks;
    if (!_olderFailed &&
        feed?.olderCursor != null &&
        m.pixels >= m.maxScrollExtent - m.viewportDimension) {
      unawaited(_loadOlder());
    }
    return false;
  }

  Future<void> _loadOlder() async {
    final owner = c;
    final ok = await owner.loadOlderPersonalTasks(everyone: _everyone);
    if (mounted && identical(owner, c) && ok == _olderFailed) {
      setState(() => _olderFailed = !ok);
    }
  }

  @override
  void didUpdateWidget(SuperTabPersonalTasksPane old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, c)) {
      _error = _operationId = null;
      _action = null;
      _sending = _olderFailed = false;
    }
  }

  Future<void> _send(Map<String, dynamic> action, {bool retry = false}) async {
    if (_sending ||
        c.saving ||
        !c.canWrite ||
        c.personalTasks?.supported != true) {
      return;
    }
    if (!retry && (c.hasPendingAction || _action != null)) return;
    final owner = c;
    setState(() {
      _sending = true;
      _error = null;
      if (!retry) {
        _action = Map.of(action);
        _operationId = superTabOperationId();
      }
    });
    try {
      final answer = retry && owner.hasPendingAction
          ? await owner.retry()
          : await owner.command(_action!, operationId: _operationId);
      if (!mounted || !identical(owner, c)) return;
      // The controller keeps an action whose answer was lost and drops one the server refused. The pane follows it:
      // a copy kept after a refusal locked every card, and its Retry sent the refused change again (audit #4436, 3).
      final lost = answer == null && owner.hasPendingAction;
      final updateRequired = owner.operationErrorCode == 'UPDATE_REQUIRED';
      final refusal = answer == null && !lost
          ? owner.takeOperationError()
          : null;
      setState(() {
        if (lost) {
          _error = 'Not confirmed. Retry to check.';
        } else {
          _action = null;
          _operationId = null;
          if (answer == null) {
            _error = updateRequired
                ? 'Update Harness to change Tasks.'
                : refusal ?? 'Change refused.';
          }
        }
      });
      // A refusal means the task changed under the person: what it is now is in the next read.
      if (answer == null && !lost) unawaited(owner.refresh());
    } catch (_) {
      if (mounted && identical(owner, c)) {
        setState(() => _error = 'Not confirmed. Retry to check.');
      }
    } finally {
      if (mounted && identical(owner, c)) setState(() => _sending = false);
    }
  }

  Future<void> _reject(SuperTabPersonalTask task) async {
    final owner = c;
    final reason = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) => AlertDialog(
          // Names the task, so the person knows which one they turn down.
          title: Text(
            'Decline “${task.title}”?',
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
          content: TextField(
            key: const ValueKey('task-reject-reason'),
            controller: reason,
            autofocus: true,
            maxLength: 2000,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(labelText: 'Reason'),
            onChanged: (_) => update(() {}),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: reason.text.trim().isEmpty
                  ? null
                  : () => Navigator.pop(context, reason.text.trim()),
              child: const Text('Decline'),
            ),
          ],
        ),
      ),
    );
    // The closing route can still paint the field during its exit animation.
    WidgetsBinding.instance.addPostFrameCallback((_) => reason.dispose());
    if (text != null && mounted && identical(owner, c)) {
      await _send({
        'type': 'task.reject',
        'conversationId': task.id,
        'reason': text,
      });
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: c,
    builder: (context, _) {
      final tasks = c.personalTasks;
      final supported = tasks?.supported == true && !c.accessRevoked;
      final enabled =
          supported &&
          c.canWrite &&
          !_sending &&
          !c.saving &&
          !c.hasPendingAction &&
          _action == null;
      final waitingOnChange =
          _sending || c.saving || c.hasPendingAction || _action != null;
      // The decision being sent, by its task: its button spins.
      final sendingOn = _sending ? _action!['conversationId'] as String? : null;
      final sendingKind = switch (_action?['type']) {
        'task.approve' => 'approve',
        'task.reject' => 'reject',
        _ => null,
      };
      final snapshot = c.snapshot;
      final agents = {
        for (final a in snapshot?.agents ?? <SuperTabAgent>[]) a.id: a,
      };
      final projects = {
        for (final p in snapshot?.projects ?? <SuperTabProject>[]) p.id: p,
      };
      final people = {
        for (final p in snapshot?.people ?? <SuperTabPerson>[]) p.id: p,
      };
      // What waits on the reader's Accept first, oldest first, with no heading; then the rest, newest first (#4689).
      final activity = supported
          ? superTabActivity(
              mine: tasks!,
              everyone: c.allTasks,
              mineOnly: _mine,
            )
          : null;
      final rows = [...?activity?.pinned, ...?activity?.rest];
      // One filled box as large as the slot, under a see-through Material that
      // only carries the rows' ink: a Material's own surface was drawn only as
      // far as the rows, and the window's backing showed below them. It is the
      // Swarm's one surface, shared with the left and middle panes (#4465).
      return ColoredBox(
        color: AppPalette.swarmField,
        child: SizedBox.expand(
          child: Material(
            type: MaterialType.transparency,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SuperTabTasksPaneHeader(
                  mine: _mine,
                  onMine: (mine) => setState(() {
                    _mine = mine;
                    _olderFailed = false;
                  }),
                  mode: supported ? tasks!.mode : null,
                  onChanged: enabled
                      ? (mode) => unawaited(
                          _send({'type': 'member.approvalMode', 'mode': mode}),
                        )
                      : null,
                ),
                // Offline, the rows are what was last read: said once, quietly, until the Swarm answers again.
                if (supported && c.backendUnreachable && snapshot != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppDesktop.groupGap,
                    ),
                    child: Text(
                      'May be out of date',
                      key: const ValueKey('tasks-stale'),
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppDesktop.groupGap,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                        // Only a change whose answer was lost is retried: a refused one would be refused again.
                        if (_action case final action?)
                          TextButton(
                            onPressed: _sending
                                ? null
                                : () => _send(action, retry: true),
                            child: const Text('Retry'),
                          ),
                      ],
                    ),
                  ),
                if (!supported && !c.accessRevoked && c.snapshot == null)
                  const Expanded(child: _SkeletonCards())
                else if (!supported)
                  Padding(
                    padding: const EdgeInsets.all(AppDesktop.groupGap),
                    child: Text(
                      c.accessRevoked
                          ? 'Tasks are unavailable.'
                          : 'Update Harness to use Tasks.',
                    ),
                  )
                else if (supported)
                  Expanded(
                    // Empty means empty (anh Dee's rule 7, task #4465).
                    child: rows.isEmpty
                        ? const SizedBox.shrink()
                        : NotificationListener<ScrollNotification>(
                            onNotification: _onScroll,
                            child: LaidOutListView.builder(
                              itemCount: rows.length,
                              itemBuilder: (context, index) {
                                final task = rows[index];
                                final agent = agents[task.agentId];
                                final person = people[task.requesterId];
                                final waiting =
                                    task.status == 'proposal' &&
                                    task.canApprove;
                                return Padding(
                                  key: ValueKey('personal-task-${task.id}'),
                                  padding: const EdgeInsets.fromLTRB(
                                    AppDesktop.groupGap,
                                    0,
                                    AppDesktop.groupGap,
                                    AppDesktop.controlGap,
                                  ),
                                  child: SuperTabPersonalTaskCard(
                                    task: task,
                                    project:
                                        projects[task.projectId]?.name ??
                                        task.projectName,
                                    selected: task.id == widget.selectedId,
                                    onOpen: () => widget.onOpenTask(task.id),
                                    requester: task.requesterId == null
                                        ? null
                                        : person != null
                                        ? SuperTabAvatar.person(
                                            person,
                                            size: _faceSize,
                                          )
                                        : SuperTabAvatar(
                                            identity:
                                                'person:${task.requesterId}',
                                            name:
                                                task.requester['name']
                                                    as String? ??
                                                'Person',
                                            size: _faceSize,
                                            picture:
                                                SuperTabAvatarPicture.fromJson(
                                                  task.requester['avatar'],
                                                ),
                                          ),
                                    agent: task.agentId == null
                                        ? null
                                        : SuperTabAvatar(
                                            identity: 'agent:${task.agentId}',
                                            name:
                                                agent?.displayName ??
                                                agent?.name ??
                                                task.agent['name'] as String? ??
                                                'Agent',
                                            size: _faceSize,
                                            picture:
                                                agent?.avatar ??
                                                SuperTabAvatarPicture.fromJson(
                                                  task.agent['avatar'],
                                                ),
                                            face: true,
                                          ),
                                    waiting: waiting,
                                    onApprove: waiting && enabled
                                        ? () => _send({
                                            'type': 'task.approve',
                                            'conversationId': task.id,
                                            // The agent shown, null for none: a suggestion changed since is refused
                                            // (task #4217).
                                            'suggestedAgentId': task.agentId,
                                          })
                                        : null,
                                    onReject: waiting && enabled
                                        ? () => _reject(task)
                                        : null,
                                    pending: sendingOn == task.id
                                        ? sendingKind
                                        : null,
                                    disabledReason: waitingOnChange
                                        ? _waitingWhy
                                        : null,
                                  ),
                                );
                              },
                            ),
                          ),
                  ),
                if (supported && _olderFailed)
                  Padding(
                    padding: const EdgeInsets.all(AppDesktop.groupGap),
                    child: Row(
                      children: [
                        const Expanded(
                          child: Text('Could not load older tasks.'),
                        ),
                        TextButton(
                          key: const ValueKey('tasks-older-retry'),
                          onPressed: () {
                            setState(() => _olderFailed = false);
                            unawaited(_loadOlder());
                          },
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

/// Cards on their way: the shape of a task card (its tag, two lines of title, then who asked and its agent), on the
/// card's own surface so nothing jumps when the rows land.
class _SkeletonCards extends StatelessWidget {
  const _SkeletonCards();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final title = DesktopChrome.control().copyWith(height: 1.35);
    return SkeletonList(
      rows: 5,
      semanticsLabel: 'Loading Tasks',
      itemBuilder: (context, i) => Padding(
        padding: const EdgeInsets.fromLTRB(
          AppDesktop.groupGap,
          0,
          AppDesktop.groupGap,
          AppDesktop.controlGap,
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: AppCard.base,
            borderRadius: BorderRadius.circular(AppDesktop.rowRadius),
            border: Border.all(color: DesktopChrome.rim),
          ),
          child: Padding(
            padding: const EdgeInsets.all(SuperTabTaskCard.tilePadding),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Skeleton(
                  width: 64 + 16.0 * (i % 3),
                  height: 16,
                  // The project's capsule.
                  radius: 8,
                ),
                const SizedBox(height: AppDesktop.controlGap),
                SkeletonText(style: title, widthFactor: .9 - .1 * (i % 2)),
                SkeletonText(style: title, widthFactor: .55 + .1 * (i % 3)),
                const SizedBox(height: AppDesktop.controlGap),
                const Row(
                  children: [
                    Skeleton.circle(size: _faceSize),
                    SizedBox(width: AppDesktop.listRowGap * 2),
                    Skeleton.circle(size: _faceSize),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
