import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/terminal_prompt.dart';
import 'agent_messages.dart';

/// Show Agent Messages: [tabId]'s log, newest last. The person reads it here
/// and types into panes as always; there is nothing to compose.
Future<void> showAgentMessages(
  BuildContext context,
  AppNotifier app, {
  required String tabId,
  required String tabName,
}) => showTerminalPrompt<void>(
  context,
  builder: (context) => AgentMessagesView(
    controller: app.agentMessages,
    tabId: tabId,
    tabName: tabName,
    load: () => app.readAgentMessages(tabId),
    onClose: () => Navigator.pop(context),
    onOpen: (recipient) {
      Navigator.pop(context);
      if (!app.revealAgentView(
        recipient.machineId,
        recipient.agentId,
        preferredSwarmId: tabId,
      )) {
        unawaited(
          app.openAgentFromDial(
            recipient.machineId,
            recipient.agentId,
            intent: AttachIntent.person,
          ),
        );
      }
    },
  ),
);

class AgentMessagesView extends StatefulWidget {
  const AgentMessagesView({
    super.key,
    required this.controller,
    required this.tabId,
    required this.tabName,
    required this.load,
    required this.onClose,
    required this.onOpen,
  });

  final AgentMessagesController controller;
  final String tabId, tabName;
  final Future<AgentMessageLog> Function() load;
  final VoidCallback onClose;

  /// Enter on a row: the pane of the message's (first) recipient.
  final void Function(AgentMessageParty recipient) onOpen;

  @override
  State<AgentMessagesView> createState() => _AgentMessagesViewState();
}

