import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';
import 'reply_box.dart';

/// A row too narrow for a task's name and word on one line keeps the name whole
/// and puts the word under it (Quiet Swarm, screen 12).
const _narrow = 360.0;

/// What a task's message says of its state (Quiet Swarm, screen 2): one word,
/// or Answer for the person asked. [readerId] is who is reading. A state this
/// build does not know says nothing rather than a word it cannot stand behind.
String superTabTaskWord(SuperTabMessage message, String readerId) =>
    switch (message.source['state']) {
      'planned' => 'planned',
      'working' => 'working',
      'waiting' =>
        message.source['answerFor'] == readerId ? 'Answer' : 'working',
      'review' => 'in review',
      'shipped' => 'shipped',
      'stopped' => 'stopped',
      _ => '',
    };

/// A task's name, from the line's title. Its text is for older apps, which
/// read it whole ("name · word"), and is the name only on a line with no title.
String superTabTaskName(SuperTabMessage message) =>
    switch (message.source['title']) {
      final String title when title.isNotEmpty => title,
      _ => message.text,
    };

IconData superTabTaskMark(SuperTabMessage message) =>
    switch (message.source['state']) {
      'planned' => AppIcons.circleDashed,
      'shipped' => AppIcons.check,
      'stopped' => AppIcons.circleSlash,
      _ => AppIcons.circleDot,
    };

/// What a proposal is for: its goal, as the server writes it (backend
/// buddies.ts, under its own opening line), else its first line.
String _proposalName(String text) {
  final lines = text.split('\n').map((line) => line.trim());
  for (final line in lines) {
    if (line.startsWith('Goal: ')) return line.substring(6).trim();
  }
  return lines.first;
}

/// One line that opens: the row both a task's and a proposal's message are.
class _OpeningRow extends StatelessWidget {
  const _OpeningRow({required this.child, required this.label, this.onOpen});

  final Widget child;
  final String label;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) => Semantics(
    button: onOpen != null,
    label: label,
    excludeSemantics: true,
    child: InkWell(
      onTap: onOpen,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: grid.AppDesktop.panelPadding,
          vertical: grid.AppDesktop.menuInset,
        ),
        child: child,
      ),
    ),
  );
}

/// A task's message in a project's chat (Quiet Swarm, screen 2; the server's
/// `task-line`, edited in place as the task moves): its mark, name and one word.
class SuperTabTaskLine extends StatelessWidget {
  const SuperTabTaskLine({
    super.key,
    required this.message,
    required this.readerId,
    this.onOpen,
  });

  final SuperTabMessage message;
  final String readerId;

  /// Null when the reader's read does not hold the task: the line stays, and
  /// opens nothing.
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final word = superTabTaskWord(message, readerId);
    final answer = word == 'Answer';
    final title = superTabTaskName(message);
    final name = Text(
      title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: DesktopChrome.text(medium: answer),
    );
    final said = Text(
      word,
      maxLines: 1,
      style: answer
          ? DesktopChrome.text(medium: true)
          : DesktopChrome.metadata(),
    );
    return _OpeningRow(
      label: word.isEmpty ? title : '$title, $word',
      onOpen: onOpen,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final mark = Icon(
            superTabTaskMark(message),
            size: AppIcons.inlineSize,
            color: DesktopChrome.muted,
          );
          const gap = SizedBox(width: grid.AppDesktop.controlGap);
          if (constraints.maxWidth < _narrow && word.isNotEmpty) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                mark,
                gap,
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [name, said],
                  ),
                ),
              ],
            );
          }
          return Row(
            children: [
              mark,
              gap,
              Expanded(child: name),
              if (word.isNotEmpty) ...[gap, said],
            ],
          );
        },
      ),
    );
  }
}

/// A Buddy's proposal in a project's chat (Quiet Swarm, screen 1): whose it is
/// and its first line; opening it shows the whole message.
class SuperTabProposalLine extends StatelessWidget {
  const SuperTabProposalLine({
    super.key,
    required this.message,
    required this.owner,
    this.onOpen,
  });

  final SuperTabMessage message;
  final String owner;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final text = 'Proposal from $owner: ${_proposalName(message.text)}';
    return _OpeningRow(
      label: text,
      onOpen: onOpen,
      child: Row(
        children: [
          Icon(
            AppIcons.chevronRight,
            size: AppIcons.inlineSize,
            color: DesktopChrome.muted,
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          Expanded(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.text(),
            ),
          ),
        ],
      ),
    );
  }
}

