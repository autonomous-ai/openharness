import 'dart:async';

import 'package:flutter/material.dart';

import '../../state/harness_activity.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart';
import '../../widgets/harness_activity_mark.dart';
import '../../widgets/laid_out_list.dart';
import '../../widgets/desktop_chrome.dart';
import '../controller.dart';
import '../identity.dart';
import '../model.dart';
import 'personal_tasks.dart';

/// The person's active work, from the same authenticated cursor as the chat.
class SuperTabPersonalTasksPane extends StatefulWidget {
  const SuperTabPersonalTasksPane({
    super.key,
    required this.controller,
    required this.onOpenTask,
  });
  final SuperTabController controller;
  final ValueChanged<String> onOpenTask;
  @override
  State<SuperTabPersonalTasksPane> createState() => _TasksPaneState();
}

class _TasksPaneState extends State<SuperTabPersonalTasksPane> {
  String? _expanded, _error, _operationId;
  Map<String, dynamic>? _action;
  bool _sending = false;
  SuperTabController get c => widget.controller;

  @override
  void didUpdateWidget(SuperTabPersonalTasksPane old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, c)) {
      _expanded = _error = _operationId = null;
      _action = null;
      _sending = false;
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
      final snapshot = c.snapshot;
      final agents = {
        for (final a in snapshot?.agents ?? <SuperTabAgent>[]) a.id: a,
      };
      final projects = {
        for (final p in snapshot?.projects ?? <SuperTabProject>[]) p.id: p,
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
                        DropdownButtonHideUnderline(
                          child: DropdownButton<String>(
                            key: const ValueKey('tasks-approval-mode'),
                            value: tasks!.mode,
                            style: Theme.of(context).textTheme.bodySmall,
                            items: const [
                              DropdownMenuItem(
                                value: 'autoApprove',
                                child: Text('Auto approve'),
                              ),
                              DropdownMenuItem(
                                value: 'review',
                                child: Text('Review'),
                              ),
                            ],
                            onChanged: enabled
                                ? (value) {
                                    if (value != null) {
                                      unawaited(
                                        _send({
                                          'type': 'member.approvalMode',
                                          'mode': value,
                                        }),
                                      );
                                    }
                                  }
                                : null,
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
                if (!supported)
                  Padding(
                    padding: const EdgeInsets.all(AppDesktop.groupGap),
                    child: Text(
                      c.accessRevoked
                          ? 'Tasks are unavailable.'
                          : c.snapshot == null
                          ? 'Loading Tasks…'
                          : 'Update Harness to use Tasks.',
                    ),
                  )
                else
                  Expanded(
                    child: tasks!.rows.isEmpty
                        ? const Center(child: Text('No tasks yet'))
                        : LaidOutListView.builder(
                            itemCount: tasks.rows.length,
                            itemBuilder: (context, index) {
                              final task = tasks.rows[index];
                              final agent = agents[task.agentId];
                              final name =
                                  agent?.displayName ??
                                  agent?.name ??
                                  task.agent['name'] as String? ??
                                  'Not assigned';
                              final project =
                                  projects[task.projectId]?.name ??
                                  task.projectName;
                              final pending =
                                  task.status == 'proposal' && task.canApprove;
                              return Column(
                                key: ValueKey('personal-task-${task.id}'),
                                children: [
                                  InkWell(
                                    onTap: () {
                                      if (pending) {
                                        setState(
                                          () => _expanded = _expanded == task.id
                                              ? null
                                              : task.id,
                                        );
                                      } else {
                                        widget.onOpenTask(task.id);
                                      }
                                    },
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: AppDesktop.groupGap,
                                        vertical: AppDesktop.controlGap,
                                      ),
                                      child: Column(
                                        children: [
                                          Row(
                                            children: [
                                              Flexible(
                                                child: Container(
                                                  padding:
                                                      const EdgeInsets.symmetric(
                                                        horizontal: AppDesktop
                                                            .badgeInset,
                                                        vertical: AppDesktop
                                                            .listRowGap,
                                                      ),
                                                  decoration: BoxDecoration(
                                                    color: Theme.of(context)
                                                        .colorScheme
                                                        .surfaceContainerHighest,
                                                    borderRadius:
                                                        BorderRadius.circular(
                                                          AppDesktop.rowRadius,
                                                        ),
                                                  ),
                                                  child: Text(
                                                    project,
                                                    maxLines: 1,
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                    style: Theme.of(context)
                                                        .textTheme
                                                        .labelSmall,
                                                  ),
                                                ),
                                              ),
                                              const SizedBox(width: 7),
                                              Expanded(
                                                flex: 2,
                                                child: Text(
                                                  task.title,
                                                  maxLines: 1,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                ),
                                              ),
                                            ],
                                          ),
                                          const SizedBox(height: 5),
                                          Row(
                                            children: [
                                              if (task.agentId != null) ...[
                                                SuperTabAvatar(
                                                  identity:
                                                      'agent:${task.agentId}',
                                                  name: name,
                                                  size: 20,
                                                  picture:
                                                      agent?.avatar ??
                                                      SuperTabAvatarPicture.fromJson(
                                                        task.agent['avatar'],
                                                      ),
                                                  pattern: true,
                                                ),
                                                const SizedBox(width: 6),
                                              ],
                                              Expanded(
                                                child: Text(
                                                  name,
                                                  maxLines: 1,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .bodySmall
                                                      ?.copyWith(
                                                        color:
                                                            DesktopChrome.muted,
                                                      ),
                                                ),
                                              ),
                                              if (pending)
                                                Text(
                                                  'Waiting for you',
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .bodySmall
                                                      ?.copyWith(
                                                        color:
                                                            DesktopChrome.muted,
                                                      ),
                                                ),
                                              const SizedBox(width: 8),
                                              _TaskMark(task.status),
                                            ],
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  if (_expanded == task.id && pending)
                                    Padding(
                                      padding: const EdgeInsets.fromLTRB(
                                        AppDesktop.groupGap,
                                        0,
                                        AppDesktop.groupGap,
                                        AppDesktop.controlGap,
                                      ),
                                      child: Column(
                                        children: [
                                          DropdownButtonFormField<String>(
                                            key: ValueKey(
                                              'task-agent-${task.id}',
                                            ),
                                            initialValue:
                                                agents.containsKey(
                                                      task.agentId,
                                                    ) &&
                                                    !agents[task.agentId]!
                                                        .isBuddy
                                                ? task.agentId
                                                : null,
                                            // The row's own text size: a dropdown's default is
                                            // larger and bolder than the task titles around it.
                                            style: DefaultTextStyle.of(context)
                                                .style,
                                            decoration: const InputDecoration(
                                              labelText: 'Suggested agent',
                                              isDense: true,
                                            ),
                                            items: [
                                              for (final a
                                                  in agents.values.where(
                                                    (a) => !a.isBuddy,
                                                  ))
                                                DropdownMenuItem(
                                                  value: a.id,
                                                  child: Text(
                                                    a.displayName ?? a.name,
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                  ),
                                                ),
                                            ],
                                            onChanged: enabled
                                                ? (id) {
                                                    if (id != null) {
                                                      unawaited(
                                                        _send({
                                                          'type':
                                                              'task.suggest',
                                                          'conversationId':
                                                              task.id,
                                                          'agentId': id,
                                                        }),
                                                      );
                                                    }
                                                  }
                                                : null,
                                          ),
                                          Row(
                                            mainAxisAlignment:
                                                MainAxisAlignment.end,
                                            children: [
                                              TextButton(
                                                onPressed: enabled
                                                    ? () => _reject(task)
                                                    : null,
                                                child: const Text('Reject'),
                                              ),
                                              FilledButton(
                                                onPressed: enabled
                                                    ? () => _send({
                                                        'type': 'task.approve',
                                                        'conversationId':
                                                            task.id,
                                                      })
                                                    : null,
                                                child: const Text('Approve'),
                                              ),
                                            ],
                                          ),
                                        ],
                                      ),
                                    ),
                                ],
                              );
                            },
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

class _TaskMark extends StatelessWidget {
  const _TaskMark(this.status);
  final String status;
  @override
  Widget build(BuildContext context) {
    if (status == 'proposal' || status == 'rejected') {
      final label = status == 'proposal' ? 'Proposal' : 'Rejected';
      return Tooltip(
        message: label,
        child: Icon(
          status == 'proposal' ? AppIcons.circleDashed : AppIcons.circleX,
          size: AppIcons.metadataSize,
          semanticLabel: label,
        ),
      );
    }
    final activity = switch (status) {
      'done' || 'shipped' => HarnessActivity.done,
      'working' => HarnessActivity.working,
      'needs_human' || 'needs_human_approval' => HarnessActivity.needsInput,
      'blocked' || 'stuck' => HarnessActivity.failed,
      'stopped' => HarnessActivity.paused,
      _ => HarnessActivity.starting,
    };
    return ActivityMark(
      activity: activity,
      color: Theme.of(context).colorScheme.onSurface,
    );
  }
}
