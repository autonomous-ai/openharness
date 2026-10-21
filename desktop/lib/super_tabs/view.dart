import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../state/app_state.dart';
import 'roster.dart';
import 'recording_notice.dart';
import 'pull_requests.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'message_row.dart';
import 'route_row.dart';
import 'work_details.dart';
import 'project_sidebar.dart';
import 'project_options.dart';

/// The contents of one app tab. Its title stays in the app's existing tab bar.
/// [terminal] is the existing native pane, with its own controls and input.
class SuperTabView extends StatefulWidget {
  const SuperTabView({
    super.key,
    required this.controller,
    required this.onInvite,
    required this.onAddAgent,
    required this.onOpenTerminal,
    required this.machineName,
    this.terminal,
    this.onCloseTerminal,
    this.onOpenGroupTerminals,
    this.terminalsVisible = false,
    this.app,
    this.onNewProject,
    this.onChooseAgentTerminal,
  });
  final SuperTabController controller;
  final VoidCallback onInvite;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final ValueChanged<SuperTabAgent> onOpenTerminal;
  final String Function(String machineId) machineName;
  final Widget? terminal;
  final VoidCallback? onCloseTerminal, onOpenGroupTerminals;
  final bool terminalsVisible;
  final AppNotifier? app;
  final VoidCallback? onNewProject;
  final ValueChanged<SuperTabAgent>? onChooseAgentTerminal;

  @override
  State<SuperTabView> createState() => _SuperTabViewState();
}

class _SuperTabViewState extends State<SuperTabView> {
  final _composer = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Swarm message');
  final _scroll = <String, ScrollController>{};
  final _latest = <String, int>{};
  final _following = <String, bool>{};
  final _newAfter = <String, int>{};
  final _replies = <String, SuperTabMessage>{};
  String? _selected;
  int _scrollRequest = 0;
  bool _jumpingToEnd = false;
  bool _sidebarOpen = false;
  bool _rosterOpen = false;
  bool _showPullRequests = false;
  final _loadingOlder = <String>{};
  int _mentionIndex = 0;
  String? _dismissedMention;
  SuperTabController get c => widget.controller;

  String _agentName(SuperTabAgent agent) =>
      c.snapshot?.agentName(agent.id, fallback: agent.name) ?? agent.name;

  String _authorName(SuperTabMessage message) =>
      c.snapshot?.authorName(message) ?? message.authorName;

  /// Your own message reads You, in the row and in the quote of it.
  String _shownAuthor(SuperTabController c, SuperTabMessage message) =>
      message.authorId == c.accountId && !message.fromAgent
      ? 'You'
      : _authorName(message);

  @override
  void initState() {
    super.initState();
    c.addListener(_changed);
    _changed();
  }

