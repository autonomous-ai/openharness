import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../settings/settings_screen.dart';
import '../settings/settings_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/terminal_prompt.dart';
import 'agent_messages.dart';
import 'shared_tab_people.dart';
import 'shared_tab_tasks.dart';
import 'tab_people.dart';
import 'update_harness.dart';
import 'shared_tabs.dart' show SharedTabsState;

/// The parts of a shared tab's Agent Messages panel.
enum AgentMessagesTab {
  messages('Messages'),
  people('People'),
  tasks('Tasks');

  const AgentMessagesTab(this.label);
  final String label;
}

/// Show Agent Messages: [tabId]'s log, newest last. The person reads it here
/// and types into panes as always; there is nothing to compose, and nothing to
/// turn on: whether agents may message is the account's, in Settings ▸
/// Experimental (owner, 2026-10-12).
Future<void> showAgentMessages(
  BuildContext context,
  AppNotifier app, {
  required String tabId,
  required String tabName,
  AgentMessagesTab initialTab = AgentMessagesTab.messages,
}) {
  // A panel opening reads the shares again (1c spec).
  unawaited(app.sharedTabs.refresh());
  void reveal(String machineId, String agentId) {
    if (!app.revealAgentView(machineId, agentId, preferredSwarmId: tabId)) {
      unawaited(
        app.openAgentFromDial(machineId, agentId, intent: AttachIntent.person),
      );
    }
  }

  return showTerminalPrompt<void>(
    context,
    builder: (dialog) => AgentMessagesView(
      controller: app.agentMessages,
      tabId: tabId,
      tabName: tabName,
      load: () => app.readAgentMessages(tabId),
      onClose: () => Navigator.pop(dialog),
      onOpen: (recipient) {
        Navigator.pop(dialog);
        reveal(recipient.machineId, recipient.agentId);
      },
      app: app,
      initialTab: initialTab,
      onOpenPane: (machineId, agentId) {
        Navigator.pop(dialog);
        reveal(machineId, agentId);
      },
      onOpenSettings: () {
        Navigator.pop(dialog);
        unawaited(
          showSettingsScreen(
            context,
            app,
            initialSection: SettingsSection.experimental,
            source: 'agent-messages',
          ),
        );
      },
    ),
  );
}

class AgentMessagesView extends StatefulWidget {
  const AgentMessagesView({
    super.key,
    required this.controller,
    required this.tabId,
    required this.tabName,
    required this.load,
    required this.onClose,
    required this.onOpen,
    this.app,
    this.initialTab = AgentMessagesTab.messages,
    this.onOpenPane,
    this.onOpenSettings,
  });

  /// Set when the panel can show a shared tab's People and Tasks.
  final AppNotifier? app;
  final AgentMessagesTab initialTab;

