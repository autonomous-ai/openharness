import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'message_row.dart';
import 'route_row.dart';
import 'work_details.dart';

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
  });
  final SuperTabController controller;
  final VoidCallback onInvite;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final ValueChanged<SuperTabAgent> onOpenTerminal;
  final String Function(String machineId) machineName;
  final Widget? terminal;
  final VoidCallback? onCloseTerminal;

  @override
  State<SuperTabView> createState() => _SuperTabViewState();
}

class _SuperTabViewState extends State<SuperTabView> {
  final _composer = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Super Tab message');
  final _scroll = <String, ScrollController>{};
  final _latest = <String, int>{};
  final _following = <String, bool>{};
  final _newAfter = <String, int>{};
  final _replies = <String, SuperTabMessage>{};
  String? _selected;
  int _scrollRequest = 0;
  bool _jumpingToEnd = false;
  bool _sidebarOpen = false;
  final _loadingOlder = <String>{};
  int _mentionIndex = 0;
  String? _dismissedMention;
  SuperTabController get c => widget.controller;

  String _agentName(SuperTabAgent agent) =>
      c.snapshot?.agentName(agent.id, fallback: agent.name) ?? agent.name;

  String _authorName(SuperTabMessage message) =>
      c.snapshot?.authorName(message) ?? message.authorName;

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
    c.markRead(id, through: sequence);
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