  @override
  void didUpdateWidget(SuperTabView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != c) {
      oldWidget.controller.removeListener(_changed);
      c.addListener(_changed);
      for (final scroll in _scroll.values) {
        scroll.dispose();
      }
      _scroll.clear();
      _latest.clear();
      _following.clear();
      _newAfter.clear();
      _replies.clear();
      _selected = null;
      _changed();
    }
  }

  void _changed() {
    if (!mounted) return;
    if (c.accessRevoked) {
      _replies.clear();
      _newAfter.clear();
    }
    final visible =
        c.snapshot?.conversations.map((g) => g.id).toSet() ?? <String>{};
    _replies.removeWhere((id, _) => !visible.contains(id));
    final id = c.selectedId;
    final firstView = !_scroll.containsKey(id);
    final scroll = _scroll.putIfAbsent(id, ScrollController.new);
    final atEnd = scroll.hasClients
        ? scroll.position.extentAfter < 40
        : (_following[id] ?? true);
    final previous = _latest[id] ?? 0;
    final latest = c.messages(id).lastOrNull?.sequence ?? 0;
    final grew = latest > previous && !_loadingOlder.contains(id);
    _latest[id] = latest;
    if (grew && !atEnd) _newAfter.putIfAbsent(id, () => previous);
    final draft = c.accessRevoked ? '' : c.draft(id);
    if (_selected != id) {
      _scrollRequest++;
      _jumpingToEnd = false;
    }
    if (_selected != id || _composer.text != draft) {
      _composer.value = TextEditingValue(
        text: draft,
        selection: TextSelection.collapsed(offset: draft.length),
      );
    }
    _selected = id;
    setState(() {});
    if (firstView || (grew && atEnd)) {
      _followEnd(id);
    }
  }

  void _followEnd(String id) {
    final request = ++_scrollRequest;
    _jumpingToEnd = true;
    void advance(int attempt) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final scroll = _scroll[id];
        if (!mounted ||
            request != _scrollRequest ||
            c.selectedId != id ||
            scroll == null ||
            !scroll.hasClients) {
          return;
        }
        scroll.jumpTo(scroll.position.maxScrollExtent);
        // A lazy list refines its extent after laying out variable-height code
        // and replies. A single jump can stop above the actual last message.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted ||
              request != _scrollRequest ||
              c.selectedId != id ||
              !scroll.hasClients) {
            return;
          }
          if (scroll.position.extentAfter > 1 && attempt < 12) {
            advance(attempt + 1);
          } else {
            _jumpingToEnd = false;
            if (scroll.position.extentAfter < 40) {
              _readToEnd(id, _latest[id] ?? 0);
            }
          }
        });
        WidgetsBinding.instance.scheduleFrame();
      });
      WidgetsBinding.instance.scheduleFrame();
    }

    advance(0);
  }

  void _readToEnd(String id, int sequence) {
    _following[id] = true;
    if (_newAfter.containsKey(id)) setState(() => _newAfter.remove(id));
    if (!_terminalsVisible && !_showPullRequests) {
      c.markRead(id, through: sequence);
    }
  }

  void _jumpToLatest() {
    _followEnd(c.selectedId);
    _focus.requestFocus();
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    _composer.dispose();
    _focus.dispose();
    for (final scroll in _scroll.values) {
      scroll.dispose();
    }
    super.dispose();
  }

  Future<void> _send() async {
    final mentions = _mentionChoices;
    if (mentions.isNotEmpty) {
      _chooseMention(mentions[_mentionIndex.clamp(0, mentions.length - 1)]);
      return;
    }
    if (!c.canWrite ||
        c.selected == null ||
        c.selected!.archived ||
        c.saving ||
        c.hasPendingAction ||
        _composer.text.trim().isEmpty) {
      return;
    }
    final id = c.selectedId;
    final result = await c.send(replyTo: _replies[id]?.id);
    if (mounted && result != null) setState(() => _replies.remove(id));
  }

  void _closeRoster() {
    setState(() => _rosterOpen = false);
    if (!_terminalsVisible) _focus.requestFocus();
  }

  void _closeSidebar() {
    setState(() => _sidebarOpen = false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_sidebarOpen) _focus.requestFocus();
    });
  }

  ({int start, int end, String query})? get _mentionAtCursor {
    final value = _composer.value;
    if (!value.selection.isValid ||
        !value.selection.isCollapsed ||
        (value.composing.isValid && !value.composing.isCollapsed)) {
      return null;
    }
    final end = value.selection.baseOffset;
    final prefix = value.text.substring(0, end);
    final match = RegExp(r'(?:^|\s)@([^@\n]*)$').firstMatch(prefix);
    if (match == null || prefix == _dismissedMention) return null;
    final start = prefix.lastIndexOf('@');
    final query = match.group(1)!;
    if (c.mentions(c.selectedId).values.contains('@${query.trimRight()}')) {
      return null;
    }
    return (start: start, end: end, query: query.toLowerCase());
  }

  List<SuperTabAgent> get _mentionChoices {
    final mention = _mentionAtCursor;
    if (mention == null) return const [];
    return c.snapshot?.agents
            .where(
              (agent) =>
                  c.selected?.agentIds.contains(agent.id) == true &&
                  '${_agentName(agent)} ${agent.engine}'.toLowerCase().contains(
                    mention.query,
                  ),
            )
            .take(6)
            .toList() ??
        const [];
  }

  void _chooseMention(SuperTabAgent agent) {
    final at = _mentionAtCursor;
    if (at == null) return;
    final token = '@${_agentName(agent)}';
    final text = _composer.text.replaceRange(at.start, at.end, '$token ');
    c.setDraft(c.selectedId, text);
    c.mention(c.selectedId, agent.id, token);
    _composer.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: at.start + token.length + 1),
    );
    setState(() => _mentionIndex = 0);
    _focus.requestFocus();
  }

  Future<void> _earlier() async {
    final id = c.selectedId, scroll = _scroll[c.selectedId];
    if (scroll == null || !scroll.hasClients || !_loadingOlder.add(id)) return;
    final offset = scroll.offset, extent = scroll.position.maxScrollExtent;
    try {
      await c.loadMessages(id, older: true);
      await WidgetsBinding.instance.endOfFrame;
      if (mounted && c.selectedId == id && scroll.hasClients) {
        scroll.jumpTo(
          (offset + scroll.position.maxScrollExtent - extent).clamp(
            0.0,
            scroll.position.maxScrollExtent,
          ),
        );
      }
    } finally {
      _loadingOlder.remove(id);
    }
  }

  Future<void> _groupAction(String action, SuperTabConversation group) async {
    final c = this.c;
    if (action == 'routing') {
      await showSuperTabRouting(context, c);
      return;
    }
    if (c.snapshot?.isProjectLead(group.id) == true && action != 'archived') {
      final project = c.snapshot!.projectFor(group.id);
      if (project != null) await showProjectAction(context, c, project, action);
      return;
    }
    if (action == 'archived') {
      await _archived();
      return;
    }
    if (action == 'work') {
      await showSuperTabWork(context, c, group.id);
      return;
    }
    if (action == 'archive') {
      await c.command({
        'type': 'conversation.archive',
        'conversationId': group.id,
        'archived': !group.archived,
      });
      return;
    }
    var title = group.title, busy = false;
    await showAppDialog<void>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        conversationId: group.id,
        child: StatefulBuilder(
          builder: (context, update) => AlertDialog(
            title: const Text('Rename conversation'),
            content: TextFormField(
              initialValue: title,
              autofocus: true,
              maxLength: 160,
              onChanged: (value) => update(() => title = value),
            ),
            actions: [
              TextButton(
                onPressed: busy ? null : () => Navigator.pop(context),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: busy || title.trim().isEmpty
                    ? null
                    : () async {
                        update(() => busy = true);
                        final result = await c.command({
                          'type': 'conversation.rename',
                          'conversationId': group.id,
                          'title': title.trim(),
                        });
                        if (!context.mounted) return;
                        if (result != null) {
                          Navigator.pop(context);
                        } else {
                          update(() => busy = false);
                        }
                      },
                child: const Text('Save'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _archived() async {
    final c = this.c;
    var query = '';
    final selected = await showAppDialog<String>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        requireWrite: false,
        child: StatefulBuilder(
          builder: (context, update) => ListenableBuilder(
            listenable: c,
            builder: (context, _) {
              final groups =
                  c.snapshot?.conversations
                      .where(
                        (group) =>
                            group.archived &&
                            group.projectId == c.selected?.projectId &&
                            group.title.toLowerCase().contains(query),
                      )
                      .toList() ??
                  <SuperTabConversation>[];
              return AlertDialog(
                title: const Text('Archived conversations'),
                content: SizedBox(
                  width: 400,
                  height: 320,
                  child: Column(
                    children: [
                      TextField(
                        autofocus: true,
                        decoration: const InputDecoration(
                          hintText: 'Find a conversation',
                        ),
                        onChanged: (value) =>
                            update(() => query = value.trim().toLowerCase()),
                      ),
                      const SizedBox(height: 12),
                      Expanded(
                        child: groups.isEmpty
                            ? const Center(
                                child: Text('No archived conversations.'),
                              )
                            : ListView(
                                children: [
                                  for (final group in groups)
                                    ListTile(
                                      title: Text(
                                        group.label,
                                        style: DesktopChrome.control(),
                                      ),
                                      onTap: () =>
                                          Navigator.pop(context, group.id),
                                    ),
                                ],
                              ),
                      ),
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Close'),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
    if (!mounted || widget.controller != c || selected == null) return;
    c.select(selected);
  }

  Widget _sidebar() => ProjectSidebar(
    controller: c,
    onNewProject: widget.onNewProject,
    needsHuman: (group) => _needsHuman(group).length,
    onSelect: (id) {
      c.select(id);
      _closeSidebar();
    },
  );

  List<SuperTabAgent> _needsHuman(SuperTabConversation group) =>
      c.snapshot?.agents
          .where(
            (agent) =>
                group.agentIds.contains(agent.id) &&
                (widget.app?.questionFor(agent.machineId, agent.harnessId) !=
                        null ||
                    (group.assignment?['status'] == 'needs_human' &&
                        group.assignment?['agentId'] == agent.id)),
          )
          .toList() ??
      const [];

  void _openAgent(SuperTabAgent agent) {
    setState(() {
      _showPullRequests = false;
      _rosterOpen = false;
    });
    widget.onOpenTerminal(agent);
  }

  bool get _terminalsVisible =>
      widget.terminalsVisible || widget.terminal != null;

  Widget _header(SuperTabConversation? group, bool narrow, bool showRoster) =>
      Container(
        constraints: const BoxConstraints(minHeight: 52),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
        ),
        child: Row(
          children: [
            if (narrow)
              AppIconButton(
                icon: AppIcons.columns2,
                tooltip: 'Conversations',
                onPressed: () => setState(() => _sidebarOpen = !_sidebarOpen),
              ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                child: Text(
                  group == null
                      ? 'Choose a project'
                      : c.snapshot!.isProjectLead(group.id)
                      ? c.snapshot!.projectFor(group.id)!.name
                      : group.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.text(medium: true),
                ),
              ),
            ),
            AppIconButton(
              key: const ValueKey('super-chat'),
              icon: AppIcons.messageSquareText,
              size: 20,
              tooltip: 'Chat',
              selected: !_terminalsVisible && !_showPullRequests,
              color: !_terminalsVisible && !_showPullRequests
                  ? DesktopChrome.accent
                  : DesktopChrome.muted,
              onPressed: () {
                setState(() => _showPullRequests = false);
                widget.onCloseTerminal?.call();
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) _focus.requestFocus();
                });
              },
            ),
            const SizedBox(width: 4),
            AppIconButton(
              key: const ValueKey('super-terminals'),
              icon: AppIcons.terminal,
              size: 20,
              tooltip: 'Group terminals (${group?.agentIds.length ?? 0})',
              selected: _terminalsVisible,
              color: _terminalsVisible
                  ? DesktopChrome.accent
                  : DesktopChrome.muted,
              onPressed: group?.agentIds.isNotEmpty == true
                  ? () {
                      setState(() => _showPullRequests = false);
                      widget.onOpenGroupTerminals?.call();
                    }
                  : null,
            ),
            const SizedBox(width: 4),
            AppIconButton(
              key: const ValueKey('super-pull-requests'),
              icon: AppIcons.gitPullRequest,
              size: 20,
              tooltip: 'Pull requests',
              selected: !_terminalsVisible && _showPullRequests,
              color: !_terminalsVisible && _showPullRequests
                  ? DesktopChrome.accent
                  : DesktopChrome.muted,
              onPressed: () {
                widget.onCloseTerminal?.call();
                setState(() => _showPullRequests = true);
              },
            ),
            if (group != null) _options(group),
            if (!showRoster)
              AppIconButton(
                icon: AppIcons.users,
                tooltip: 'Members and machines',
                selected: _rosterOpen,
                onPressed: () => setState(() => _rosterOpen = !_rosterOpen),
              ),
          ],
        ),
      );

  Widget _options(SuperTabConversation group) {
    final project = c.snapshot?.projectFor(group.id);
    final isProject = c.snapshot?.isProjectLead(group.id) == true;
    final editable = c.canWrite && !c.saving && !c.hasPendingAction;
    Widget item(String label, VoidCallback? action) => MenuItemButton(
      style: const ButtonStyle(
        minimumSize: WidgetStatePropertyAll(Size(208, 32)),
        side: WidgetStatePropertyAll(BorderSide.none),
        padding: WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 12)),
        alignment: Alignment.centerLeft,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      onPressed: action,
      child: Text(label),
    );
    return MenuAnchor(
      style: const MenuStyle(
        minimumSize: WidgetStatePropertyAll(Size(220, 0)),
        padding: WidgetStatePropertyAll(EdgeInsets.all(6)),
      ),
      menuChildren: [
        if (isProject) ...[
          if (editable && project?.ownerId == c.accountId)
            item('Rename project', () => _groupAction('rename', group)),
          item('Project details', () => _groupAction('details', group)),
          if (editable && project?.ownerId == c.accountId)
            item('Sharing', () => _groupAction('sharing', group)),
          if (editable)
            item('Update cadence', () => _groupAction('cadence', group)),
          item('Swarm routing', () => _groupAction('routing', group)),
        ] else ...[
          item('Work details', () => _groupAction('work', group)),
          if (editable) ...[
            item('Rename', () => _groupAction('rename', group)),
            item(
              group.archived ? 'Reopen conversation' : 'Archive',
              group.assignment == null ||
                      const [
                        'done',
                        'stopped',
                      ].contains(group.assignment!['status'])
                  ? () => _groupAction('archive', group)
                  : null,
            ),
          ],
        ],
        if (c.snapshot?.conversations.any(
              (g) => g.archived && g.projectId == group.projectId,
            ) ==
            true)
          item('Archived conversations', () => _groupAction('archived', group)),
      ],
      builder: (context, menu, _) => AppIconButton(
        key: const ValueKey('super-group-options'),
        icon: AppIcons.ellipsisVertical,
        tooltip: isProject ? 'Project options' : 'Workgroup options',
        onPressed: () => menu.isOpen ? menu.close() : menu.open(),
      ),
    );
  }

  Future<void> _reviewDelivery(
    SuperTabMessage message,
    Map<String, dynamic> delivery,
  ) async {
    final c = this.c;
    final agent = c.snapshot?.agent(delivery['agentId'] as String);
    final resolution = await showAppDialog<String>(
      context: context,
      builder: (context) => ListenableBuilder(
        listenable: c,
        builder: (context, _) => !c.canWrite
            ? AlertDialog(
                content: const Text(
                  'This delivery is no longer available to change.',
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Close'),
                  ),
                ],
              )
            : AlertDialog(
                title: DesktopDialogHeader(
                  title:
                      'Check delivery to ${agent == null ? 'agent' : _agentName(agent)}',
                  padding: EdgeInsets.zero,
                  onClose: () => Navigator.pop(context),
                ),
                content: SizedBox(
                  width: 440,
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (agent != null) ...[
                          TextButton(
                            onPressed: () => Navigator.pop(context, 'open'),
                            child: const Text('Open terminal'),
                          ),
                          const SizedBox(height: 16),
                        ],
                        const Text(
                          'This instruction may already have reached the terminal. Inspect it before sending again.',
                        ),
                        const SizedBox(height: 16),
                        SelectableText(message.text),
                      ],
                    ),
                  ),
                ),
                actions: [
                  Wrap(
                    spacing: DesktopChrome.controlGap,
                    runSpacing: DesktopChrome.controlGap,
                    alignment: WrapAlignment.end,
                    children: [
                      TextButton(
                        onPressed: () => Navigator.pop(context, 'cancel'),
                        child: const Text('Dismiss warning'),
                      ),
                      TextButton(
                        onPressed: () => Navigator.pop(context, 'received'),
                        child: const Text('Already received'),
                      ),
                      FilledButton(
                        onPressed: () => Navigator.pop(context, 'resend'),
                        child: const Text('Send again'),
                      ),
                    ],
                  ),
                ],
              ),
      ),
    );
    if (!mounted ||
        widget.controller != c ||
        resolution == null ||
        !c.canWrite) {
      return;
    }
    if (resolution == 'open') {
      if (agent != null) {
        c.select(message.conversationId);
        widget.onOpenTerminal(agent);
      }
      return;
    }
    await c.command({
      'type': 'delivery.resolve',
      'deliveryId': delivery['id'],
      'resolution': resolution,
    });
  }

  Widget _message(
    SuperTabMessage message,
    bool grouped,
    Map<String, SuperTabMessage> byId,
  ) {
    final route = message.route;
    if (route != null) {
      return SuperTabRouteRow(
        key: ValueKey('super-message-${message.id}'),
        message: message,
        route: route,
        controller: c,
      );
    }
    final agent = message.fromAgent
        ? c.snapshot?.agent(message.authorId)
        : null;
    final reply = byId[message.replyTo];
    return SuperTabMessageRow(
      key: ValueKey('super-message-${message.id}'),
      message: message,
      author: _shownAuthor(c, message),
      references: {
        for (final g in c.snapshot?.conversations ?? <SuperTabConversation>[])
          if (g.number != null) g.number!: g.id,
      },
      onOpenGroup: (id) {
        setState(() => _showPullRequests = false);
        c.select(id);
        c.selectTerminal(id, null);
      },
      agent: agent,
      onOpenAgent: agent == null ? null : () => _openAgent(agent),
      machineName: agent == null ? null : widget.machineName(agent.machineId),
      grouped: grouped,
      reply: reply,
      replyAuthor: reply == null ? null : _shownAuthor(c, reply),
      onReply: c.canWrite && c.selected?.archived == false
          ? () {
              setState(() => _replies[c.selectedId] = message);
              _focus.requestFocus();
            }
          : null,
      onReturnToComposer: _focus.requestFocus,
      receipts: [
        if (message.source['truncated'] == true ||
            message.source['interrupted'] == true)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              message.source['truncated'] == true
                  ? 'Excerpt · open the terminal for the full response'
                  : 'Response interrupted',
              style: DesktopChrome.metadata(),
            ),
          ),
        if (message.queued)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('Queued', style: DesktopChrome.metadata()),
          ),
        for (final delivery in message.deliveries.where(
          (d) => d['status'] == 'uncertain',
        ))
          TextButton(
            onPressed: c.canWrite && delivery['id'] is String
                ? () => _reviewDelivery(message, delivery)
                : null,
            child: Text(
              'Check delivery to ${c.snapshot?.agentName(delivery['agentId'] as String, fallback: 'agent') ?? 'agent'}',
            ),
          ),
      ],
    );
  }

  Widget _date(DateTime time) => Padding(
    padding: const EdgeInsets.fromLTRB(24, 20, 24, 4),
    child: Row(
      children: [
        Expanded(child: Divider(color: DesktopChrome.rim)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            MaterialLocalizations.of(context).formatMediumDate(time.toLocal()),
            style: DesktopChrome.metadata(),
          ),
        ),
        Expanded(child: Divider(color: DesktopChrome.rim)),
      ],
    ),
  );

  Widget _conversation(bool narrow) {
    final group = c.selected;
    final messages = c.messages(c.selectedId);
    final entries = superTabTranscriptEntries(messages);
    final byId = {for (final message in messages) message.id: message};
    final grouped = SuperTabMessageRow.consecutiveUpdates(messages);
    final newAfter = _newAfter[c.selectedId];
    final newCount = newAfter == null
        ? 0
        : messages.where((message) => message.sequence > newAfter).length;
    final reply = _replies[c.selectedId];
    final mentions = _mentionChoices;
    return Column(
      children: [
        if (c.error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
            child: Row(
              children: [
                Expanded(child: Text(c.error!, style: DesktopChrome.control())),
                if (!c.accessRevoked)
                  TextButton(
                    onPressed: () => unawaited(c.refresh()),
                    child: const Text('Retry'),
                  ),
              ],
            ),
          ),
        Expanded(
          child: c.loading
              ? const Center(child: CircularProgressIndicator())
              : messages.isEmpty
              ? Center(
                  child: Text(
                    c.accessRevoked
                        ? 'Conversation unavailable.'
                        : group == null
                        ? 'Loading conversation…'
                        : group.id == 'lead'
                        ? 'Discuss the plan with your lead.'
                        : 'Start the conversation.',
                    style: DesktopChrome.text(color: DesktopChrome.muted),
                  ),
                )
              : Stack(
                  children: [
                    NotificationListener<ScrollNotification>(
                      onNotification: (event) {
                        if (event.depth != 0) return false;
                        if (event is ScrollStartNotification &&
                            event.dragDetails != null) {
                          _scrollRequest++;
                          _jumpingToEnd = false;
                        }
                        if (_jumpingToEnd) return false;
                        final id = c.selectedId;
                        final atEnd = event.metrics.extentAfter < 40;
                        _following[id] = atEnd;
                        if (atEnd) {
                          final sequence = messages.lastOrNull?.sequence ?? 0;
                          WidgetsBinding.instance.addPostFrameCallback((_) {
                            if (mounted && c.selectedId == id) {
                              _readToEnd(id, sequence);
                            }
                          });
                        }
                        return false;
                      },
                      child: SelectionArea(
                        child: ListView.builder(
                          controller: _scroll[c.selectedId],
                          key: PageStorageKey(
                            'super-messages-${c.tabId}-${c.selectedId}',
                          ),
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          itemCount: entries.length + 1,
                          itemBuilder: (context, index) {
                            if (index == 0) {
                              return c.hasOlder(c.selectedId)
                                  ? Align(
                                      child: TextButton(
                                        onPressed: () => unawaited(_earlier()),
                                        child: const Text('Earlier messages'),
                                      ),
                                    )
                                  : const SizedBox.shrink();
                            }
                            final entry = entries[index - 1];
                            final message = entry.message;
                            final agent = message.fromAgent
                                ? c.snapshot?.agent(message.authorId)
                                : null;
                            final previous = index > 1
                                ? entries[index - 2].message
                                : null;
                            final time = message.createdAt;
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                if (time != null &&
                                    !DateUtils.isSameDay(
                                      time.toLocal(),
                                      previous?.createdAt?.toLocal(),
                                    ))
                                  _date(time),
                                if (entry.interruptions > 0)
                                  SuperTabRecordingNotice(
                                    key: ValueKey(
                                      'super-message-${message.id}',
                                    ),
                                    author: _shownAuthor(c, message),
                                    count: entry.interruptions,
                                    onOpenTerminal: agent == null
                                        ? null
                                        : () => _openAgent(agent),
                                  )
                                else
                                  _message(
                                    message,
                                    grouped.contains(message.id),
                                    byId,
                                  ),
                              ],
                            );
                          },
                        ),
                      ),
                    ),
                    if (newCount > 0)
                      Positioned(
                        bottom: 12,
                        left: 20,
                        right: 20,
                        child: Center(
                          child: FilledButton.icon(
                            key: const ValueKey('super-new-messages'),
                            onPressed: _jumpToLatest,
                            icon: const Icon(AppIcons.chevronDown, size: 16),
                            label: Text(
                              '$newCount new ${newCount == 1 ? 'message' : 'messages'}',
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
        ),
        if (c.operationError != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    c.operationError!,
                    style: DesktopChrome.control(),
                  ),
                ),
                if (c.hasPendingAction)
                  TextButton(
                    onPressed: c.saving ? null : () => unawaited(c.retry()),
                    child: const Text('Retry'),
                  ),
              ],
            ),
          ),
        if (reply != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 8, 16, 0),
            child: Row(
              children: [
                Expanded(
                  child: SuperTabReplyPreview(
                    author: 'Replying to ${_authorName(reply)}',
                    text: reply.text,
                  ),
                ),
                AppIconButton(
                  icon: AppIcons.close,
                  tooltip: 'Cancel reply',
                  onPressed: () =>
                      setState(() => _replies.remove(c.selectedId)),
                ),
              ],
            ),
          ),
        if (group != null)
          for (final agent in _needsHuman(group))
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 6, 24, 0),
              child: ListTile(
                key: ValueKey('super-needs-human-${agent.id}'),
                dense: true,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                tileColor: grid.AppPalette.warn.withValues(alpha: .08),
                leading: Icon(
                  AppIcons.messageCircleQuestionMark,
                  color: grid.AppPalette.warn,
                  size: 18,
                ),
                title: Text(
                  '${_agentName(agent)} needs you',
                  style: DesktopChrome.control(medium: true),
                ),
                trailing: const Icon(AppIcons.arrowRight, size: 16),
                onTap: () => _openAgent(agent),
              ),
            ),
        if (mentions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Material(
              color: DesktopChrome.surface,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (var i = 0; i < mentions.length; i++)
                    ListTile(
                      dense: true,
                      selected:
                          i == _mentionIndex.clamp(0, mentions.length - 1),
                      title: Text(_agentName(mentions[i])),
                      subtitle: Text(
                        '${mentions[i].engine} · ${widget.machineName(mentions[i].machineId)}',
                      ),
                      onTap: () => _chooseMention(mentions[i]),
                    ),
                ],
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
          child: Focus(
            onKeyEvent: (node, event) {
              final keys = HardwareKeyboard.instance;
              final composing = _composer.value.composing;
              if (_focus.hasFocus &&
                  event is KeyDownEvent &&
                  mentions.isNotEmpty &&
                  !keys.isControlPressed &&
                  !keys.isMetaPressed &&
                  !keys.isAltPressed &&
                  !keys.isShiftPressed &&
                  !(composing.isValid && !composing.isCollapsed)) {
                final key = event.logicalKey;
                if (key == LogicalKeyboardKey.arrowDown ||
                    key == LogicalKeyboardKey.arrowUp) {
                  setState(
                    () => _mentionIndex =
                        (_mentionIndex +
                            (key == LogicalKeyboardKey.arrowDown ? 1 : -1)) %
                        mentions.length,
                  );
                  return KeyEventResult.handled;
                }
                if (key == LogicalKeyboardKey.tab ||
                    key == LogicalKeyboardKey.enter) {
                  _chooseMention(
                    mentions[_mentionIndex.clamp(0, mentions.length - 1)],
                  );
                  return KeyEventResult.handled;
                }
                if (key == LogicalKeyboardKey.escape) {
                  setState(
                    () => _dismissedMention = _composer.text.substring(
                      0,
                      _composer.selection.baseOffset,
                    ),
                  );
                  return KeyEventResult.handled;
                }
              }
              if (_focus.hasFocus &&
                  event is KeyDownEvent &&
                  event.logicalKey == LogicalKeyboardKey.enter &&
                  !keys.isShiftPressed &&
                  !keys.isControlPressed &&
                  !keys.isMetaPressed &&
                  !keys.isAltPressed &&
                  !(composing.isValid && !composing.isCollapsed)) {
                unawaited(_send());
                return KeyEventResult.handled;
              }
              return KeyEventResult.ignored;
            },
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: DesktopChrome.field,
                borderRadius: BorderRadius.circular(
                  DesktopChrome.controlRadius,
                ),
                border: Border.all(color: DesktopChrome.rim),
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: TextField(
                        key: const ValueKey('super-message-composer'),
                        controller: _composer,
                        focusNode: _focus,
                        autofocus: !_terminalsVisible,
                        enabled: c.canWrite && group != null && !group.archived,
                        minLines: 1,
                        maxLines: MediaQuery.sizeOf(context).height < 600
                            ? 3
                            : 8,
                        maxLength: 32000,
                        keyboardType: TextInputType.multiline,
                        style: DesktopChrome.text(),
                        decoration: InputDecoration(
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            vertical: 6,
                          ),
                          hintText: group == null
                              ? 'Loading conversation…'
                              : c.canWrite
                              ? 'Message ${group.title}'
                              : 'Read-only conversation',
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          filled: false,
                          counterText: '',
                        ),
                        onChanged: (text) {
                          c.setDraft(c.selectedId, text);
                          setState(() {
                            _mentionIndex = 0;
                            _dismissedMention = null;
                          });
                        },
                      ),
                    ),
                    ValueListenableBuilder(
                      valueListenable: _composer,
                      builder: (context, value, _) => AppIconButton(
                        icon: AppIcons.arrowUp,
                        tooltip: 'Send message',
                        color: DesktopChrome.accent,
                        onPressed:
                            c.canWrite &&
                                group != null &&
                                !group.archived &&
                                !c.saving &&
                                !c.hasPendingAction &&
                                value.text.trim().isNotEmpty
                            ? () => unawaited(_send())
                            : null,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      grid.AppTheme.watch(context);
      final terminal = widget.terminal;
      final narrow =
          constraints.maxWidth < MediaQuery.textScalerOf(context).scale(720);
      final showRoster =
          constraints.maxWidth >= MediaQuery.textScalerOf(context).scale(1080);
      final roster = SuperTabRoster(
        controller: c,
        app: widget.app,
        onInvite: widget.onInvite,
        onOpenAgent: (agent) {
          setState(() {
            _showPullRequests = false;
            _rosterOpen = false;
          });
          (widget.onChooseAgentTerminal ?? widget.onOpenTerminal)(agent);
        },
        onAddAgent: (group) {
          setState(() => _rosterOpen = false);
          widget.onAddAgent(group);
        },
      );
      return Stack(
        children: [
          ExcludeFocus(
            excluding: (narrow && _sidebarOpen) || (!showRoster && _rosterOpen),
            child: Row(
              children: [
                if (!narrow) ...[
                  SizedBox(width: 220, child: _sidebar()),
                  VerticalDivider(width: 1, color: DesktopChrome.rim),
                ],
                Expanded(
                  child: Column(
                    children: [
                      _header(c.selected, narrow, showRoster),
                      Expanded(
                        child: IndexedStack(
                          index: _terminalsVisible
                              ? 1
                              : _showPullRequests
                              ? 2
                              : 0,
                          children: [
                            _conversation(narrow),
                            terminal ?? const SizedBox.shrink(),
                            _showPullRequests
                                ? SuperTabPullRequests(
                                    controller: c,
                                    app: widget.app,
                                  )
                                : const SizedBox.shrink(),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                if (showRoster) ...[
                  VerticalDivider(width: 1, color: DesktopChrome.rim),
                  SizedBox(width: 288, child: roster),
                ],
              ],
            ),
          ),
          if (!showRoster && _rosterOpen)
            Positioned.fill(
              child: BlockSemantics(
                child: FocusScope(
                  autofocus: true,
                  onKeyEvent: (_, event) {
                    if (event is KeyDownEvent &&
                        event.logicalKey == LogicalKeyboardKey.escape) {
                      _closeRoster();
                      return KeyEventResult.handled;
                    }
                    return KeyEventResult.ignored;
                  },
                  child: GestureDetector(
                    onTap: _closeRoster,
                    child: ColoredBox(
                      color: grid.AppDesktop.veil(Theme.of(context).brightness),
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: SizedBox(width: 288, child: roster),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (narrow && _sidebarOpen)
            Positioned.fill(
              child: BlockSemantics(
                child: FocusScope(
                  autofocus: true,
                  onKeyEvent: (_, event) {
                    if (event is KeyDownEvent &&
                        event.logicalKey == LogicalKeyboardKey.escape) {
                      _closeSidebar();
                      return KeyEventResult.handled;
                    }
                    return KeyEventResult.ignored;
                  },
                  child: GestureDetector(
                    onTap: _closeSidebar,
                    child: ColoredBox(
                      color: grid.AppDesktop.veil(Theme.of(context).brightness),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: SizedBox(
                          width: 240,
                          child: Material(
                            color: DesktopChrome.surface,
                            elevation: 8,
                            child: _sidebar(),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );
}
