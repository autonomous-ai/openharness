import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_select_field.dart';
import '../../shared/widgets/skeleton.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/laid_out_list.dart';
import '../controller.dart';
import '../identity.dart';
import '../model.dart';
import '../task_card.dart';
import 'personal_task_card.dart';
import 'personal_tasks.dart';

/// The person's active work, from the same authenticated cursor as the chat.
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

/// Who asked, a step smaller than the agent beside it, as on a Board tile.
const _requesterSize = 18.0;

/// Why Approve, Reject and the approval mode are disabled while a change is unconfirmed.
const _waitingWhy = 'Waiting for the last change to be confirmed';

class _TasksPaneState extends State<SuperTabPersonalTasksPane> {
  String? _error, _operationId;
  Map<String, dynamic>? _action;
  bool _sending = false, _olderFailed = false;
  SuperTabController get c => widget.controller;

  /// Near the end of the list, the next older page is read; the controller sends one read at a time.
  bool _onScroll(ScrollNotification note) {
    final m = note.metrics;
    if (!_olderFailed &&
        c.personalTasks?.olderCursor != null &&
        m.pixels >= m.maxScrollExtent - m.viewportDimension) {
      unawaited(_loadOlder());
    }
    return false;
  }

  Future<void> _loadOlder() async {
    final owner = c;
    final ok = await owner.loadOlderPersonalTasks();
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
      setState(() {
        if (answer != null) {
          _action = null;
          _operationId = null;
        } else {
          _error = owner.operationErrorCode == 'UPDATE_REQUIRED'
              ? 'Update Harness to change Tasks.'
              : 'The change is not confirmed. Retry to check it.';
        }
      });
    } catch (_) {
      if (mounted && identical(owner, c)) {
        setState(
          () => _error = 'The change is not confirmed. Retry to check it.',
        );
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
            'Reject “${task.title}”?',
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
              child: const Text('Reject task'),
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
      // One filled box as large as the slot, under a see-through Material that
      // only carries the rows' ink: a Material's own surface was drawn only as
      // far as the rows, and the window's backing showed below them.
      return ColoredBox(
        color: Theme.of(context).colorScheme.surface,
        child: SizedBox.expand(
          child: Material(
            type: MaterialType.transparency,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppDesktop.groupGap,
                    vertical: AppDesktop.controlGap,
                  ),
                  child: Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'Tasks',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ),
                      if (supported)
                        // Disabled as the decisions are; the shared select has no disabled state of its own.
                        ExcludeFocus(
                          excluding: !enabled,
                          child: IgnorePointer(
                            ignoring: !enabled,
                            child: AppSelectField<String>(
                              key: const ValueKey('tasks-approval-mode'),
                              value: tasks!.mode,
                              semanticLabel: 'Approval',
                              textStyle: DesktopChrome.metadata(
                                color: DesktopChrome.foreground,
                              ),
                              width: AppSelectField.fitWidth(
                                context,
                                labels: const ['Auto approve', 'Review'],
                                textStyle: DesktopChrome.metadata(),
                              ),
                              menuWidth: 300,
                              menuAlignedToEnd: true,
                              options: const [
                                SelectOption(
                                  value: 'autoApprove',
                                  label: 'Auto approve',
                                  detail: 'Tasks you ask for start right away.',
                                ),
                                SelectOption(
                                  value: 'review',
                                  label: 'Review',
                                  detail: 'Tasks you ask for wait until you approve them.',
                                ),
                              ],
                              onChanged: (value) {
                                if (value != tasks.mode) {
                                  unawaited(
                                    _send({
                                      'type': 'member.approvalMode',
                                      'mode': value,
                                    }),
                                  );
                                }
                              },
                            ),
                          ),
                        ),
                    ],
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
                        TextButton(
                          onPressed: _sending
                              ? null
                              : () => _send(_action!, retry: true),
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
                else
                  Expanded(
                    child: tasks!.rows.isEmpty
                        ? const Center(
                            child: Padding(
                              padding: EdgeInsets.all(AppDesktop.groupGap),
                              child: Text(
                                'No tasks yet. Tasks your agents start or propose show here.',
                                textAlign: TextAlign.center,
                              ),
                            ),
                          )
                        : NotificationListener<ScrollNotification>(
                            onNotification: _onScroll,
                            child: LaidOutListView.builder(
                              itemCount: tasks.rows.length,
                              itemBuilder: (context, index) {
                                final task = tasks.rows[index];
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
                                            size: _requesterSize,
                                          )
                                        : SuperTabAvatar(
                                            identity:
                                                'person:${task.requesterId}',
                                            name:
                                                task.requester['name']
                                                    as String? ??
                                                'Person',
                                            size: _requesterSize,
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
                                            size: SuperTabAvatar.rowSize,
                                            picture:
                                                agent?.avatar ??
                                                SuperTabAvatarPicture.fromJson(
                                                  task.agent['avatar'],
                                                ),
                                            pattern: true,
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
            borderRadius: BorderRadius.circular(AppCard.insetRadius),
            border: Border.all(color: AppCard.insetHair),
          ),
          child: Padding(
            padding: const EdgeInsets.all(SuperTabTaskCard.tilePadding),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Skeleton(
                  width: 64 + 16.0 * (i % 3),
                  height: 16,
                  radius: AppDesktop.paneCloseInset,
                ),
                const SizedBox(height: AppDesktop.controlGap),
                SkeletonText(style: title, widthFactor: .9 - .1 * (i % 2)),
                SkeletonText(style: title, widthFactor: .55 + .1 * (i % 3)),
                const SizedBox(height: AppDesktop.controlGap),
                const Row(
                  children: [
                    Skeleton.circle(size: _requesterSize),
                    SizedBox(width: AppDesktop.listRowGap * 2),
                    Skeleton.circle(size: SuperTabAvatar.rowSize),
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
