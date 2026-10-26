import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../state/app_state.dart';
import '../state/pending_question.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../theme/app_theme.dart';
import 'agent_drag.dart';
import 'dial_list_scroll.dart';
import 'harness_activity_mark.dart';
import 'engine_identity.dart';
import 'pane_header_actions.dart';
import 'rename_agent_dialog.dart';

/// One message of a cloud harness's conversation, as `cloud_transcript` gives it.
typedef CloudMessage = ({String id, String from, String text});

/// A cloud harness's pane (docs/design/2026-10-11-cloud-agents.md): it runs on
/// its maker's servers and has no terminal, so its pane is a conversation, a
/// line saying what it is doing, its question's choices, and a prompt. Its
/// header is every pane's header: the harness's name and activity mark on the
/// left, its agent and × on the right. Where it runs is said in the footer, where
/// a remote computer's name goes (`WorkspacePaneContext`), never here.
class CloudChatPane extends StatefulWidget {
  const CloudChatPane({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agent,
    this.onClose,
    this.compactHeader = false,
    this.visible = true,
    this.read,
  });

  final AppNotifier notifier;
  final String machineId;
  final Agent agent;
  final VoidCallback? onClose;
  final bool compactHeader;
  final bool visible;

  /// How the conversation is read; the notifier's `cloud_transcript` unless a
  /// test hands one in.
  final Future<Map<String, dynamic>?> Function(
    String machineId,
    String agentId,
  )?
  read;

  @override
  State<CloudChatPane> createState() => _CloudChatPaneState();
}

class _CloudChatPaneState extends State<CloudChatPane> {
  /// The agent's own name ("Devin Cloud"), and the one its lines are said by ("Devin").
  String get _agentLabel => engineIdentity(widget.agent.engine).label;
  String get _speaker => _agentLabel.split(' ').first;

  final _prompt = TextEditingController();
  final _promptFocus = FocusNode(debugLabel: 'Cloud harness prompt');
  final _scroll = ScrollController();
  List<CloudMessage> _messages = const [];
  bool _loaded = false;
  bool _sending = false;
  String? _error;
  int _readAt = -1;

  // The dial scrolls this conversation as it scrolls a terminal (DialListScroll).
  late final _dial = DialListScroll(() => _scroll);
  VoidCallback? _unregisterDial;

  void _registerDial() {
    _unregisterDial?.call();
    _unregisterDial = widget.notifier.registerCloudScroll(
      widget.machineId,
      widget.agent.id,
      _dial.handle,
    );
  }

  @override
  void initState() {
    super.initState();
    _registerDial();
    unawaited(_load());
  }

  @override
  void didUpdateWidget(CloudChatPane old) {
    super.didUpdateWidget(old);
    if (old.agent.id != widget.agent.id ||
        old.machineId != widget.machineId ||
        old.notifier != widget.notifier) {
      _dial.cancel();
      _registerDial();
    }
    // The frame says how many messages its conversation holds: read again when that moves.
    if (old.agent.id != widget.agent.id ||
        (widget.agent.cloud?.messages ?? 0) != _readAt) {
      unawaited(_load());
    }
  }

  @override
  void dispose() {
    _unregisterDial?.call();
    _dial.cancel();
    _prompt.dispose();
    _promptFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final wanted = widget.agent.cloud?.messages ?? 0;
    _readAt = wanted;
    final read = widget.read ?? widget.notifier.readCloudTranscript;
    final reply = await read(widget.machineId, widget.agent.id);
    if (!mounted || reply == null) return;
    final rows = reply['messages'];
    setState(() {
      _loaded = true;
      _messages = [
        if (rows is List)
          for (final row in rows)
            if (row is Map && row['text'] is String)
              (
                id: '${row['id']}',
                from: row['from'] == 'person' ? 'person' : 'agent',
                text: row['text'] as String,
              ),
      ];
    });
  }

