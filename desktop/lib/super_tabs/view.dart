import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
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
import 'pm_chat.dart';
import 'workgroup_name.dart';
import 'message_row.dart';
import 'message_receipt.dart';
import 'morning_card.dart';
import 'notifications.dart';
import 'decisions.dart';
import 'decisions_view.dart';
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
  // A quote followed to its original: the search still reading older pages,
  // the reply to come back to (its row's top in the list), and the message
  // lit for a moment on arrival.
  int _jumpRequest = 0;
  ({String conversationId, int pages})? _finding;
  ({String conversationId, String messageId, double top})? _back;
  String? _lit;
  Timer? _litTimer;
  bool _viewEnabled = true;
  bool _chatCovered = false;
  final _loadingOlder = <String>{};
  // Conversations whose last read of earlier messages failed: they offer the
  // button instead of reading again by themselves.
  final _olderFailed = <String>{};
  // The list's rows while built, by message: a page read in above finds the
  // row the reader was looking at, to keep it in place.
  final _built = <String, BuildContext>{};
  // Rows to keep in place once their conversation is on screen again.
  final _anchors = <String, ({String messageId, double top})>{};
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

  Widget _card(SuperTabMessage message, {VoidCallback? onDismiss}) =>
      SuperTabMorningCard(
        key: onDismiss == null ? ValueKey('super-message-${message.id}') : null,
        message: message,
        // A person is named by their address's first part, as people say it.
        personName: (id) =>
            c.snapshot?.people
                .where((p) => p.id == id)
                .firstOrNull
                ?.email
                .split('@')
                .first ??
            'Someone',
        agentName: (id) => c.snapshot?.agentName(id) ?? 'Agent',
        onDismiss: onDismiss,
      );

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
    c.pmChatOpener = _openPmChat;
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
      if (oldWidget.controller.pmChatOpener == _openPmChat) {
        oldWidget.controller.pmChatOpener = null;
      }
      c.addListener(_changed);
      c.pmChatOpener = _openPmChat;
      for (final scroll in _scroll.values) {
        scroll.dispose();
      }
      _scroll.clear();
      _latest.clear();
      _following.clear();
      _newAfter.clear();
      _replies.clear();
      _jumpRequest++;
      _finding = null;
      _back = null;
      _anchors.clear();
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
      // A search or a way back belongs to the conversation it started in.
      _jumpRequest++;
      _finding = null;
      _back = null;
      if (_anchors.remove(id) case final anchor?) {
        unawaited(_keepRow(id, anchor));
      }
      _dial.cancel(); // a fling from the last conversation never scrolls this one
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
    if (c.pmChatOpener == _openPmChat) c.pmChatOpener = null;
    _unregisterDial?.call();
    _dial.cancel();
    _litTimer?.cancel();
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
        final active = (a.closed ? 1 : 0).compareTo(b.closed ? 1 : 0);
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

  Future<void> _earlier() => _loadEarlier(c.selectedId);

  /// A scroll ending near the top reads the earlier page with no click.
  void _readEarlierNearTop(String id, ScrollMetrics metrics) {
    if (metrics.extentBefore > 400 ||
        _finding != null ||
        _loadingOlder.contains(id) ||
        _olderFailed.contains(id) ||
        !c.hasOlder(id)) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && c.selectedId == id && !_loadingOlder.contains(id)) {
        unawaited(_loadEarlier(id));
      }
    });
  }

  /// Reads the page before those loaded, keeping what is on screen in place:
  /// the row of [keep] when it is built, else the topmost row. Rows can
  /// regroup as earlier ones arrive, so the one the reader looks at is kept.
  /// A read already under way is joined; its caller keeps the place. The
  /// reader scrolling during the read keeps their own place instead.
  Future<void> _loadEarlier(String id, {String? keep}) async {
    final scroll = _scroll[id];
    if (scroll == null || !scroll.hasClients || !_loadingOlder.add(id)) {
      await c.loadMessages(id, older: true);
      return;
    }
    final request = _scrollRequest;
    final loaded = c.messages(id).length;
    final started = _anchorRow(keep);
    setState(() {});
    try {
      await c.loadMessages(id, older: true);
    } finally {
      _loadingOlder.remove(id);
    }
    if (!mounted) return;
    // Measured again as the page lands, before its rows are laid out: what
    // is on screen now, wherever the reader went meanwhile. A conversation
    // left meanwhile keeps the place it had.
    final anchor = c.selectedId == id ? _anchorRow(keep) : started;
    setState(() {
      // A read that brought nothing while more remain failed.
      if (c.hasOlder(id) && c.messages(id).length == loaded) {
        _olderFailed.add(id);
      } else {
        _olderFailed.remove(id);
      }
    });
    if (anchor != null) await _keepRow(id, anchor, request: request);
  }

  /// The row of [keep] when it is built, else the topmost row, and its top.
  ({String messageId, double top})? _anchorRow(String? keep) {
    final kept = _built[keep];
    final keptTop = kept != null && kept.mounted ? _topInList(kept) : null;
    return keptTop != null
        ? (messageId: keep!, top: keptTop)
        : _firstVisibleRow();
  }

  /// The topmost row in view, and its top within the list.
  ({String messageId, double top})? _firstVisibleRow() {
    ({String messageId, double top})? first;
    for (final MapEntry(key: messageId, value: row) in _built.entries) {
      if (!row.mounted) continue;
      final top = _topInList(row);
      if (top == null || top < 0 || (first != null && top >= first.top)) {
        continue;
      }
      first = (messageId: messageId, top: top);
    }
    return first;
  }

  /// Brings [anchor]'s row back to where it was in [id]'s list after rows
  /// arrived above it: near it by its place in the list until it is built,
  /// then exactly. A conversation no longer on screen does so on return;
  /// the reader scrolling since [request] (default: now) ends it.
  Future<void> _keepRow(
    String id,
    ({String messageId, double top}) anchor, {
    int? request,
  }) async {
    request ??= _scrollRequest;
    for (var attempt = 0; attempt < 20; attempt++) {
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted) return;
      final scroll = _scroll[id];
      if (c.selectedId != id || scroll == null || !scroll.hasClients) {
        _anchors[id] = anchor;
        return;
      }
      if (request != _scrollRequest) return;
      final position = scroll.position;
      final row = _built[anchor.messageId];
      final top = row != null && row.mounted ? _topInList(row) : null;
      if (top == null) {
        final entries = superTabTranscriptEntries(_shownMessages(id));
        final index = entries.indexWhere(
          (e) => e.message.id == anchor.messageId,
        );
        if (index < 0) return;
        scroll.jumpTo(
          position.maxScrollExtent * (index + 1) / (entries.length + 1),
        );
        continue;
      }
      if ((top - anchor.top).abs() < .5) return;
      // The list's extent is an estimate until laid out there: only the
      // start bounds the jump, and the next frame measures the row again.
      scroll.jumpTo(
        (position.pixels + top - anchor.top).clamp(0.0, double.infinity),
      );
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
    // Archived groups are out of the active set: read the project's now.
    final projectId = c.selected?.projectId;
    if (projectId != null) unawaited(c.loadDormant(projectId));
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
                            ? Center(
                                child: Text(
                                  projectId != null &&
                                          c.dormantLoading(projectId)
                                      ? 'Loading archived conversations…'
                                      : 'No archived conversations.',
                                ),
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
                      // Older closed groups are a page away whatever the
                      // rows above show: newer finished groups or a search
                      // can leave none of them archived or matching.
                      if (projectId != null && c.hasEarlierDormant(projectId))
                        ListTile(
                          key: const ValueKey('super-archived-earlier'),
                          title: Text(
                            c.dormantLoading(projectId)
                                ? 'Loading…'
                                : 'Show earlier',
                            style: DesktopChrome.control(
                              color: DesktopChrome.muted,
                            ),
                          ),
                          onTap: c.dormantLoading(projectId)
                              ? null
                              : () => unawaited(
                                  c.loadDormant(projectId, earlier: true),
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
    onOpenPmChat: (projectId) => unawaited(_openPmChat(projectId)),
  );

  /// Opens [projectId]'s PM chat in front of Notifications, pull requests and
  /// a terminal: the sidebar's way in and ⇧⌘K's ([SuperTabController.pmChatOpener]).
  Future<bool> _openPmChat(String projectId) {
    setState(() {
      _showNotifications = false;
      _showPullRequests = false;
    });
    widget.onCloseTerminal?.call();
    _closeSidebar();
    return c.openPmChat(projectId);
  }

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
  /// bring it into view, or hand its row to [arrived] to place it.
  void _revealTarget(
    String id,
    int attempt, {
    void Function(BuildContext row)? arrived,
  }) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || c.selectedId != id || _target == null) return;
      if (_targetKey.currentContext case final target?) {
        if (arrived != null) {
          arrived(target);
        } else {
          unawaited(Scrollable.ensureVisible(target, alignment: .3));
        }
        return;
      }
      final scroll = _scroll[id];
      final entries = superTabTranscriptEntries(_shownMessages(id));
      final index = entries.indexWhere((e) => e.message.id == _target);
      if (scroll == null || !scroll.hasClients || index < 0 || attempt > 20) {
        return;
      }
      scroll.jumpTo(
        scroll.position.maxScrollExtent * (index + 1) / (entries.length + 1),
      );
      _revealTarget(id, attempt + 1, arrived: arrived);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// The messages [id]'s list shows, in order.
  List<SuperTabMessage> _shownMessages(String id) =>
      c.messages(id).where(_shown).toList();

  /// A message waiting for an agent is never announced; notices older
  /// backends stored stay hidden, in the list and as a reply's quote.
  static bool _shown(SuperTabMessage m) => m.source['kind'] != 'delivery-hold';

  /// The row of [id]'s list that shows [messageId]: its own, or the notice
  /// that folds it in. Null while the message is not loaded.
  String? _rowShowing(String id, String messageId) {
    final shown = _shownMessages(id);
    final message = shown.where((m) => m.id == messageId).firstOrNull;
    if (message == null) return null;
    return superTabTranscriptEntries(shown)
        .lastWhere(
          (e) => superTabMessageOrder(e.message, message) <= 0,
          orElse: () => (message: message, interruptions: 0),
        )
        .message
        .id;
  }

  /// The top of [row] within the message list.
  double? _topInList(BuildContext row) {
    final box = row.findRenderObject(), list = Scrollable.maybeOf(row);
    final viewport = list?.context.findRenderObject();
    if (box is! RenderBox || viewport is! RenderBox || !box.attached) {
      return null;
    }
    return box.localToGlobal(Offset.zero, ancestor: viewport).dy;
  }

  /// Follows [reply]'s quote to its original, reading older pages until it is
  /// loaded. Only this conversation's own pages are read, so the original is
  /// one the reader may read, or it is not found.
  Future<void> _openOriginal(SuperTabMessage reply, BuildContext row) async {
    final id = c.selectedId, original = reply.replyTo;
    final top = _topInList(row);
    if (original == null || top == null) return;
    final request = ++_jumpRequest;
    bool current() =>
        request == _jumpRequest &&
        c.selectedId == id &&
        !c.accessRevoked &&
        c.snapshot?.conversation(id) != null;
    var target = _rowShowing(id, original);
    String? note;
    for (var pages = 0; target == null && c.hasOlder(id); pages++) {
      // As far back as a tag is opened from.
      if (pages == 50) {
        note = 'The original message is too far back to open.';
        break;
      }
      setState(() => _finding = (conversationId: id, pages: pages));
      final loaded = c.messages(id).length;
      await _loadEarlier(id, keep: reply.id);
      if (!mounted || !current()) return;
      target = _rowShowing(id, original);
      if (target == null && c.messages(id).length == loaded) {
        note = 'Couldn’t load earlier messages to find the original.';
        break;
      }
    }
    setState(() => _finding = null);
    if (target == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(
            note ?? 'The original message is no longer in this conversation.',
          ),
        ),
      );
      return;
    }
    final found = target;
    setState(() {
      _back = (conversationId: id, messageId: reply.id, top: top);
      _target = found;
      // Stop following the end: the original is what to see.
      _scrollRequest++;
      _jumpingToEnd = false;
      _following[id] = false;
    });
    _revealTarget(
      id,
      0,
      arrived: (row) {
        unawaited(Scrollable.ensureVisible(row, alignment: .3));
        _light(found);
      },
    );
  }

  /// Returns to the reply a quote was followed from, where it was on screen.
  void _goBack() {
    final back = _back;
    if (back == null || back.conversationId != c.selectedId) return;
    final id = back.conversationId;
    setState(() {
      _back = null;
      _target = back.messageId;
      _scrollRequest++;
      _jumpingToEnd = false;
    });
    _revealTarget(
      id,
      0,
      arrived: (row) {
        final scroll = _scroll[id], top = _topInList(row);
        if (scroll == null || !scroll.hasClients || top == null) return;
        scroll.jumpTo(
          (scroll.offset + top - back.top).clamp(
            0.0,
            scroll.position.maxScrollExtent,
          ),
        );
      },
    );
    _focus.requestFocus();
  }

  void _light(String messageId) {
    _litTimer?.cancel();
    setState(() => _lit = messageId);
    _litTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _lit = null);
    });
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

  /// The reader's own private chat with its project's Product Manager.
  bool _isPmChat(SuperTabConversation group) =>
      c.pmChat(group.projectId)?.id == group.id;

  /// The open conversation's name, or what the pane shows instead of one,
  /// named as the sidebar names it: "# openharness", or a workgroup's
  /// [SuperTabWorkgroupName].
  Widget _title(SuperTabConversation? group) {
    final style = DesktopChrome.text(medium: true);
    final name = _devicesVisible
        ? 'Your devices'
        : _notificationsVisible
        ? 'Notifications'
        : group == null
        ? c.snapshot?.projects.isEmpty == true
              ? c.snapshot!.name
              : 'Choose a project'
        : c.snapshot!.isProjectLead(group.id)
        ? '# ${c.snapshot!.projectFor(group.id)!.name}'
        : group.id == c.snapshot!.leadsConversationId
        ? '# $kProductManagersChannel'
        : _isPmChat(group)
        ? kChatWithPm
        : null;
    if (name == null) return SuperTabWorkgroupName(group!, style: style);
    return Text(
      name,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );
  }

  /// The composer's hint, naming the open conversation as its sidebar row
  /// does: "Message #openharness", "Message #product-managers", "Message Wren".
  String _messageHint(SuperTabConversation group) {
    final snapshot = c.snapshot!;
    if (snapshot.isProjectLead(group.id)) {
      return 'Message #${snapshot.projectFor(group.id)!.name}';
    }
    if (group.id == snapshot.leadsConversationId) {
      return 'Message #$kProductManagersChannel';
    }
    if (_isPmChat(group)) {
      return 'Message ${pmChatName(snapshot, snapshot.projectFor(group.id)!)}';
    }
    return 'Message ${group.title}';
  }

  /// On a phone the header's bar holds Chat and ⋮, each a finger's size, and
  /// ⋮ names the rest (terminals, pull requests, people) instead of five bare
  /// icons. Desktop, which sets no [WorkspaceChrome.compactBelow], never.
  bool get _phone => workspaceIsCompact(context);

  /// Whether ⋮ carries the views a wider header draws as icons.
  bool get _menuNamesViews =>
      _phone && !_devicesVisible && !_notificationsVisible;

  /// Opens the group's terminals beside the chat; null when it has none this
  /// reader may open (a read-only viewer's terminal reads are refused).
  VoidCallback? _openTerminals(SuperTabConversation group) =>
      group.agentIds.isNotEmpty && c.canWrite
      ? () {
          setState(() => _showPullRequests = false);
          widget.onOpenGroupTerminals?.call();
        }
      : null;

  void _openPullRequests() {
    widget.onCloseTerminal?.call();
    setState(() => _showPullRequests = true);
  }

  void _toggleRoster() => setState(() => _rosterOpen = !_rosterOpen);

  /// On a phone, the view ⋮ opened in place of the chat, which the bar has no
  /// icon to mark as selected; null while the chat is the view.
  String? get _openViewName => !_menuNamesViews
      ? null
      : _terminalsVisible
      ? 'Group terminals'
      : _showPullRequests
      ? 'Pull requests'
      : null;

  /// The line under the header's title: on a phone the open view, then the
  /// group's review line.
  Widget? _subtitle(SuperTabConversation? group) {
    final line = c.reviewLine(group);
    final review = line == null
        ? null
        : Text(
            line,
            key: const ValueKey('super-review-line'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(),
          );
    final view = _openViewName;
    if (view == null) return review;
    return Row(
      children: [
        Flexible(
          child: Text(
            view,
            key: const ValueKey('super-open-view'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(color: DesktopChrome.foreground),
          ),
        ),
        if (review != null) ...[
          Text(' · ', style: DesktopChrome.metadata()),
          Flexible(child: review),
        ],
      ],
    );
  }

  Widget _header(
    SuperTabConversation? group,
    bool narrow,
    bool showRoster,
  ) => Container(
    constraints: const BoxConstraints(minHeight: 52),
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
    ),
    child: Row(
      children: [
        if (narrow)
          fingerTarget(
            enabled: _phone,
            AppIconButton(
              icon: AppIcons.columns2,
              tooltip: 'Conversations',
              onPressed: () => setState(() => _sidebarOpen = !_sidebarOpen),
            ),
          ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                // A view saved on this device, until the first read
                // replaces it ([SuperTabReading.drawsSaved]).
                if (c.showingSaved)
                  Row(
                    children: [
                      Flexible(child: _title(group)),
                      const SizedBox(width: 8),
                      // Where the copy is; how long it stays and where
                      // it is cleared, a hover or a long press away.
                      Flexible(
                        child: Tooltip(
                          message:
                              'This browser keeps a copy of the Super '
                              'Tabs you open until you sign out. '
                              'Settings ▸ Account clears it now.',
                          child: Text(
                            'Saved in this browser · Updating…',
                            key: const ValueKey('super-updating'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.metadata(),
                          ),
                        ),
                      ),
                    ],
                  )
                else
                  _title(group),
                if (!_devicesVisible && !_notificationsVisible)
                  ?_subtitle(group),
              ],
            ),
          ),
        ),
        if (group != null && !_devicesVisible && !_notificationsVisible) ...[
          fingerTarget(
            enabled: _phone,
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
          ),
          if (!_menuNamesViews) ...[
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
              onPressed: _openTerminals(group),
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
              onPressed: _openPullRequests,
            ),
          ],
          // Not a workgroup: nothing to rename, archive or detail — but
          // on a phone ⋮ still carries the views the bar leaves out.
          if (_menuNamesViews || group.id != c.snapshot!.leadsConversationId)
            fingerTarget(
              enabled: _phone,
              _options(group, views: _menuNamesViews),
            ),
        ],
        if (!showRoster)
          fingerTarget(
            enabled: _phone,
            AppIconButton(
              icon: AppIcons.users,
              tooltip: 'Members and machines',
              selected: _rosterOpen,
              onPressed: _toggleRoster,
            ),
          ),
      ],
    ),
  );

  /// The group's ⋮ menu. With [views] (a phone) it opens on the views the
  /// header has no room for — the group's terminals and its pull requests —
  /// each a finger's height.
  Widget _options(SuperTabConversation group, {bool views = false}) {
    final project = c.snapshot?.projectFor(group.id);
    final isProject = c.snapshot?.isProjectLead(group.id) == true;
    final isLeads = group.id == c.snapshot?.leadsConversationId;
    final editable = c.canWrite && !c.saving && !c.hasPendingAction;
    Widget item(String label, VoidCallback? action) => MenuItemButton(
      style: ButtonStyle(
        minimumSize: WidgetStatePropertyAll(
          Size(208, views ? kFingerTarget : 32),
        ),
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
        if (views) ...[
          item(
            'Group terminals (${group.agentIds.length})',
            _openTerminals(group),
          ),
          item('Pull requests', _openPullRequests),
          if (!isLeads) const Divider(height: 9),
        ],
        // The leads' conversation is no workgroup: nothing to rename, archive
        // or detail.
        if (isLeads)
          ...const <Widget>[]
        else if (isProject) ...[
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
          // A private conversation is chat only: it has no work.
          if (group.audience == null)
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
        // Until all of the project's closed groups are read, it may have
        // archived ones: the list reads them when it opens.
        if (!c.dormantLoaded(group.projectId) ||
            c.hasEarlierDormant(group.projectId) ||
            c.snapshot?.conversations.any(
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
    bool pinned = false,
  }) {
    if (message.terminalEvent || message.source['kind'] == 'overlap') {
      return SuperTabTerminalRow(
        key: ValueKey('super-message-${message.id}'),
        message: message,
      );
    }
    if (superTabMorningCard(message)) {
      // Pinned above, the transcript keeps its one line, so it is never shown twice.
      return pinned
          ? Padding(
              key: ValueKey('super-message-${message.id}'),
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 8),
              child: Text(message.text, style: DesktopChrome.metadata()),
            )
          : _card(message);
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
    // An original outside the pages read is read by itself for its quote.
    final quoted = message.replyTo == null || byId.containsKey(message.replyTo)
        ? null
        : c.quoted(message.conversationId, message.replyTo!);
    final fetched = quoted?.message;
    final reply =
        byId[message.replyTo] ??
        (fetched != null && _shown(fetched) ? fetched : null);
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
      replyGone: quoted != null && reply == null,
      onOpenReply: (row) => unawaited(_openOriginal(message, row)),
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
          if (!c.accessRevoked && !c.updateRequired) ...[
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
    final latestOwn = c
        .messages(c.selectedId)
        .reversed
        .where(
          (m) => !m.fromAgent && !m.fromTerminal && m.authorId == c.accountId,
        )
        .firstOrNull;
    final messages = _shownMessages(c.selectedId);
    final entries = superTabTranscriptEntries(messages);
    final byId = {for (final message in messages) message.id: message};
    final grouped = SuperTabMessageRow.consecutiveUpdates(messages);
    final newAfter = _newAfter[c.selectedId];
    final newCount = newAfter == null
        ? 0
        : messages.where((message) => message.sequence > newAfter).length;
    final reply = _replies[c.selectedId];
    final finding = _finding?.conversationId == c.selectedId ? _finding : null;
    final back = finding == null && _back?.conversationId == c.selectedId;
    final choices = _completionChoices;
    // Today's stand-up and recap stay at the top of the chat until dismissed.
    final today = DateTime.now();
    final pinned = [
      for (final kind in ['standup', 'recap'])
        if (messages
                .where(
                  (m) => superTabMorningCard(m) && m.source['kind'] == kind,
                )
                .lastOrNull
            case final m?
            when m.createdAt != null &&
                DateUtils.isSameDay(m.createdAt!.toLocal(), today) &&
                !c.cardDismissed(m.id))
          m,
    ];
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
                if (!c.accessRevoked && !c.updateRequired)
                  TextButton(
                    onPressed: () => unawaited(c.refresh()),
                    child: const Text('Retry'),
                  ),
              ],
            ),
          ),
        if (pinned.isNotEmpty && !c.loading)
          ConstrainedBox(
            key: const ValueKey('super-pinned-cards'),
            constraints: const BoxConstraints(maxHeight: 320),
            child: SingleChildScrollView(
              child: Column(
                children: [
                  for (final m in pinned)
                    _card(m, onDismiss: () => c.dismissCard(m.id)),
                ],
              ),
            ),
          ),
        // The reader's own chat with the PM shows what the PM asked them.
        if (group != null && _isPmChat(group))
          SuperTabDecisionsPanel(
            decisions: SuperTabDecisions.of(c),
            projectId: group.projectId,
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
                        : _isPmChat(group)
                        ? 'Only you and the Product Manager read this chat.'
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
                        // Once the scroll ends, so keeping the place never
                        // cuts a drag short.
                        if (event is ScrollEndNotification) {
                          _readEarlierNearTop(id, event.metrics);
                        }
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
                              final id = c.selectedId;
                              if (!c.hasOlder(id)) {
                                return const SizedBox.shrink();
                              }
                              // The button only after a read failed: near
                              // the top, earlier pages read by themselves.
                              if (_olderFailed.contains(id)) {
                                return Align(
                                  child: TextButton(
                                    onPressed: () => unawaited(_earlier()),
                                    child: const Text('Earlier messages'),
                                  ),
                                );
                              }
                              return SizedBox(
                                height: 40,
                                child: _loadingOlder.contains(id)
                                    ? const Center(
                                        child: SizedBox.square(
                                          key: ValueKey(
                                            'super-earlier-loading',
                                          ),
                                          dimension: 16,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                          ),
                                        ),
                                      )
                                    : null,
                              );
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
                                // The message itself is kept in place: its
                                // date moves above earlier ones as they come.
                                _BuiltRow(
                                  id: message.id,
                                  rows: _built,
                                  child: KeyedSubtree(
                                    key: message.id == _target
                                        ? _targetKey
                                        : null,
                                    child: SuperTabMessageHighlight(
                                      on: message.id == _lit,
                                      child: entry.interruptions > 0
                                          ? SuperTabRecordingNotice(
                                              key: ValueKey(
                                                'super-message-${message.id}',
                                              ),
                                              author: _shownAuthor(c, message),
                                              count: entry.interruptions,
                                              onOpenTerminal: agent == null
                                                  ? null
                                                  : () => _openAgent(agent),
                                            )
                                          : _message(
                                              message,
                                              grouped.contains(message.id),
                                              byId,
                                              showReceipt:
                                                  message.id == latestOwn?.id,
                                              pinned: pinned.contains(message),
                                            ),
                                    ),
                                  ),
                                ),
                              ],
                            );
                          },
                        ),
                      ),
                    ),
                    if (finding != null)
                      Positioned(
                        top: 12,
                        left: 20,
                        right: 20,
                        child: Center(
                          child: Material(
                            key: const ValueKey('super-reply-finding'),
                            color: DesktopChrome.surface,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(
                                DesktopChrome.controlRadius,
                              ),
                              side: BorderSide(color: DesktopChrome.rim),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.only(left: 12),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Flexible(
                                    child: Semantics(
                                      liveRegion: true,
                                      child: Text(
                                        finding.pages == 0
                                            ? 'Finding the original message…'
                                            : 'Finding the original message… '
                                                  '${finding.pages} '
                                                  '${finding.pages == 1 ? 'page' : 'pages'} back',
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: DesktopChrome.control(),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 4),
                                  TextButton(
                                    onPressed: () => setState(() {
                                      _jumpRequest++;
                                      _finding = null;
                                    }),
                                    child: const Text('Cancel'),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    if (newCount > 0 || back)
                      Positioned(
                        bottom: 12,
                        left: 20,
                        right: 20,
                        child: Center(
                          child: Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            alignment: WrapAlignment.center,
                            children: [
                              if (back)
                                FilledButton.icon(
                                  key: const ValueKey('super-reply-back'),
                                  onPressed: _goBack,
                                  icon: const Icon(
                                    AppIcons.chevronDown,
                                    size: 16,
                                  ),
                                  label: const Text('Back to reply'),
                                ),
                              if (newCount > 0)
                                FilledButton.icon(
                                  key: const ValueKey('super-new-messages'),
                                  onPressed: _jumpToLatest,
                                  icon: const Icon(
                                    AppIcons.chevronDown,
                                    size: 16,
                                  ),
                                  label: Text(
                                    '$newCount new ${newCount == 1 ? 'message' : 'messages'}',
                                  ),
                                ),
                            ],
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
                fingerTarget(
                  enabled: _phone,
                  AppIconButton(
                    icon: AppIcons.close,
                    tooltip: 'Cancel reply',
                    onPressed: () =>
                        setState(() => _replies.remove(c.selectedId)),
                  ),
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
                                            ? _messageHint(group)
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
                                fingerTarget(
                                  enabled: _phone,
                                  NewHarnessAttachButton(
                                    attachments: _files,
                                    enabled: writable && !busy,
                                  ),
                                ),
                                ListenableBuilder(
                                  listenable: Listenable.merge([
                                    _composer,
                                    _files,
                                  ]),
                                  builder: (context, _) => fingerTarget(
                                    enabled: _phone,
                                    AppIconButton(
                                      icon: AppIcons.arrowUp,
                                      tooltip: 'Send message',
                                      color: DesktopChrome.accent,
                                      onPressed:
                                          writable &&
                                              !busy &&
                                              !c.hasPendingAction &&
                                              (_composer.text
                                                      .trim()
                                                      .isNotEmpty ||
                                                  !_files.isEmpty)
                                          ? () => unawaited(_send())
                                          : null,
                                    ),
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
        onAnswer: (id) {
          setState(() {
            _showPullRequests = false;
            _rosterOpen = false;
          });
          unawaited(c.select(id));
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
                                leading: SuperTabDecisionList(
                                  decisions: SuperTabDecisions.of(c),
                                ),
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

/// Records its row's context while built, so [_SuperTabViewState] can find
/// the row a message is shown in.
class _BuiltRow extends StatefulWidget {
  const _BuiltRow({required this.id, required this.rows, required this.child});
  final String id;
  final Map<String, BuildContext> rows;
  final Widget child;

  @override
  State<_BuiltRow> createState() => _BuiltRowState();
}

class _BuiltRowState extends State<_BuiltRow> {
  @override
  void didUpdateWidget(_BuiltRow oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The list reuses a row for another message.
    if (oldWidget.id != widget.id && oldWidget.rows[oldWidget.id] == context) {
      oldWidget.rows.remove(oldWidget.id);
    }
  }

  @override
  void dispose() {
    if (widget.rows[widget.id] == context) widget.rows.remove(widget.id);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    widget.rows[widget.id] = context;
    return widget.child;
  }
}
