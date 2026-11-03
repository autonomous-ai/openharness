import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'controller.dart';
import 'message_row.dart' show SuperTabMessageRow;
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
      'ready' => 'ready',
      'shipped' => 'shipped',
      'done' => 'done',
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
      'ready' => AppIcons.circleDot,
      'shipped' || 'done' => AppIcons.check,
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

/// A line's mark, in the column a message's avatar stands in, so its name starts
/// where a message's text does.
class _Gutter extends StatelessWidget {
  const _Gutter(this.mark);
  final Widget mark;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: SuperTabMessageRow.avatarSize + SuperTabMessageRow.avatarGap,
    child: Align(
      alignment: Alignment.centerLeft,
      child: SizedBox(
        width: SuperTabMessageRow.avatarSize,
        child: Center(child: mark),
      ),
    ),
  );
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
          horizontal: SuperTabMessageRow.horizontalInset,
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
          final mark = _Gutter(
            Icon(
              superTabTaskMark(message),
              size: AppIcons.inlineSize,
              color: DesktopChrome.muted,
            ),
          );
          const gap = SizedBox(width: grid.AppDesktop.controlGap);
          if (constraints.maxWidth < _narrow && word.isNotEmpty) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                mark,
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
          _Gutter(
            Icon(
              AppIcons.chevronRight,
              size: AppIcons.inlineSize,
              color: DesktopChrome.muted,
            ),
          ),
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
    required this.outgoing,
    required this.onClose,
    required this.onOpenInFull,
  });

  final SuperTabController controller;
  final String taskId;

  /// The word its line says.
  final String word;

  /// The mark its line shows; null once the line is out of the chat's rows.
  final IconData? mark;

  /// The task's whole conversation in time order: its steps' rows and every
  /// thread's replies, without hidden notices.
  final List<SuperTabMessage> Function() rows;

  final Widget Function(SuperTabMessage message) row;

  /// A reply on its way, or refused with its Retry, as the chat draws one.
  final Widget Function(SuperTabOutgoing sent) outgoing;

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
    _reply.text = c.threadDraft(widget.taskId);
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
      _reply.text = c.threadDraft(widget.taskId);
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

  bool get _busy => c.uploading || c.saving || c.hasPendingAction;

  /// A plain message in the task's own conversation, to the agent with the
  /// task. Refused while something else saves: the words stay in the box.
  Future<void> _send() async {
    final id = widget.taskId;
    final files = c.threadAttachments(id, id);
    if (_busy || (_reply.text.trim().isEmpty && files.isEmpty)) return;
    final task = c.snapshot?.conversation(id);
    final assignee = task?.assignment?['agentId'];
    c.setThreadDraft(id, _reply.text, conversationId: id);
    await c.sendThreadReply(
      to: (conversationId: id, root: id),
      plain: true,
      recipients: [
        if (assignee is String && task!.agentIds.contains(assignee)) assignee,
      ],
      onSending: () {
        if (mounted && widget.taskId == id) _reply.clear();
      },
    );
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
      final pending = [
        for (final sent in c.outgoing(widget.taskId))
          if (sent.thread == null) sent,
      ];
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            // As high as the chat's header, so their rules meet.
            constraints: const BoxConstraints(minHeight: 51),
            alignment: Alignment.center,
            padding: const EdgeInsets.fromLTRB(
              SuperTabMessageRow.horizontalInset,
              0,
              grid.AppDesktop.controlGap,
              0,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(
                      'Thread',
                      style: DesktopChrome.text(medium: true),
                    ),
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
            padding: const EdgeInsets.fromLTRB(
              SuperTabMessageRow.horizontalInset,
              grid.AppDesktop.groupGap,
              SuperTabMessageRow.horizontalInset,
              grid.AppDesktop.groupGap,
            ),
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
            child: LaidOutListView.builder(
              itemCount: rows.length + pending.length,
              itemBuilder: (context, index) => index < rows.length
                  ? widget.row(rows[index])
                  : widget.outgoing(pending[index - rows.length]),
            ),
          ),
          if (c.canWrite && task?.archived == false)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                0,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
              ),
              child: SuperTabReplyBox(
                controller: c,
                text: _reply,
                focus: _focus,
                files: c.threadAttachments(widget.taskId, widget.taskId),
                enabled: true,
                writable: true,
                busy: _busy,
                error:
                    c.composerError(widget.taskId) ??
                    c.threadComposerError(widget.taskId, widget.taskId),
                onEdited: (text) => c.setThreadDraft(
                  widget.taskId,
                  text,
                  conversationId: widget.taskId,
                ),
                onSend: () => unawaited(_send()),
                surfaceKey: const ValueKey('super-task-reply-surface'),
                fieldKey: const ValueKey('super-task-reply'),
                sendKey: const ValueKey('super-task-send'),
              ),
            ),
        ],
      );
    },
  );
}