/// A task's own conversation beside the project's chat (Quiet Swarm, screen 3):
/// its name, who has it and its word, its messages as the chat draws them, and
/// a reply. Open in full gives it the main column.
class SuperTabTaskPanel extends StatefulWidget {
  const SuperTabTaskPanel({
    super.key,
    required this.controller,
    required this.taskId,
    required this.word,
    this.mark,
    required this.rows,
    required this.row,
    required this.onClose,
    required this.onOpenInFull,
  });

  final SuperTabController controller;
  final String taskId;

  /// The word its line says.
  final String word;

  /// The mark its line shows; null once the line is out of the chat's rows.
  final IconData? mark;

  /// The rows the chat would list for the task: its steps' too, not hidden
  /// notices, and no thread's replies, which open in full.
  final List<SuperTabMessage> Function() rows;

  final Widget Function(SuperTabMessage message) row;

  final VoidCallback onClose;
  final VoidCallback onOpenInFull;

  @override
  State<SuperTabTaskPanel> createState() => _SuperTabTaskPanelState();
}

class _SuperTabTaskPanelState extends State<SuperTabTaskPanel> {
  int _read = -1;
  final _reply = TextEditingController();
  final _focus = FocusNode();

  SuperTabController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.addListener(_follow);
    _follow();
  }

  @override
  void didUpdateWidget(SuperTabTaskPanel old) {
    super.didUpdateWidget(old);
    if (old.controller != c) {
      old.controller.removeListener(_follow);
      c.addListener(_follow);
    }
    if (old.taskId != widget.taskId) {
      _read = -1;
      _follow();
    }
  }

  @override
  void dispose() {
    c.removeListener(_follow);
    _reply.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Reads the task once, then only when it or a step has something new.
  void _follow() {
    final newest = c.taskProgress(widget.taskId);
    if (newest == null || newest == _read) return;
    _read = newest;
    unawaited(c.loadTaskMessages(widget.taskId));
  }

  /// A plain message in the task's own conversation.
  Future<void> _send() async {
    final text = _reply.text.trim();
    if (text.isEmpty || !c.canQueueText) return;
    _reply.clear();
    await c.command({
      'type': 'message.send',
      'conversationId': widget.taskId,
      'text': text,
      'replyTo': null,
      'recipientIds': const <String>[],
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final task = c.snapshot?.conversation(widget.taskId);
      final assignee = task?.assignment?['agentId'];
      final who = assignee is String ? c.snapshot?.agent(assignee)?.name : null;
      final rows = widget.rows();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.groupGap,
              grid.AppDesktop.controlGap,
              grid.AppDesktop.controlGap,
              grid.AppDesktop.controlGap,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text('Thread', style: DesktopChrome.heading()),
                  ),
                ),
                TextButton(
                  key: const ValueKey('super-task-panel-full'),
                  onPressed: widget.onOpenInFull,
                  child: const Text('Open in full'),
                ),
                AppIconButton(
                  key: const ValueKey('super-task-panel-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close thread',
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
          Divider(height: 1, thickness: 1, color: DesktopChrome.rim),
          Padding(
            padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (widget.mark case final mark?) ...[
                  Icon(
                    mark,
                    size: AppIcons.inlineSize,
                    color: DesktopChrome.muted,
                  ),
                  const SizedBox(width: grid.AppDesktop.controlGap),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        task?.title ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.text(medium: true),
                      ),
                      Text(
                        [
                          ?who,
                          if (widget.word.isNotEmpty) widget.word,
                        ].join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.metadata(),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: rows.length,
              itemBuilder: (context, index) => widget.row(rows[index]),
            ),
          ),
          if (c.canWrite && task?.archived == false)
            SuperTabReplyBox(
              controller: c,
              text: _reply,
              focus: _focus,
              files: c.threadAttachments(widget.taskId, widget.taskId),
              enabled: true,
              writable: true,
              busy: !c.canQueueText,
              error: null,
              onEdited: (_) {},
              onSend: () => unawaited(_send()),
            ),
        ],
      );
    },
  );
}
