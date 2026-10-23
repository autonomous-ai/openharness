import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/new_harness_attachments.dart';
import '../widgets/new_harness_paste.dart';
import '../state/app_state.dart';
import '../state/harness_attachments.dart';
import '../state/workspace_chrome.dart';
import 'roster.dart';
import 'recording_notice.dart';
import 'pull_requests.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'message_row.dart';
import 'message_receipt.dart';
import 'notifications.dart';
import 'route_row.dart';
import 'terminal_row.dart';
import 'work_details.dart';
import 'project_sidebar.dart';
import 'project_options.dart';
import 'pane_layout.dart';
import '../widgets/dial_list_scroll.dart';

typedef _ComposerChoice = ({String label, String? detail, VoidCallback choose});

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

class _SuperTabViewState extends State<SuperTabView>
    with WidgetsBindingObserver {
  final _composer = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Swarm message');
  final _pullRequestsFocus = FocusNode(debugLabel: 'Project pull requests');
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
  bool _showNotifications = false;
  // The message a tag opened, scrolled to once it is laid out.
  String? _target;
  final _targetKey = GlobalKey();
  bool _viewEnabled = true;
  bool _chatCovered = false;
  final _loadingOlder = <String>{};
  int _mentionIndex = 0;
  String? _dismissedMention;
  String? _completionPrefix;
  final _completionKeys = List.generate(6, (_) => GlobalKey());
  SuperTabController get c => widget.controller;

  /// A device with a Lead of this Swarm open scrolls the chat on screen.
  late final _dial = DialListScroll(() => _scroll[c.selectedId]);
  VoidCallback? _unregisterDial;
  void _registerDial() {
    _unregisterDial?.call();
    _unregisterDial = widget.app?.registerSuperTabScroll(c.tabId, _dial.handle);
  }

  bool get _devicesVisible =>
      c.devicesSelected &&
      widget.app?.devicesEnabled == true &&
      !c.accessRevoked;

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
    WidgetsBinding.instance.addObserver(this);
    _composer.addListener(_composerMoved);
    c.addListener(_changed);
    _registerDial();
    _changed();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _viewEnabled =
        TickerMode.valuesOf(context).enabled &&
        ModalRoute.isCurrentOf(context) != false;
    _readVisibleTailAfterFrame();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _readVisibleTailAfterFrame();
  }

  @override
  void didUpdateWidget(SuperTabView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != c || oldWidget.app != widget.app) {
      _dial.cancel();
      _registerDial();
    }
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
    } else {
      // The cached transcript is laid out even while a terminal is in front.
      // Returning to Chat need not fetch or append a message to make it read.
      _readVisibleTailAfterFrame();
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
    } else if (atEnd) {
      _readVisibleTailAfterFrame();
    }
  }

  void _followEnd(String id) {
    final request = ++_scrollRequest;
    final sequence = _latest[id] ?? 0;
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
              _readToEnd(id, sequence);
            }
          }
        });
        WidgetsBinding.instance.scheduleFrame();
      });
      WidgetsBinding.instance.scheduleFrame();
    }

    advance(0);
  }

  bool get _chatIsVisible {
    if (!mounted ||
        !_viewEnabled ||
        _chatCovered ||
        c.accessRevoked ||
        _devicesVisible ||
        _terminalsVisible ||
        _showPullRequests ||
        _showNotifications) {
      return false;
    }
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (lifecycle != null && lifecycle != AppLifecycleState.resumed) {
      return false;
    }
    final app = widget.app;
    if (app != null &&
        (!app.inForeground ||
            app.currentUser?.id != c.accountId ||
            app.activeSwarm.superTabId != c.tabId)) {
      return false;
    }
    var hidden = false;
    context.visitAncestorElements((element) {
      if (element.widget case Offstage(offstage: true)) hidden = true;
      return !hidden;
    });
    return !hidden;
  }

  void _readVisibleTailAfterFrame() {
    final id = c.selectedId;
    final sequence = c.messages(id).lastOrNull?.sequence ?? 0;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_jumpingToEnd) _readToEnd(id, sequence);
    });
    // Widget updates already have a frame in progress. Reuse it so routine
    // polling does not request an otherwise unnecessary frame after each build.
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _readToEnd(String id, int sequence) {
    final scroll = _scroll[id];
    if (c.selectedId != id ||
        !_chatIsVisible ||
        scroll == null ||
        !scroll.hasClients ||
        scroll.position.extentAfter >= 40) {
      return;
    }
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
    WidgetsBinding.instance.removeObserver(this);
    c.removeListener(_changed);
    _unregisterDial?.call();
    _dial.cancel();
    _composer.dispose();
    _focus.dispose();
    _pullRequestsFocus.dispose();
    for (final scroll in _scroll.values) {
      scroll.dispose();
    }
    super.dispose();
  }

  HarnessAttachments get _files => c.attachments(c.selectedId);

  Future<void> _send() async {
    final choices = _completionChoices;
    if (choices.isNotEmpty) {
      choices[_mentionIndex.clamp(0, choices.length - 1)].choose();
      return;
    }
    if (!c.canWrite ||
        c.selected == null ||
        c.selected!.archived ||
        c.saving ||
        c.uploading ||
        c.hasPendingAction ||
        (_composer.text.trim().isEmpty && _files.isEmpty)) {
      return;
    }
    final id = c.selectedId;
    final result = await c.send(replyTo: _replies[id]?.id);
    if (mounted && result != null) setState(() => _replies.remove(id));
  }

  void _composerMoved() {
    if (!mounted) return;
    final value = _composer.value;
    final prefix = value.selection.isValid
        ? value.text.substring(0, value.selection.baseOffset)
        : null;
    setState(() {
      if (_completionPrefix != prefix) _mentionIndex = 0;
      _completionPrefix = prefix;
    });
  }

  ({int start, int end, String query})? get _workgroupAtCursor {
    final value = _composer.value;
    if (!value.selection.isValid ||
        !value.selection.isCollapsed ||
        (value.composing.isValid && !value.composing.isCollapsed)) {
      return null;
    }
    final end = value.selection.baseOffset;
    final prefix = value.text.substring(0, end);
    if (prefix == _dismissedMention) return null;
    final match = RegExp(r'(?:^|[\s(])#([^\s#`()]*)$').firstMatch(prefix);
    if (match == null) return null;
    // A reference picker must not interrupt Markdown code or URL fragments.
    String? fence;
    for (final line in prefix.split('\n')) {
      final delimiter = RegExp(r'^ {0,3}(`{3,}|~{3,})').firstMatch(line)?[1];
      if (delimiter == null) continue;
      if (fence == null) {
        fence = delimiter;
      } else if (delimiter[0] == fence[0] && delimiter.length >= fence.length) {
        fence = null;
      }
    }
    if (fence != null) return null;
    int? ticks;
    for (final run in RegExp(
      r'(?<!\\)`+',
    ).allMatches(prefix.split('\n').last)) {
      if (ticks == null) {
        ticks = run[0]!.length;
      } else if (ticks == run[0]!.length) {
        ticks = null;
      }
    }
    if (ticks != null) return null;
    // When editing inside a reference, replace the unfinished token after the
    // caret too, while leaving sentence punctuation and following text intact.
    final continuation = RegExp(r'^[^\s#`()\[\]{},.!?;:]*')
        .firstMatch(value.text.substring(end))![0]!;
    return (
      start: prefix.lastIndexOf('#'),
      end: end + continuation.length,
      query: match[1]!.toLowerCase(),
    );
  }

  List<_ComposerChoice> get _completionChoices {
    if (!c.canWrite || c.selected?.archived != false) return const [];
    final reference = _workgroupAtCursor;
    final snapshot = c.snapshot;
    if (reference != null && snapshot != null) {
      final projectId = c.selected?.projectId;
      final groups = snapshot.conversations
          .where(
            (group) =>
                group.number != null &&
                !snapshot.isProjectLead(group.id) &&
                (group.number.toString().startsWith(reference.query) ||
                    group.title.toLowerCase().contains(reference.query)),
          )
          .toList();
      groups.sort((a, b) {
        final active = (a.archived ? 1 : 0).compareTo(b.archived ? 1 : 0);
        if (active != 0) return active;
        final project = (a.projectId == projectId ? 0 : 1).compareTo(
          b.projectId == projectId ? 0 : 1,
        );
        return project != 0 ? project : a.number!.compareTo(b.number!);
      });
      return groups.take(6).map((group) {
        final context = <String>[
          if (group.projectId != projectId)
            snapshot.projectFor(group.id)?.name ?? 'Project',
          if (group.archived) 'Archived',
        ];
        return (
          label: group.label,
          detail: context.isEmpty ? null : context.join(' — '),
          choose: () => _chooseWorkgroup(group),
        );
      }).toList();
    }
    return _mentionChoices
        .map(
          (agent) => (
            label: _agentName(agent),
            detail: '${agent.engine}  ${widget.machineName(agent.machineId)}',
            choose: () => _chooseMention(agent),
          ),
        )
        .toList();
  }

  void _chooseWorkgroup(SuperTabConversation group) {
    final at = _workgroupAtCursor;
    if (at == null || group.number == null) return;
    final suffix = _composer.text.substring(at.end);
    final boundary = suffix.startsWith(RegExp(r'[\s)\]}.,!?;:]'));
    final token = '#${group.number}${boundary ? '' : ' '}';
    final text = _composer.text.replaceRange(at.start, at.end, token);
    final caret = at.start + token.length;
    c.setDraft(c.selectedId, text);
    setState(() => _dismissedMention = text.substring(0, caret));
    _composer.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: caret),
    );
    _focus.requestFocus();
  }

  void _moveCompletion(int index) {
    setState(() => _mentionIndex = index);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final context = _completionKeys[index].currentContext;
      if (mounted && context != null) {
        Scrollable.ensureVisible(context, alignment: .5);
      }
    });
  }

  void _closeRoster() {
    setState(() => _rosterOpen = false);
    if (!_terminalsVisible && !_devicesVisible) _focus.requestFocus();
  }

  void _closeSidebar() {
    setState(() => _sidebarOpen = false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          !_sidebarOpen &&
          !_devicesVisible &&
          !_terminalsVisible &&
          !_showPullRequests) {
        _focus.requestFocus();
      }
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
    app: widget.app,
    onAddAgent: widget.onAddAgent,
    onNewProject: widget.onNewProject,
    devicesSelected: _devicesVisible,
    notificationsSelected: _notificationsVisible,
    onNotifications: () {
      _closeSidebar();
      setState(() {
        _showNotifications = true;
        _showPullRequests = false;
      });
      widget.onCloseTerminal?.call();
    },
    onOpenAgent: (agent) {
      _closeSidebar();
      setState(() {
        _showPullRequests = false;
        _showNotifications = false;
      });
      (widget.onChooseAgentTerminal ?? widget.onOpenTerminal)(agent);
    },
    onYourDevices: widget.app?.devicesEnabled != true
        ? null
        : () {
            _closeSidebar();
            setState(() => _showNotifications = false);
            widget.app!.openDevices();
          },
    needsHuman: (group) => _needsHuman(group).length,
    onSelect: (id) {
      setState(() => _showNotifications = false);
      c.select(id);
      _closeSidebar();
    },
  );

  bool get _notificationsVisible =>
      _showNotifications && !_devicesVisible && !c.accessRevoked;

  /// Opens the conversation a tag is in, at its message, replying to it. Older
  /// pages are read first, until the message is among them; one that is not
  /// found says so, and the list stays.
  Future<void> _openMention(SuperTabMention mention) async {
    final id = mention.conversationId;
    if (c.snapshot?.conversation(id) == null) return;
    SuperTabMessage? message;
    // Up to 50 pages (5,000 messages) back.
    for (var page = 0; page < 50; page++) {
      await c.loadMessages(id, older: c.messages(id).isNotEmpty);
      if (!mounted) return;
      message = c
          .messages(id)
          .where((m) => m.id == mention.messageId)
          .firstOrNull;
      if (message != null || !c.hasOlder(id)) break;
    }
    if (message == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(
            c.hasOlder(id)
                ? 'This message is too far back to open.'
                : 'This message is no longer in the conversation.',
          ),
        ),
      );
      return;
    }
    if (!_showNotifications) return;
    _showNotifications = false;
    c.select(id);
    setState(() {
      if (c.canWrite && c.selected?.archived == false) _replies[id] = message!;
      _target = message!.id;
      // Stop following the end: the tagged message is what to see.
      _scrollRequest++;
      _jumpingToEnd = false;
      _following[id] = false;
    });
    _revealTarget(id, 0);
    _focus.requestFocus();
  }

  /// The list is lazy: jump near the target until its row is built, then
  /// bring it into view.
  void _revealTarget(String id, int attempt) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || c.selectedId != id || _target == null) return;
      if (_targetKey.currentContext case final target?) {
        unawaited(Scrollable.ensureVisible(target, alignment: .3));
        return;
      }
      final scroll = _scroll[id];
      final messages = c.messages(id);
      final index = messages.indexWhere((m) => m.id == _target);
      if (scroll == null || !scroll.hasClients || index < 0 || attempt > 20) {
        return;
      }
      scroll.jumpTo(scroll.position.maxScrollExtent * index / messages.length);
      _revealTarget(id, attempt + 1);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  List<SuperTabAgent> _needsHuman(SuperTabConversation group) =>
      c.snapshot?.agents
          .where(
            (agent) =>
                group.agentIds.contains(agent.id) &&
                (widget.app?.questionFor(agent.machineId, agent.harnessId) !=
                        null ||
                    (superTabWorkWaits(group.assignment?['status']) &&
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

  void _leaveResize() {
    if (_terminalsVisible || _devicesVisible) {
      FocusManager.instance.primaryFocus?.unfocus();
      final app = widget.app, paneId = widget.app?.focusedPaneId;
      if (app != null && paneId != null) app.focusPane(paneId, reveal: true);
    } else if (_showPullRequests) {
      _pullRequestsFocus.requestFocus();
    } else {
      _focus.requestFocus();
    }
  }

  bool get _terminalsVisible =>
      !_devicesVisible && (widget.terminalsVisible || widget.terminal != null);

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
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _devicesVisible
                          ? 'Your devices'
                          : _notificationsVisible
                          ? 'Notifications'
                          : group == null
                          ? c.snapshot?.projects.isEmpty == true
                                ? c.snapshot!.name
                                : 'Choose a project'
                          : c.snapshot!.isProjectLead(group.id)
                          ? c.snapshot!.projectFor(group.id)!.name
                          : group.id == c.snapshot!.leadsConversationId
                          ? 'Product Managers'
                          : group.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.text(medium: true),
                    ),
                    if (!_devicesVisible && !_notificationsVisible)
                      if (c.reviewLine(group) case final line?)
                        Text(
                          line,
                          key: const ValueKey('super-review-line'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata(),
                        ),
                  ],
                ),
              ),
            ),
            if (group != null &&
                !_devicesVisible &&
                !_notificationsVisible) ...[
              AppIconButton(
                key: const ValueKey('super-chat'),
                icon: AppIcons.messageSquare,
                size: AppIcons.inlineSize,
                tooltip: 'Chat',
                selected: !_terminalsVisible && !_showPullRequests,
                color: !_terminalsVisible && !_showPullRequests
                    ? DesktopChrome.foreground
                    : DesktopChrome.muted,
                onPressed: () {
                  setState(() => _showPullRequests = false);
                  widget.onCloseTerminal?.call();
                  _readVisibleTailAfterFrame();
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (mounted) _focus.requestFocus();
                  });
                },
              ),
              const SizedBox(width: 4),
              AppIconButton(
                key: const ValueKey('super-terminals'),
                icon: AppIcons.terminal,
                size: AppIcons.inlineSize,
                tooltip: 'Group terminals (${group.agentIds.length})',
                selected: _terminalsVisible,
                color: _terminalsVisible
                    ? DesktopChrome.foreground
                    : DesktopChrome.muted,
                // A read-only viewer's terminal reads are refused.
                onPressed: group.agentIds.isNotEmpty && c.canWrite
                    ? () {
                        setState(() => _showPullRequests = false);
                        widget.onOpenGroupTerminals?.call();
                      }
                    : null,
              ),
              const SizedBox(width: 4),
              AppIconButton(
                key: const ValueKey('super-pull-requests'),
                focusNode: _pullRequestsFocus,
                icon: AppIcons.gitPullRequest,
                size: AppIcons.inlineSize,
                tooltip: 'Pull requests',
                selected: !_terminalsVisible && _showPullRequests,
                color: !_terminalsVisible && _showPullRequests
                    ? DesktopChrome.foreground
                    : DesktopChrome.muted,
                onPressed: () {
                  widget.onCloseTerminal?.call();
                  setState(() => _showPullRequests = true);
                },
              ),
              // Not a workgroup: nothing to rename, archive or detail.
              if (group.id != c.snapshot!.leadsConversationId) _options(group),
            ],
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
          if (editable && project?.ownerId == c.accountId)
            item('Instructions', () => _groupAction('skills', group)),
          if (editable)
            item('Update cadence', () => _groupAction('cadence', group)),
          item('Swarm routing', () => _groupAction('routing', group)),
          if (editable && project?.ownerId == c.accountId)
            item('Delete Project', () => _groupAction('delete', group)),
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
                        'cancelled',
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

  Future<void> _resolveDelivery(
    SuperTabMessage message,
    SuperTabDelivery delivery,
    String resolution,
  ) async {
    final c = this.c;
    if (!c.canWrite || c.saving || delivery.id == null) return;
    if (resolution == 'open') {
      final agent = c.snapshot?.agent(delivery.agentId);
      if (agent != null) {
        c.select(message.conversationId);
        widget.onOpenTerminal(agent);
      }
      return;
    }
    await c.command({
      'type': 'delivery.resolve',
      'deliveryId': delivery.id,
      'resolution': resolution,
    });
  }

  Widget _message(
    SuperTabMessage message,
    bool grouped,
    Map<String, SuperTabMessage> byId, {
    bool showReceipt = false,
  }) {
    if (message.terminalEvent || message.source['kind'] == 'overlap') {
      return SuperTabTerminalRow(
        key: ValueKey('super-message-${message.id}'),
        message: message,
      );
    }
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
      // A person is named by their address's first part, as people say it.
      mentions: [
        for (final id in message.mentions)
          if (c.snapshot?.people.where((p) => p.id == id).firstOrNull
              case final person?)
            person.email.split('@').first,
      ],
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
        if (showReceipt)
          SuperTabMessageReceipt(
            key: ValueKey('super-message-receipt-${message.id}'),
            message: message,
            controller: c,
            app: widget.app,
            machineName: widget.machineName,
            onResolve: (delivery, resolution) =>
                unawaited(_resolveDelivery(message, delivery, resolution)),
            onAddLead: () {
              if (c.selected case final group?) widget.onAddAgent(group);
            },
          ),
      ],
    );
  }

  /// On the web a conversation is read before anything else is drawn
  /// ([WorkspaceChrome.superTabRecovers]); Desktop keeps "Loading" meanwhile.
  bool get _readsFirst => WorkspaceChrome.of(context).superTabRecovers;

  /// A thumb's target on a phone, for the buttons only [_readsFirst] adds.
  static const _thumb = ButtonStyle(
    tapTargetSize: MaterialTapTargetSize.padded,
  );

  Widget _firstReadFailed(String error) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            error,
            textAlign: TextAlign.center,
            style: DesktopChrome.text(color: DesktopChrome.muted),
          ),
          if (!c.accessRevoked) ...[
            const SizedBox(height: 12),
            TextButton(
              style: _thumb,
              onPressed: () => unawaited(c.refresh()),
              child: const Text('Retry'),
            ),
          ],
        ],
      ),
    ),
  );

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
    if (c.snapshot?.projects.isEmpty == true && !c.accessRevoked) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Create a project to get started.',
                style: DesktopChrome.text(color: DesktopChrome.muted),
              ),
              if (WorkspaceChrome.of(context).superTabRecovers &&
                  widget.onNewProject != null) ...[
                const SizedBox(height: 12),
                FilledButton(
                  style: _thumb,
                  onPressed: c.canWrite ? widget.onNewProject : null,
                  child: const Text('New project'),
                ),
              ],
              if (c.operationError != null) ...[
                const SizedBox(height: 12),
                Text(c.operationError!, style: DesktopChrome.metadata()),
              ],
              if (c.hasPendingAction)
                TextButton(
                  onPressed: c.saving ? null : c.retry,
                  child: const Text('Check pending action'),
                ),
            ],
          ),
        ),
      );
    }
    final group = c.selected;
    final writable = c.canWrite && group != null && !group.archived;
    final busy = c.saving || c.uploading;
    final allMessages = c.messages(c.selectedId);
    final latestOwn = allMessages.reversed
        .where(
          (m) => !m.fromAgent && !m.fromTerminal && m.authorId == c.accountId,
        )
        .firstOrNull;
    // Older Desktops still show this plain notice. The inline receipt owns the
    // same explanation here, including after delivery settles, so it never resurfaces stale.
    final messages = allMessages
        .where(
          (m) =>
              !(m.source['kind'] == 'delivery-hold' &&
                  m.source['messageId'] == latestOwn?.id &&
                  m.source['deliveryId'] == latestOwn?.receiptDelivery?.id),
        )
        .toList();
    final entries = superTabTranscriptEntries(messages);
    final byId = {for (final message in messages) message.id: message};
    final grouped = SuperTabMessageRow.consecutiveUpdates(messages);
    final newAfter = _newAfter[c.selectedId];
    final newCount = newAfter == null
        ? 0
        : messages.where((message) => message.sequence > newAfter).length;
    final reply = _replies[c.selectedId];
    final choices = _completionChoices;
    // No conversation read yet: its error is the page itself, not a line over "Loading".
    final unread = _readsFirst && c.snapshot == null;
    return Column(
      children: [
        if (c.error != null && !unread)
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
              : unread && c.error != null
              ? _firstReadFailed(c.error!)
              : messages.isEmpty
              ? Center(
                  child: Text(
                    c.accessRevoked
                        ? 'Conversation unavailable.'
                        : group == null
                        ? 'Loading conversation…'
                        : c.snapshot!.isProjectLead(group.id)
                        ? 'Discuss the plan with your product manager.'
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
                                  KeyedSubtree(
                                    key: message.id == _target
                                        ? _targetKey
                                        : null,
                                    child: _message(
                                      message,
                                      grouped.contains(message.id),
                                      byId,
                                      showReceipt: message.id == latestOwn?.id,
                                    ),
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
          )
        else if (c.operationNotice != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              c.operationNotice!,
              key: const ValueKey('super-operation-notice'),
              style: DesktopChrome.control(),
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
        if (choices.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
            child: Material(
              color: DesktopChrome.surface,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(
                  DesktopChrome.controlRadius,
                ),
                side: BorderSide(color: DesktopChrome.rim),
              ),
              clipBehavior: Clip.antiAlias,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * .3,
                ),
                child: ListView(
                  key: const ValueKey('super-composer-completions'),
                  shrinkWrap: true,
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  children: [
                    for (var i = 0; i < choices.length; i++)
                      ListTile(
                        key: _completionKeys[i],
                        dense: true,
                        selected:
                            i == _mentionIndex.clamp(0, choices.length - 1),
                        selectedTileColor: grid.AppSurface.selectedFill,
                        selectedColor: DesktopChrome.foreground,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                        ),
                        title: Text(
                          choices[i].label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(),
                        ),
                        subtitle: choices[i].detail == null
                            ? null
                            : Text(
                                choices[i].detail!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: DesktopChrome.metadata(),
                              ),
                        onTap: choices[i].choose,
                      ),
                  ],
                ),
              ),
            ),
          ),
        if (group != null && group.archived)
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'This group is closed. You can read it but not write.',
                    style: DesktopChrome.metadata(),
                  ),
                ),
                if (c.canWrite)
                  TextButton(
                    key: const ValueKey('super-group-reopen'),
                    onPressed: c.saving
                        ? null
                        : () => _groupAction('archive', group),
                    child: const Text('Reopen'),
                  ),
              ],
            ),
          )
        else
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
            child: Focus(
              onKeyEvent: (node, event) {
                final keys = HardwareKeyboard.instance;
                final composing = _composer.value.composing;
                if (_focus.hasFocus &&
                    event is KeyDownEvent &&
                    choices.isNotEmpty &&
                    !keys.isControlPressed &&
                    !keys.isMetaPressed &&
                    !keys.isAltPressed &&
                    !keys.isShiftPressed &&
                    !(composing.isValid && !composing.isCollapsed)) {
                  final key = event.logicalKey;
                  if (key == LogicalKeyboardKey.arrowDown ||
                      key == LogicalKeyboardKey.arrowUp) {
                    _moveCompletion(
                      (_mentionIndex +
                              (key == LogicalKeyboardKey.arrowDown ? 1 : -1)) %
                          choices.length,
                    );
                    return KeyEventResult.handled;
                  }
                  if (key == LogicalKeyboardKey.tab ||
                      key == LogicalKeyboardKey.enter) {
                    choices[_mentionIndex.clamp(0, choices.length - 1)]
                        .choose();
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
                key: const ValueKey('super-message-composer-surface'),
                decoration: BoxDecoration(
                  color: DesktopChrome.field,
                  borderRadius: BorderRadius.circular(
                    DesktopChrome.controlRadius,
                  ),
                  border: Border.all(color: DesktopChrome.rim),
                ),
                child: NewHarnessDropZone(
                  attachments: _files,
                  enabled: writable && !busy,
                  child: GestureDetector(
                    behavior: HitTestBehavior.translucent,
                    onTap: writable ? _focus.requestFocus : null,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          ListenableBuilder(
                            listenable: _files,
                            builder: (context, _) => _files.isEmpty
                                ? const SizedBox.shrink()
                                : Padding(
                                    padding: const EdgeInsets.only(
                                      bottom: 8,
                                      right: 8,
                                    ),
                                    child: NewHarnessAttachmentChips(
                                      attachments: _files,
                                      enabled: !c.saving,
                                      isUploading: c.isUploading,
                                      progressOf: c.uploadProgress,
                                    ),
                                  ),
                          ),
                          ConstrainedBox(
                            constraints: BoxConstraints(
                              minHeight: grid.AppControl.heightFieldScaled,
                            ),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.center,
                              children: [
                                Expanded(
                                  child: NewHarnessPasteTarget(
                                    attachments: _files,
                                    enabled: writable && !busy,
                                    focusNode: _focus,
                                    child: TextField(
                                      key: const ValueKey(
                                        'super-message-composer',
                                      ),
                                      controller: _composer,
                                      focusNode: _focus,
                                      autofocus: !_terminalsVisible,
                                      enabled: writable,
                                      minLines: 1,
                                      maxLines:
                                          MediaQuery.sizeOf(context).height <
                                              600
                                          ? 3
                                          : 8,
                                      maxLength: 32000,
                                      keyboardType: TextInputType.multiline,
                                      textAlignVertical:
                                          TextAlignVertical.center,
                                      style: DesktopChrome.text(),
                                      decoration: InputDecoration(
                                        // The row centers the line. Inheriting a decorated
                                        // field's minimum height leaves slack below its text.
                                        isCollapsed: true,
                                        constraints: const BoxConstraints(),
                                        visualDensity: VisualDensity.standard,
                                        hintStyle: DesktopChrome.text(
                                          color: DesktopChrome.muted,
                                        ),
                                        contentPadding: EdgeInsets.zero,
                                        hintText:
                                            _readsFirst && c.snapshot == null
                                            ? null
                                            : group == null
                                            ? 'Loading conversation…'
                                            : c.canWrite
                                            ? c.snapshot!.isProjectLead(
                                                    group.id,
                                                  )
                                                  ? 'Message Product Manager'
                                                  : group.id ==
                                                        c
                                                            .snapshot!
                                                            .leadsConversationId
                                                  ? 'Message Product Managers'
                                                  : 'Message ${group.title}'
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
                                ),
                                NewHarnessAttachButton(
                                  attachments: _files,
                                  enabled: writable && !busy,
                                ),
                                ListenableBuilder(
                                  listenable: Listenable.merge([
                                    _composer,
                                    _files,
                                  ]),
                                  builder: (context, _) => AppIconButton(
                                    icon: AppIcons.arrowUp,
                                    tooltip: 'Send message',
                                    color: DesktopChrome.accent,
                                    onPressed:
                                        writable &&
                                            !busy &&
                                            !c.hasPendingAction &&
                                            (_composer.text.trim().isNotEmpty ||
                                                !_files.isEmpty)
                                        ? () => unawaited(_send())
                                        : null,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
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
      final chatCovered =
          (narrow && _sidebarOpen) || (!showRoster && _rosterOpen);
      if (_chatCovered && !chatCovered) {
        // Both dismissing a drawer and widening the window reveal the cached
        // transcript without loading another message.
        _readVisibleTailAfterFrame();
      }
      _chatCovered = chatCovered;
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
            excluding: chatCovered,
            child: SuperTabPaneLayout(
              storage: widget.app?.localStore,
              onLeave: _leaveResize,
              left: narrow ? null : _sidebar(),
              right: showRoster ? roster : null,
              center: Column(
                children: [
                  _header(c.selected, narrow, showRoster),
                  Expanded(
                    child: IndexedStack(
                      index: _devicesVisible
                          ? 1
                          : _notificationsVisible
                          ? 3
                          : c.snapshot?.projects.isEmpty == true
                          ? 0
                          : _terminalsVisible
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
                                visible: !_terminalsVisible,
                              )
                            : const SizedBox.shrink(),
                        _notificationsVisible
                            ? SuperTabNotifications(
                                mentions: SuperTabMentions.of(c),
                                onOpen: (mention) =>
                                    unawaited(_openMention(mention)),
                              )
                            : const SizedBox.shrink(),
                      ],
                    ),
                  ),
                ],
              ),
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
                        child: SizedBox(
                          width: SuperTabPaneLayout.drawerWidth(
                            constraints.maxWidth,
                          ),
                          child: roster,
                        ),
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