  /// The person's words, typed or a choice tapped, as words for it
  /// (`cloud_send`), which its service takes as the answer to an open question
  /// too. Answered, so a refusal is said here and the words stay in the prompt.
  Future<void> _send([String? words]) async {
    final text = (words ?? _prompt.text).trim();
    if (text.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    final refused = await widget.notifier.sendCloudMessage(
      widget.machineId,
      widget.agent.id,
      text,
    );
    if (!mounted) return;
    setState(() {
      _sending = false;
      _error = refused;
      if (refused == null && words == null) _prompt.clear();
    });
    if (refused == null) unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return ColoredBox(
      color: theme.background,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          MediaQuery.withNoTextScaling(child: _header(theme.foreground)),
          Divider(height: 1, color: AppColors.border),
          Expanded(child: _conversation(theme.foreground)),
          _prompter(theme.foreground),
        ],
      ),
    );
  }

  Widget _header(Color ink) => SizedBox(
    height: widget.compactHeader ? 38 : 46,
    child: Padding(
      padding: const EdgeInsets.only(
        left: 14,
        right: grid.AppDesktop.paneCloseInset,
      ),
      child: Row(
        children: [
          Expanded(
            child: Row(
              children: [
                Flexible(
                  child: Tooltip(
                    message:
                        '${widget.agent.displayName}\n${widget.agent.cloud?.place ?? ''}',
                    waitDuration: const Duration(milliseconds: 500),
                    // Renamed as a terminal pane's title is: a double click.
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onDoubleTap: () => unawaited(
                        showAgentRenameDialog(
                          context,
                          widget.notifier,
                          widget.machineId,
                          widget.agent.id,
                          widget.agent.displayName,
                        ),
                      ),
                      child: Text(
                        widget.agent.displayName,
                        key: const ValueKey('cloud-pane-title'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: workspaceBarTextStyle(color: ink),
                      ),
                    ),
                  ),
                ),
                HarnessActivityMark(
                  app: widget.notifier,
                  machineId: widget.machineId,
                  agentId: widget.agent.id,
                  visible: widget.visible,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          // Its agent, in the ink a pane's agent rests in, and no picker: a
          // cloud harness is not moved to another agent.
          PaneHeaderActions(
            agentPicker: Semantics(
              label: 'Agent: $_agentLabel',
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(
                  _agentLabel,
                  key: const ValueKey('pane-agent-control'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: workspaceBarTextStyle(
                    color: ink.withValues(alpha: .75),
                  ),
                ),
              ),
            ),
          ),
          if (widget.onClose != null)
            PaneCloseButton(onPressed: widget.onClose!),
        ],
      ),
    ),
  );

  Widget _conversation(Color ink) {
    final style = workspaceBarTextStyle(color: ink);
    final muted = workspaceBarTextStyle(color: AppColors.mutedStrong);
    final cloud = widget.agent.cloud;
    final question = widget.notifier.questionFor(
      widget.machineId,
      widget.agent.id,
    );
    final senderWidth = _senderWidth(style);
    final rows = <Widget>[
      for (final message in _messages)
        _row(
          message.from == 'person' ? 'you' : _speaker,
          message.text,
          message.from == 'person' ? muted : style,
          muted,
          senderWidth,
          key: ValueKey('cloud-message-${message.id}'),
        ),
      if (cloud != null && cloud.working && question == null)
        _row(
          _speaker,
          '${cloud.activity ?? 'Working'}…',
          muted,
          muted,
          senderWidth,
          key: const ValueKey('cloud-activity'),
        ),
      if (cloud != null &&
          !cloud.working &&
          cloud.activity != null &&
          question == null)
        _row(
          '',
          cloud.activity!,
          muted,
          muted,
          senderWidth,
          key: const ValueKey('cloud-note'),
        ),
      if (question != null) _choices(question, style, senderWidth),
      if (_error != null)
        _row(
          '',
          _error!,
          workspaceBarTextStyle(color: AppColors.danger),
          muted,
          senderWidth,
          key: const ValueKey('cloud-error'),
        ),
    ];
    if (!_loaded && rows.isEmpty) {
      return Center(child: Text('Reading the conversation…', style: muted));
    }
    // Newest at the bottom, kept in view as messages arrive.
    return ListView(
      key: const ValueKey('cloud-conversation'),
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
      children: rows.reversed.toList(),
    );
  }

  double _senderWidth(TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: '$_speaker  ', style: style),
      textDirection: TextDirection.ltr,
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width < 40 ? 40 : width;
  }

  Widget _row(
    String sender,
    String text,
    TextStyle style,
    TextStyle muted,
    double senderWidth, {
    Key? key,
  }) => Padding(
    key: key,
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: senderWidth,
          child: Text(sender, style: muted),
        ),
        Expanded(child: SelectableText(text, style: style)),
      ],
    ),
  );

  /// Its question's choices, each a button that answers with it; with none, the
  /// prompt below takes the answer in words.
  Widget _choices(
    PendingQuestion question,
    TextStyle style,
    double senderWidth,
  ) => Padding(
    key: const ValueKey('cloud-question'),
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: senderWidth),
        Expanded(
          child: question.options.isEmpty
              ? Text(
                  'Waiting for your answer',
                  style: workspaceBarTextStyle(color: AppColors.warning),
                )
              : Wrap(
                  spacing: 14,
                  runSpacing: 4,
                  children: [
                    for (final (index, option) in question.options.indexed)
                      TextButton(
                        key: ValueKey('cloud-choice-$index'),
                        onPressed: _sending
                            ? null
                            : () => unawaited(_send(option)),
                        style: TextButton.styleFrom(
                          foregroundColor: AppColors.warning,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 4,
                            vertical: 2,
                          ),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: Text(
                          '${index + 1}) $option',
                          style: workspaceBarTextStyle(
                            color: AppColors.warning,
                          ),
                        ),
                      ),
                  ],
                ),
        ),
      ],
    ),
  );

  Widget _prompter(Color ink) {
    final stopped = widget.agent.cloud?.state == 'stopped';
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: EdgeInsets.zero,
            child: Text(
              '❯ ',
              style: workspaceBarTextStyle(color: AppColors.mutedStrong),
            ),
          ),
          Expanded(
            child: CallbackShortcuts(
              // Enter sends; Shift-Enter breaks the line, as the composer does.
              bindings: {
                const SingleActivator(LogicalKeyboardKey.enter): () =>
                    unawaited(_send()),
              },
              child: TextField(
                key: const ValueKey('cloud-prompt'),
                controller: _prompt,
                focusNode: _promptFocus,
                enabled: !_sending,
                minLines: 1,
                maxLines: 6,
                style: workspaceBarTextStyle(color: ink),
                cursorColor: ink,
                // No box: the prompt is a line, as a terminal's is.
                decoration: InputDecoration(
                  isCollapsed: true,
                  isDense: true,
                  contentPadding: EdgeInsets.zero,
                  filled: false,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  hintText: stopped ? 'Write to wake it' : 'Write to $_speaker',
                  hintStyle: workspaceBarTextStyle(
                    color: AppColors.mutedStrong,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