  /// A Tasks assignee: the pane of this roster harness.
  final void Function(String machineId, String agentId)? onOpenPane;
  final VoidCallback? onOpenSettings;

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
  late AgentMessagesTab _tab = widget.initialTab;
  final _pills = {
    for (final t in AgentMessagesTab.values)
      t: FocusNode(debugLabel: 'Agent Messages ${t.label}'),
  };
  final _tasks = GlobalKey<SharedTabTasksState>();
  final _people = GlobalKey();

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    widget.app?.sharedTabs.addListener(_sharesChanged);
    widget.app?.experimentalFeatures.addListener(_sharesChanged);
    unawaited(_read(focusNewest: true));
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    widget.app?.sharedTabs.removeListener(_sharesChanged);
    widget.app?.experimentalFeatures.removeListener(_sharesChanged);
    _newest.dispose();
    for (final node in _pills.values) {
      node.dispose();
    }
    super.dispose();
  }

  void _sharesChanged() {
    if (mounted) setState(() {});
  }

  void _select(AgentMessagesTab tab) => setState(() => _tab = tab);

  KeyEventResult _pillKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final step = switch (event.logicalKey) {
      LogicalKeyboardKey.arrowLeft => -1,
      LogicalKeyboardKey.arrowRight => 1,
      _ => 0,
    };
    if (step == 0) return KeyEventResult.ignored;
    final next = AgentMessagesTab.values.indexOf(_tab) + step;
    if (next < 0 || next >= AgentMessagesTab.values.length) {
      return KeyEventResult.handled;
    }
    final tab = AgentMessagesTab.values[next];
    _select(tab);
    _pills[tab]!.requestFocus();
    return KeyEventResult.handled;
  }

  void _refresh() {
    switch (_tab) {
      case AgentMessagesTab.messages:
        unawaited(_read());
      case AgentMessagesTab.people:
        unawaited(widget.app?.sharedTabs.refresh());
      case AgentMessagesTab.tasks:
        _tasks.currentState?.reload();
    }
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
    final log = _log;
    final messages = log?.messages ?? const <AgentMessage>[];
    final app = widget.app;
    final shared = app?.sharedTabs.tabForDesk(widget.tabId);
    final sharedState = app?.sharedTabs.state;
    // Every tab with Agent Messages on has the panel; a shared tab adds the
    // roster, an unshared one has its own harnesses and Invite People…, once
    // the account's switch is on (final review I1). The panel itself is
    // offered only where the daemon and backend support Agent Messages.
    final panels =
        app != null &&
        (shared != null ||
            (sharedState == SharedTabsState.ready && app.agentMessagesOn));
    final tab = panels ? _tab : AgentMessagesTab.messages;
    final hint =
        '${terminalPromptHint(context, 'picker.next', '↓')} move · '
        '${terminalPromptHint(context, 'picker.accept', '⏎')} '
        '${tab == AgentMessagesTab.tasks ? 'open issue' : 'open pane'} · '
        '${terminalPromptHint(context, 'picker.cancel', 'Esc')} close';
    final Widget body;
    if (panels && tab == AgentMessagesTab.people) {
      body = shared == null
          ? TabPeople(key: _people, app: app, deskTabId: widget.tabId)
          : SharedTabPeople(
              key: _people,
              app: app,
              sharedTabId: shared.sharedTabId,
              deskTabId: widget.tabId,
            );
    } else if (panels && tab == AgentMessagesTab.tasks) {
      body = SharedTabTasks(
        key: _tasks,
        app: app,
        sharedTabId: shared?.sharedTabId,
        deskTabId: widget.tabId,
        onOpenPane: (machineId, agentId) =>
            widget.onOpenPane?.call(machineId, agentId),
      );
    } else if (log == null) {
      body = const SkeletonList(rows: 3, semanticsLabel: 'Loading messages');
    } else if (messages.isEmpty) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(
          log.reached
              ? 'No messages yet. Agents in this tab send them with '
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
      refresh: _refresh,
      child: DesktopChrome(
        child: Dialog(
          elevation: 0,
          insetPadding: const EdgeInsets.all(16),
          backgroundColor: Colors.transparent,
          shape: DesktopChrome.bareDialogShape,
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
                    if (panels)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 12, 24, 0),
                        child: Focus(
                          canRequestFocus: false,
                          onKeyEvent: (node, event) => _pillKey(node, event),
                          child: Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              for (final t in AgentMessagesTab.values)
                                DesktopPill(
                                  key: ValueKey('agent-messages-tab:${t.name}'),
                                  label: t.label,
                                  selected: tab == t,
                                  focusNode: _pills[t],
                                  onPressed: () => _select(t),
                                ),
                            ],
                          ),
                        ),
                      )
                    else if (sharedState == SharedTabsState.tooOld)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
                        child: widget.app == null
                            ? Text(
                                'Update Harness on this computer to share tabs.',
                                key: const ValueKey('agent-messages-too-old'),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.metadata(),
                              )
                            : UpdateHarnessLine(widget.app!),
                      )
                    else if (sharedState == SharedTabsState.off)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
                        child: Row(
                          children: [
                            Flexible(
                              child: Text(
                                'Sharing tabs needs Agent Messages.',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.metadata(),
                              ),
                            ),
                            const SizedBox(width: 8),
                            DesktopPill(
                              key: const ValueKey('agent-messages-settings'),
                              label: 'Settings ▸ Experimental',
                              compact: true,
                              quiet: true,
                              onPressed: widget.onOpenSettings,
                            ),
                          ],
                        ),
                      ),
                    // A machine with a harness here that did not answer
                    // (offline, or gone from the tab) holds its own part of
                    // the log.
                    if (tab == AgentMessagesTab.messages &&
                        log != null &&
                        log.reached &&
                        !log.complete)
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
