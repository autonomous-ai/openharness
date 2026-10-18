import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import 'controller.dart';
import 'model.dart';
import 'message_text.dart';
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
  final _counts = <String, int>{};
  final _replies = <String, SuperTabMessage>{};
  String? _selected;
  bool _sidebarOpen = false;
  final _loadingOlder = <String>{};
  int _mentionIndex = 0;
  String? _dismissedMention;
  SuperTabController get c => widget.controller;

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
      _counts.clear();
      _replies.clear();
      _selected = null;
      _changed();
    }
  }

  void _changed() {
    if (!mounted) return;
    final id = c.selectedId;
    final firstView = !_scroll.containsKey(id);
    final scroll = _scroll.putIfAbsent(id, ScrollController.new);
    final atEnd =
        !scroll.hasClients ||
        scroll.position.maxScrollExtent - scroll.offset < 40;
    final count = c.messages(id).length;
    final grew = count > (_counts[id] ?? 0) && !_loadingOlder.contains(id);
    _counts[id] = count;
    final draft = c.draft(id);
    if (_selected != id || _composer.text != draft) {
      _composer.value = TextEditingValue(
        text: draft,
        selection: TextSelection.collapsed(offset: draft.length),
      );
    }
    _selected = id;
    setState(() {});
    if (firstView || (grew && atEnd)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || c.selectedId != id || !scroll.hasClients) return;
        scroll.jumpTo(scroll.position.maxScrollExtent);
        c.markRead(id);
      });
    }
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
                  '${agent.name} ${agent.engine}'.toLowerCase().contains(
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
    final token = '@${agent.name}';
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
    var name = '';
    String? error;
    bool busy = false;
    final id = await showDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(
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
                      onChanged: (value) => name = value,
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
                  onPressed: busy ? null : () => unawaited(create()),
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
    );
    if (!mounted || id == null) return;
    c.select(id);
    setState(() => _sidebarOpen = false);
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
    await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
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
    );
  }

  Future<void> _participants(SuperTabConversation group) async {
    var query = '';
    var handedOff = false;
    await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
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
                      '${a.name} ${a.engine} ${widget.machineName(a.machineId)}'
                          .toLowerCase()
                          .contains(query),
                )
                .toList();
            final people = state.people
                .where((p) => p.email.toLowerCase().contains(query))
                .toList();
            return Dialog(
              child: SizedBox(
                width: 400,
                height: 460,
                child: Padding(
                  padding: const EdgeInsets.all(16),
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
                        onChanged: (value) =>
                            update(() => query = value.trim().toLowerCase()),
                      ),
                      const SizedBox(height: 12),
                      Expanded(
                        child: ListView(
                          children: [
                            for (final agent in agents)
                              ListTile(
                                contentPadding: EdgeInsets.zero,
                                title: Text(
                                  agent.name,
                                  style: DesktopChrome.control(medium: true),
                                ),
                                subtitle: Text(
                                  '${engineIdentity(agent.engine).label} · ${widget.machineName(agent.machineId)}',
                                  style: DesktopChrome.metadata(),
                                ),
                                trailing: TextButton(
                                  onPressed: () {
                                    Navigator.of(context).pop();
                                    handedOff = true;
                                    widget.onOpenTerminal(agent);
                                  },
                                  child: const Text('Open terminal'),
                                ),
                              ),
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
                              Navigator.of(context).pop();
                              handedOff = true;
                              widget.onAddAgent(currentGroup);
                            },
                            child: const Text('Add agent'),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
    if (mounted && !handedOff) _focus.requestFocus();
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
                          borderRadius: BorderRadius.circular(6),
                        ),
                        selected: c.selectedId == group.id,
                        selectedTileColor: DesktopChrome.selection,
                        title: Text(
                          group.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(medium: c.unread(group)),
                        ),
                        trailing: c.unread(group)
                            ? Semantics(
                                label: 'Unread messages',
                                child: Container(
                                  width: 6,
                                  height: 6,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: DesktopChrome.accent,
                                  ),
                                ),
                              )
                            : null,
                        onTap: () {
                          c.select(group.id);
                          setState(() => _sidebarOpen = false);
                          _focus.requestFocus();
                        },
                      ),
                    ),
                  ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
          child: Row(
            children: [
              Expanded(
                child: TextButton(
                  onPressed:
                      c.canWrite &&
                          !c.hasPendingAction &&
                          c.snapshot?.paused != true
                      ? () => unawaited(_newGroup())
                      : null,
                  child: Text(
                    'New group',
                    style: DesktopChrome.control(),
                    maxLines: 1,
                  ),
                ),
              ),
              Expanded(
                child: TextButton(
                  onPressed: c.snapshot != null ? widget.onInvite : null,
                  child: Text(
                    c.isOwner ? 'Invite' : 'People',
                    style: DesktopChrome.control(),
                    maxLines: 1,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _header(SuperTabConversation? group, bool narrow) => Container(
    height: 52,
    padding: const EdgeInsets.symmetric(horizontal: 16),
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
          child: Text(
            group?.title ?? 'Loading conversation…',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.text(medium: true),
          ),
        ),
        if (group != null)
          TextButton(
            onPressed: () => unawaited(_participants(group)),
            child: Text(
              '${group.agentIds.length} ${group.agentIds.length == 1 ? 'agent' : 'agents'} · ${c.snapshot?.people.length ?? 0} ${(c.snapshot?.people.length ?? 0) == 1 ? 'person' : 'people'}',
              style: DesktopChrome.metadata(),
            ),
          ),
        if (group != null)
          PopupMenuButton<String>(
            tooltip: 'Conversation options',
            icon: const Icon(AppIcons.ellipsis, size: 18),
            onSelected: (action) => unawaited(_groupAction(action, group)),
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'work', child: Text('Work details')),
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
    ),
  );

  Widget _message(SuperTabMessage message) => Padding(
    key: ValueKey('super-message-${message.id}'),
    padding: const EdgeInsets.fromLTRB(24, 14, 24, 14),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                message.authorId == c.accountId ? 'You' : message.authorName,
                style: DesktopChrome.control(medium: true),
              ),
            ),
            if (message.createdAt case final time?)
              Text(
                TimeOfDay.fromDateTime(time.toLocal()).format(context),
                style: DesktopChrome.metadata(),
              ),
            if (c.canWrite)
              TextButton(
                onPressed: () {
                  setState(() => _replies[c.selectedId] = message);
                  _focus.requestFocus();
                },
                child: const Text('Reply'),
              ),
          ],
        ),
        const SizedBox(height: 4),
        SuperTabMessageText(message.text),
        if (message.queued || message.uncertain)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              message.uncertain ? 'Delivery needs to be checked.' : 'Queued',
              style: DesktopChrome.metadata(),
            ),
          ),
      ],
    ),
  );

  Widget _conversation(bool narrow) {
    final group = c.selected;
    final messages = c.messages(c.selectedId);
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
              : NotificationListener<ScrollNotification>(
                  onNotification: (event) {
                    if (event.metrics.extentAfter < 40) {
                      final id = c.selectedId;
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        if (mounted && c.selectedId == id) c.markRead(id);
                      });
                    }
                    return false;
                  },
                  child: ListView(
                    controller: _scroll[c.selectedId],
                    key: PageStorageKey(
                      'super-messages-${c.tabId}-${c.selectedId}',
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    children: [
                      if (c.hasOlder(c.selectedId))
                        Align(
                          child: TextButton(
                            onPressed: () => unawaited(_earlier()),
                            child: const Text('Earlier messages'),
                          ),
                        ),
                      for (final message in messages) _message(message),
                    ],
                  ),
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
                  child: Text(
                    'Replying to ${reply.authorName}',
                    style: DesktopChrome.metadata(),
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
                      title: Text(mentions[i].name),
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
                borderRadius: BorderRadius.circular(12),
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
                        enabled: c.canWrite && group != null && !group.archived,
                        minLines: 1,
                        maxLines: 8,
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
      final narrow = constraints.maxWidth < 640;
      final terminal = widget.terminal;
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
          Row(
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
          if (narrow && _sidebarOpen)
            Positioned.fill(
              child: GestureDetector(
                onTap: () => setState(() => _sidebarOpen = false),
                child: ColoredBox(
                  color: Colors.black26,
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
        ],
      );
    },
  );
}