  Future<void> _newGroup() async {
    final c = this.c;
    var name = '';
    String? error;
    bool busy = false;
    final id = await showAppDialog<String>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        child: StatefulBuilder(
          builder: (context, update) {
            Future<void> create() async {
              if (busy || name.trim().isEmpty) return;
              update(() {
                busy = true;
                error = null;
              });
              final answer = c.hasPendingAction
                  ? await c.retry()
                  : await c.command({
                      'type': 'conversation.create',
                      'title': name.trim(),
                      'brief': '',
                      'checks': <dynamic>[],
                    });
              if (!context.mounted) return;
              if (answer?['conversationId'] case final String id) {
                Navigator.of(context).pop(id);
              } else {
                update(() {
                  busy = false;
                  error = c.operationError ?? 'Could not create the group.';
                });
              }
            }

            return PopScope(
              canPop: !busy,
              child: AlertDialog(
                title: const Text('New group'),
                content: SizedBox(
                  width: 340,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      TextField(
                        onChanged: (value) => update(() => name = value),
                        autofocus: true,
                        enabled: !busy && !c.hasPendingAction,
                        maxLength: 160,
                        decoration: const InputDecoration(
                          labelText: 'Name',
                          hintText: 'Offline editing',
                          counterText: '',
                        ),
                        onSubmitted: (_) => unawaited(create()),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'A shared conversation with your lead.',
                        style: DesktopChrome.metadata(),
                      ),
                      if (error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 12),
                          child: Text(error!, style: DesktopChrome.control()),
                        ),
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                    onPressed: busy ? null : () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                  FilledButton(
                    onPressed: busy || name.trim().isEmpty
                        ? null
                        : () => unawaited(create()),
                    child: Text(
                      busy
                          ? 'Creating…'
                          : c.hasPendingAction
                          ? 'Retry'
                          : 'Create',
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
    if (!mounted || widget.controller != c || id == null) return;
    c.select(id);
    _closeSidebar();
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

  Future<void> _participants(SuperTabConversation group) async {
    final c = this.c;
    var query = '';
    var handedOff = false;
    final addition = await showAppDialog<SuperTabConversation>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        requireWrite: false,
        child: StatefulBuilder(
          builder: (context, update) => ListenableBuilder(
            listenable: c,
            builder: (context, _) {
              final state = c.snapshot;
              if (state == null) {
                return AlertDialog(
                  content: const Text('This conversation is unavailable.'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('Close'),
                    ),
                  ],
                );
              }
              final currentGroup = state.conversation(group.id) ?? group;
              final agents = state.agents
                  .where(
                    (a) =>
                        currentGroup.agentIds.contains(a.id) &&
                        '${_agentName(a)} ${a.engine} ${widget.machineName(a.machineId)}'
                            .toLowerCase()
                            .contains(query),
                  )
                  .toList();
              final people = state.people
                  .where((p) => p.email.toLowerCase().contains(query))
                  .toList();
              return Dialog(
                backgroundColor: Colors.transparent,
                elevation: 0,
                shape: const RoundedRectangleBorder(),
                child: DesktopDialogSurface(
                  child: SizedBox(
                    width: 400,
                    height: 460,
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Participants',
                                  style: DesktopChrome.heading(),
                                ),
                              ),
                              AppIconButton(
                                icon: AppIcons.close,
                                tooltip: 'Close participants',
                                onPressed: () => Navigator.of(context).pop(),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          TextField(
                            autofocus: true,
                            decoration: const InputDecoration(
                              hintText: 'Find a person or agent',
                            ),
                            onChanged: (value) => update(
                              () => query = value.trim().toLowerCase(),
                            ),
                          ),
                          const SizedBox(height: 12),
                          Expanded(
                            child: ListView(
                              children: [
                                for (final agent in agents)
                                  _participantAgent(agent, () {
                                    Navigator.of(context).pop();
                                    handedOff = true;
                                    widget.onOpenTerminal(agent);
                                  }),
                                for (final person in people)
                                  ListTile(
                                    contentPadding: EdgeInsets.zero,
                                    title: Text(
                                      person.email,
                                      style: DesktopChrome.control(),
                                    ),
                                    subtitle: Text(
                                      person.role == 'owner'
                                          ? 'Owner'
                                          : person.role == 'viewer'
                                          ? 'Viewer'
                                          : 'Collaborator',
                                      style: DesktopChrome.metadata(),
                                    ),
                                  ),
                                if (agents.isEmpty && people.isEmpty)
                                  const Padding(
                                    padding: EdgeInsets.symmetric(vertical: 24),
                                    child: Text('No matches.'),
                                  ),
                              ],
                            ),
                          ),
                          if (c.canWrite)
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: () {
                                  Navigator.of(context).pop(currentGroup);
                                  handedOff = true;
                                },
                                child: const Text('Add agent'),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
    if (addition != null) {
      // The workspace enables its picker when the modal route is gone. Wait
      // for that dependency update before handing focus to the next surface.
      await WidgetsBinding.instance.endOfFrame;
      if (mounted &&
          identical(c, this.c) &&
          c.canWrite &&
          c.snapshot?.conversation(addition.id) != null) {
        widget.onAddAgent(addition);
      }
    }
    if (mounted && !handedOff) _focus.requestFocus();
  }

  Widget _participantAgent(SuperTabAgent agent, VoidCallback open) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: LayoutBuilder(
      builder: (context, constraints) {
        final identity = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_agentName(agent), style: DesktopChrome.control(medium: true)),
            const SizedBox(height: 4),
            Text(
              '${engineIdentity(agent.engine).label} · ${widget.machineName(agent.machineId)}',
              style: DesktopChrome.metadata(),
            ),
          ],
        );
        final action = TextButton(
          onPressed: open,
          child: const Text('Open terminal'),
        );
        if (MediaQuery.textScalerOf(context).scale(13) > 18 ||
            constraints.maxWidth < 320) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [identity, const SizedBox(height: 8), action],
          );
        }
        return Row(
          children: [
            Expanded(child: identity),
            const SizedBox(width: 12),
            action,
          ],
        );
      },
    ),
  );

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
                                        group.title,
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

  Widget _sidebar() => Material(
    color: DesktopChrome.surface,
    child: Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
            children: [
              for (final group
                  in c.snapshot?.conversations ?? <SuperTabConversation>[])
                if (!group.archived)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Semantics(
                      selected: c.selectedId == group.id,
                      child: ListTile(
                        key: ValueKey('super-group-${group.id}'),
                        dense: true,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(
                            DesktopChrome.rowRadius,
                          ),
                        ),
                        selected: c.selectedId == group.id,
                        selectedTileColor: DesktopChrome.activeSelection,
                        title: Text(
                          group.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(
                            medium: c.unread(group),
                            color: c.selectedId == group.id
                                ? DesktopChrome.onSelection
                                : null,
                          ),
                        ),
                        trailing: c.unread(group)
                            ? Semantics(
                                label: 'Unread messages',
                                child: Container(
                                  width: 6,
                                  height: 6,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: c.selectedId == group.id
                                        ? DesktopChrome.onSelection
                                        : DesktopChrome.accent,
                                  ),
                                ),
                              )
                            : null,
                        onTap: () {
                          c.select(group.id);
                          _closeSidebar();
                        },
                      ),
                    ),
                  ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
          child: Wrap(
            spacing: DesktopChrome.controlGap,
            runSpacing: DesktopChrome.controlGap,
            children: [
              TextButton(
                onPressed:
                    c.canWrite &&
                        !c.hasPendingAction &&
                        c.snapshot?.paused != true
                    ? () => unawaited(_newGroup())
                    : null,
                child: const Text('New group'),
              ),
              TextButton(
                onPressed: c.snapshot != null
                    ? () {
                        _closeSidebar();
                        widget.onInvite();
                      }
                    : null,
                child: Text(c.isOwner ? 'Invite' : 'People'),
              ),
              TextButton(
                onPressed: c.snapshot != null
                    ? () {
                        _closeSidebar();
                        unawaited(showSuperTabRouting(context, c));
                      }
                    : null,
                child: const Text('Routing'),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _header(SuperTabConversation? group, bool narrow) => Container(
    constraints: const BoxConstraints(minHeight: 52),
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
    ),
    child: LayoutBuilder(
      builder: (context, constraints) {
        final people = c.snapshot?.people.length ?? 0;
        final agents = group?.agentIds.length ?? 0;
        final participants =
            '$agents ${agents == 1 ? 'agent' : 'agents'} · $people ${people == 1 ? 'person' : 'people'}';
        final compact =
            constraints.maxWidth < MediaQuery.textScalerOf(context).scale(520);
        return Row(
          children: [
            if (narrow)
              AppIconButton(
                icon: AppIcons.columns2,
                tooltip: 'Conversations',
                onPressed: () => setState(() => _sidebarOpen = !_sidebarOpen),
              ),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    group?.title ?? 'Loading conversation…',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.text(medium: true),
                  ),
                  if (group?.assignment?['status'] == 'needs_human')
                    TextButton.icon(
                      onPressed: () => showSuperTabWork(context, c, group!.id),
                      style: TextButton.styleFrom(
                        foregroundColor: grid.AppPalette.warn,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 6,
                        ),
                        minimumSize: const Size(0, 32),
                      ),
                      icon: const Icon(
                        AppIcons.messageCircleQuestionMark,
                        size: 16,
                      ),
                      label: const Text(
                        'Needs a human',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
              ),
            ),
            if (group != null)
              Tooltip(
                message: participants,
                child: TextButton(
                  onPressed: () => unawaited(_participants(group)),
                  child: compact
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(AppIcons.users, size: 18),
                            const SizedBox(width: 6),
                            Text(
                              '${agents + people}',
                              semanticsLabel: participants,
                              style: DesktopChrome.metadata(),
                            ),
                          ],
                        )
                      : Text(participants, style: DesktopChrome.metadata()),
                ),
              ),
            if (group != null)
              PopupMenuButton<String>(
                tooltip: 'Conversation options',
                icon: const Icon(AppIcons.ellipsis, size: 18),
                onSelected: (action) => unawaited(_groupAction(action, group)),
                itemBuilder: (_) => [
                  const PopupMenuItem(
                    value: 'work',
                    child: Text('Work details'),
                  ),
                  if (c.snapshot?.conversations.any(
                        (group) => group.archived,
                      ) ==
                      true)
                    const PopupMenuItem(
                      value: 'archived',
                      child: Text('Archived conversations'),
                    ),
                  if (c.canWrite && !c.hasPendingAction && !c.saving) ...[
                    const PopupMenuItem(value: 'rename', child: Text('Rename')),
                    if (group.id != 'lead')
                      PopupMenuItem(
                        value: 'archive',
                        enabled:
                            group.assignment == null ||
                            const [
                              'done',
                              'stopped',
                            ].contains(group.assignment!['status']),
                        child: Text(
                          group.archived ? 'Reopen conversation' : 'Archive',
                        ),
                      ),
                  ],
                ],
              ),
          ],
        );
      },
    ),
  );

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
      author: message.authorId == c.accountId && !message.fromAgent
          ? 'You'
          : _authorName(message),
      agent: agent,
      machineName: agent == null ? null : widget.machineName(agent.machineId),
      grouped: grouped,
      reply: reply,
      replyAuthor: reply == null ? null : _authorName(reply),
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
    padding: const EdgeInsets.fromLTRB(20, 20, 20, 4),
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
        _header(group, narrow),
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
                      child: ListView.builder(
                        controller: _scroll[c.selectedId],
                        key: PageStorageKey(
                          'super-messages-${c.tabId}-${c.selectedId}',
                        ),
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        itemCount: messages.length + 1,
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
                          final message = messages[index - 1];
                          final previous = index > 1
                              ? messages[index - 2]
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
        if (mentions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
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
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
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
                padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: TextField(
                        key: const ValueKey('super-message-composer'),
                        controller: _composer,
                        focusNode: _focus,
                        autofocus: widget.terminal == null,
                        enabled: c.canWrite && group != null && !group.archived,
                        minLines: 1,
                        maxLines: MediaQuery.sizeOf(context).height < 600
                            ? 3
                            : 8,
                        maxLength: 32000,
                        keyboardType: TextInputType.multiline,
                        style: DesktopChrome.text(),
                        decoration: InputDecoration(
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
          constraints.maxWidth <
          MediaQuery.textScalerOf(context).scale(terminal == null ? 640 : 980);
      if (narrow && terminal != null) {
        return Column(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: widget.onCloseTerminal,
                icon: const Icon(AppIcons.arrowLeft, size: 16),
                label: const Text('Back to conversation'),
              ),
            ),
            Expanded(child: terminal),
          ],
        );
      }
      return Stack(
        children: [
          ExcludeFocus(
            excluding: narrow && _sidebarOpen,
            child: Row(
              children: [
                if (!narrow) ...[
                  SizedBox(width: 220, child: _sidebar()),
                  VerticalDivider(width: 1, color: DesktopChrome.rim),
                ],
                Expanded(child: _conversation(narrow)),
                if (terminal != null) ...[
                  VerticalDivider(width: 1, color: DesktopChrome.rim),
                  Expanded(child: terminal),
                ],
              ],
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