class _AgentMessagesViewState extends State<AgentMessagesView> {
  AgentMessageLog? _log;
  bool _loading = false, _again = false;
  late int _traffic = widget.controller.trafficFor(widget.tabId);
  final _newest = FocusNode(debugLabel: 'Newest agent message');

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    unawaited(_read(focusNewest: true));
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    _newest.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    // A message moved in this tab: read the log again, once at a time.
    final traffic = widget.controller.trafficFor(widget.tabId);
    if (traffic != _traffic) {
      _traffic = traffic;
      unawaited(_read());
    }
    setState(() {});
  }

  Future<void> _read({bool focusNewest = false}) async {
    if (_loading) {
      _again = true;
      return;
    }
    setState(() => _loading = true);
    try {
      final log = await widget.load();
      if (!mounted) return;
      setState(() => _log = log);
      if (focusNewest && log.messages.isNotEmpty) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          // Only while nothing in the view has the keyboard yet.
          final focused = FocusManager.instance.primaryFocus;
          if (mounted && (focused == null || focused.skipTraversal)) {
            _newest.requestFocus();
          }
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
    if (_again && mounted) {
      _again = false;
      await _read();
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final controller = widget.controller;
    final on = controller.isOn(widget.tabId);
    final failure = controller.failureFor(widget.tabId);
    final log = _log;
    final messages = log?.messages ?? const <AgentMessage>[];
    final hint =
        '${terminalPromptHint(context, 'picker.next', '↓')} move · '
        '${terminalPromptHint(context, 'picker.accept', '⏎')} open pane · '
        '${terminalPromptHint(context, 'picker.cancel', 'Esc')} close';
    final Widget body;
    if (log == null) {
      body = const SkeletonList(rows: 3, semanticsLabel: 'Loading messages');
    } else if (messages.isEmpty) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(
          log.reached
              ? 'No messages yet. Turn on Agent Messages, then agents use '
                    '`harness send`.'
              : 'Could not read this tab’s messages. Check that Harness is '
                    'running on this computer, then try again.',
          key: const ValueKey('agent-messages-empty'),
          textAlign: TextAlign.center,
          style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
        ),
      );
    } else {
      // Reversed, so the newest sits at the bottom and the list opens there.
      body = ListView.builder(
        reverse: true,
        shrinkWrap: true,
        itemCount: messages.length,
        itemBuilder: (context, index) {
          final message = messages[messages.length - 1 - index];
          return _MessageRow(
            key: ValueKey('agent-message:${message.id}'),
            message: message,
            focusNode: index == 0 ? _newest : null,
            nameOf: controller.nameOfParty,
            onOpen: () => widget.onOpen(message.to.first),
          );
        },
      );
    }
    return TerminalPromptKeys(
      cancel: widget.onClose,
      refresh: () => unawaited(_read()),
      child: DesktopChrome(
        child: Dialog(
          elevation: 0,
          insetPadding: const EdgeInsets.all(16),
          backgroundColor: Colors.transparent,
          child: SizedBox(
            width: 640,
            child: DesktopDialogSurface(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 620),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DesktopDialogHeader(
                      title: '${widget.tabName} · Agent Messages',
                      onClose: widget.onClose,
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 24),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              'Agent Messages',
                              style: DesktopChrome.control(medium: true),
                            ),
                          ),
                          Semantics(
                            label: 'Agent Messages',
                            child: Switch(
                              key: const ValueKey('agent-messages-switch'),
                              value: on,
                              onChanged: controller.isPending(widget.tabId)
                                  ? null
                                  : (value) => unawaited(
                                      controller.setEnabled(
                                        widget.tabId,
                                        value,
                                      ),
                                    ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (failure != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 4, 24, 0),
                        child: Semantics(
                          liveRegion: true,
                          child: Text(
                            failure,
                            style: DesktopChrome.metadata(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ),
                      ),
                    // A machine with a harness here that did not answer
                    // (offline, or gone from the tab) holds its own part of
                    // the log.
                    if (log != null && log.reached && !log.complete)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
                        child: Text(
                          'Some machines didn’t answer; their messages may be '
                          'missing.',
                          key: const ValueKey('agent-messages-incomplete'),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata(),
                        ),
                      ),
                    const SizedBox(height: 12),
                    Divider(height: 1, color: DesktopChrome.rim),
                    Flexible(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 8,
                        ),
                        child: body,
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 4, 24, 16),
                      child: Text(
                        hint,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.metadata(),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// `14:02` today, `Oct 9 14:02` before.
String agentMessageTime(DateTime at, {DateTime? now}) {
  final today = now ?? DateTime.now();
  String two(int n) => n.toString().padLeft(2, '0');
  final clock = '${two(at.hour)}:${two(at.minute)}';
  return at.year == today.year && at.month == today.month && at.day == today.day
      ? clock
      : '${_months[at.month - 1]} ${at.day} $clock';
}

/// The row's state: one word when every recipient is in it, else each
/// recipient's. Failed ones say why.
({String text, bool failed, String? reasons}) agentMessageStateLabel(
  AgentMessage message,
  String Function(AgentMessageParty) nameOf,
) {
  final states = [for (final r in message.to) message.stateOf(r)];
  final reasons = [
    for (final r in message.to)
      if (message.statusOf(r) case AgentMessageStatus(
        state: AgentMessageState.failed,
        :final reason?,
      ))
        message.to.length == 1 ? reason : '${nameOf(r)}: $reason',
  ].join(' · ');
  final failed = states.contains(AgentMessageState.failed);
  final text = states.toSet().length == 1
      ? states.first.name
      : [
          for (var i = 0; i < message.to.length; i++)
            '${nameOf(message.to[i])} ${states[i].name}',
        ].join(' · ');
  return (
    text: text,
    failed: failed,
    reasons: reasons.isEmpty ? null : reasons,
  );
}

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    super.key,
    required this.message,
    required this.nameOf,
    required this.onOpen,
    this.focusNode,
  });

  final AgentMessage message;
  final String Function(AgentMessageParty) nameOf;
  final VoidCallback onOpen;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final highContrast = MediaQuery.highContrastOf(context);
    final route =
        '${nameOf(message.from)} → ${message.to.map(nameOf).join(', ')}';
    final state = agentMessageStateLabel(message, nameOf);
    final error = Theme.of(context).colorScheme.error;
    final time = agentMessageTime(message.at);
    return Semantics(
      label:
          '$time, $route, ${message.firstLine}, ${state.text}'
          '${state.reasons == null ? '' : ', ${state.reasons}'}',
      excludeSemantics: true,
      button: true,
      onTap: onOpen,
      child: TextButton(
        focusNode: focusNode,
        onPressed: onOpen,
        style:
            TextButton.styleFrom(
              foregroundColor: DesktopChrome.foreground,
              minimumSize: const Size(0, 40),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              alignment: Alignment.centerLeft,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
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
              overlayColor: WidgetStateProperty.resolveWith(
                (states) => states.contains(WidgetState.pressed)
                    ? DesktopChrome.foreground.withValues(alpha: .12)
                    : states.contains(WidgetState.hovered)
                    ? DesktopChrome.foreground.withValues(alpha: .06)
                    : Colors.transparent,
              ),
            ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 88,
              child: Text(
                time,
                maxLines: 1,
                style: DesktopChrome.metadata().copyWith(
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          route,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(medium: true),
                        ),
                      ),
                      const SizedBox(width: 12),
                      // Several recipients each with a state can outgrow the
                      // row; the route keeps at least as much room.
                      Flexible(
                        child: Text(
                          state.text,
                          key: const ValueKey('agent-message-state'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.end,
                          style: DesktopChrome.metadata(
                            color: state.failed ? error : null,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    message.firstLine,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.text(
                      size: 13,
                      color: DesktopChrome.muted,
                    ),
                  ),
                  if (state.reasons case final reasons?) ...[
                    const SizedBox(height: 2),
                    Text(
                      reasons,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(color: error),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
