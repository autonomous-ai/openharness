import 'dart:async';

import 'package:clock/clock.dart';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show RenderSliverMultiBoxAdaptor, SliverMultiBoxAdaptorParentData;
import 'package:flutter/scheduler.dart' show SchedulerBinding, SchedulerPhase;
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../shared/widgets/empty_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/new_harness_attachments.dart';
import '../widgets/new_harness_paste.dart';
import '../state/app_state.dart';
import '../state/harness_attachments.dart';
import '../state/workspace_chrome.dart';
import '../shortcuts/app_keymap.dart' show KeymapRegion;
import '../shortcuts/keymap.dart' show KeymapContext;
import 'chat_scroll.dart';
import 'leaderboard/reader.dart';
import 'jump_to_latest.dart';
import 'unread_line.dart';
import 'roster.dart';
import 'recording_notice.dart';
import 'profile_actions.dart';
import 'live_card.dart';
import 'personal_lead.dart';
import 'personal_projects.dart';
import 'private_project_lock.dart';
import 'pull_request_facts.dart';
import 'pull_requests.dart';
import 'attachment_upload.dart' show kSuperTabFolderZipMaxBytes;
import 'composer_files.dart';
import 'composer_newline.dart';
import 'composer_tags.dart';
import 'composer_toggle.dart';
import 'activity.dart';
import 'attachment_chips.dart' show superTabShowsInPlace;
import 'attachment_image.dart';
import 'reminders.dart';
import 'activity_view.dart';
import 'attention.dart';
import 'controller.dart';
import 'file_links.dart';
import 'dialog_scope.dart';
import 'folder_zip.dart';
import 'instructions_panel.dart';
import 'model.dart';
import 'agent_details.dart';
import 'identity.dart' show superTabMachineName;
import 'identity_card.dart';
import 'prompt_alerts.dart';
import 'workgroup_name.dart';
import 'message_link.dart';
import 'message_link_swarms.dart';
import 'message_link_preview.dart';
import 'message_row.dart';
import 'message_receipt.dart';
import 'notifications.dart';
import 'buddies.dart';
import 'decisions.dart';
import 'day_pill.dart';
import 'decisions_view.dart';
import 'route_row.dart';
import 'terminal_row.dart';
import 'thread_panel.dart';
import 'work_details.dart';
import 'manage_page.dart';
import 'project_sidebar.dart';
import 'buddy_sessions.dart';
import 'swarm_switcher.dart' show fallBackToPersonal;
import 'project_options.dart';
import 'project_status.dart';
import 'ship_row.dart';
import 'switch_pm.dart';
import 'pane_layout.dart';
import 'composer_actions.dart';
import 'view_room.dart';
import 'voice_recorder.dart';
import 'voice_row.dart';
import 'voice_send.dart';
import 'voice_take.dart';
import 'swarm_type.dart';
import 'visible_tick.dart';
import 'buddy_rows.dart';
import 'task_groups.dart';
import 'tasks_view.dart';
import 'voice_length.dart';
import '../widgets/dial_list_scroll.dart';
import '../widgets/laid_out_list.dart';

typedef _ComposerChoice = SuperTabComposerChoice;

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
    this.isThisComputer,
    this.terminal,
    this.onCloseTerminal,
    this.onOpenGroupTerminals,
    this.terminalsVisible = false,
    this.app,
    this.onNewProject,
    this.onNewSwarm,
    this.onChooseAgentTerminal,
    this.linkSwarms,
    this.voiceRecorder,
  });
  final SuperTabController controller;
  final VoidCallback onInvite;
  final ValueChanged<SuperTabConversation> onAddAgent;
  final ValueChanged<SuperTabAgent> onOpenTerminal;
  final String Function(String machineId) machineName;

  /// Whether [machineId] is the computer this app runs on, where a folder
  /// dropped on the composer is. Unknown (null) counts as another computer.
  final bool Function(String machineId)? isThisComputer;
  final Widget? terminal;
  final VoidCallback? onCloseTerminal, onOpenGroupTerminals;
  final bool terminalsVisible;
  final AppNotifier? app;
  final VoidCallback? onNewProject;

  /// The existing New Swarm, for the Swarm dropdown atop the left bar; none
  /// without it.
  final VoidCallback? onNewSwarm;
  final ValueChanged<SuperTabAgent>? onChooseAgentTerminal;

  /// How a message link reaches the account's other Swarms. Without it, and
  /// without an [app], a link into another Swarm is not followed.
  final SwarmLinkSwarms? linkSwarms;

  /// Makes the microphone the composers' mic records with
  /// ([superTabVoiceRecorder]: macOS and the web); without it, no mic shows.
  final SuperTabVoiceRecorder Function()? voiceRecorder;

  @override
  State<SuperTabView> createState() => _SuperTabViewState();
}

class _SuperTabViewState extends State<SuperTabView>
    with WidgetsBindingObserver {
  final _composer = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Swarm message');
  final _pullRequestsFocus = FocusNode(debugLabel: 'Project pull requests');
  final _scroll = <String, SuperTabChatScroll>{};
  final _latest = <String, int>{};
  final _following = <String, bool>{};
  final _newAfter = <String, int>{};
  // Conversations whose list is scrolled away from its newest message.
  final _awayFromEnd = <String>{};
  final _unread = SuperTabUnreadLines();
  final _replies = <String, SuperTabMessage>{};

  /// The Buddy chats whose next message starts its own thread's session.
  final _chatSessions = <String>{};

  String? _selected;
  int _scrollRequest = 0;
  bool _jumpingToEnd = false;
  bool _sidebarOpen = false;
  bool _rosterOpen = false;
  bool _showPullRequests = false;

  /// The project's Tasks view holds the main pane (task #2569), as Pull
  /// requests does for a task.
  bool _showTasks = false;

  bool _showNotifications = false;

  /// Manage holds the main pane; [_manageTab] is which of its pages, but for
  /// Devices, which is the pane the view holds for it ([_devicesVisible]).
  bool _showManage = false;
  SuperTabManageTab _manageTab = SuperTabManageTab.machines;
  // The message a tag opened, scrolled to once it is laid out.
  String? _target;
  // The conversation a link or tag opened at its own message this visit: its
  // New messages line stays where it is, reached by the jump pill.
  String? _openedAtMessage;
  // The jump to a message or line still landing: its passing scroll neither
  // counts the line as seen nor shows the pill. Each jump takes a new number.
  int? _landing;
  int _landings = 0;
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
  // Each list's dividing row: see [_splitAt].
  final _split = <String, SuperTabMessage>{};
  final _newerRows = UniqueKey();
  // The composer's completions are drawn by builders of their own, so typing
  // and choosing among them never rebuild the transcript.
  final _mentionIndex = ValueNotifier(0);
  late final _tagBackspace = SuperTabTagBackspace(
    () => c.mentions(c.selectedId).values,
  );
  final _dismissedMention = ValueNotifier<String?>(null);
  String? _completionPrefix;

  /// The folders whose paths were dropped into each chat's message: what
  /// Attach as zip offers while those paths are still in it.
  final _droppedFolders = <String, List<String>>{};

  /// The chats whose dropped folders are being zipped.
  final _zipping = <String>{};
  final _completionKeys = List.generate(
    superTabCompletionLimit,
    (_) => GlobalKey(),
  );
  SuperTabController get c => widget.controller;

  /// The open project's week board, read once for the right pane's members
  /// and the left sidebar's Models, so both show one week.
  late SuperTabProjectBoard _board = SuperTabProjectBoard(c);

  /// What this computer's GitHub says of the pull requests on live cards.
  late SuperTabPullRequestFacts _facts = SuperTabPullRequestFacts(
    widget.app?.readPullRequestsStatus,
  );

  /// A device with a Lead of this Swarm open scrolls the chat on screen, or
  /// the thread open beside it (the dial's thread face shows that thread).
  late final _dial = DialListScroll(
    () =>
        c.openedThread?.conversationId == c.selectedId && _threadScroll != null
        ? _threadScroll
        : _scroll[c.selectedId],
  );
  ScrollController? _threadScroll;
  VoidCallback? _unregisterDial;
  void _registerDial() {
    _unregisterDial?.call();
    _unregisterDial = widget.app?.registerSuperTabScroll(c.tabId, _dial.handle);
  }

  bool get _devicesVisible =>
      c.devicesSelected &&
      widget.app?.devicesEnabled == true &&
      !c.accessRevoked;

  String _agentName(SuperTabAgent agent) => superTabAgentName(c, agent);

  String _authorName(SuperTabMessage message) =>
      c.snapshot?.authorName(message) ?? message.authorName;

  /// Your own message reads You, in the row and in the quote of it. In your
  /// Buddy chat the coordinator's private lines read as lines to you, "River
  /// (PM) → you" with its role's badge: it writes there but cannot read it
  /// (Lead, 10-29).
  String _shownAuthor(SuperTabController c, SuperTabMessage message) {
    if (message.authorId == c.accountId && !message.fromAgent) return 'You';
    // The controller's own snapshot names the author: a preview may be of
    // another Swarm's message.
    final name = c.snapshot?.authorName(message) ?? message.authorName;
    final snapshot = c.snapshot;
    final project = snapshot?.projectFor(message.conversationId);
    final chat = project == null ? null : c.buddyChat(project.id);
    return message.fromAgent &&
            chat?.id == message.conversationId &&
            snapshot!.conversation(project!.leadConversationId)?.leadId ==
                message.authorId
        ? '$name (${snapshot.roleOf(message.authorId)?.badge ?? 'PM'}) → you'
        : switch (c.stepNameOf(message)) {
            // A step's row in its task's chat names its step (task steps design).
            final String step => '$name · $step',
            null => name,
          };
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _composer.addListener(_composerMoved);
    c.addListener(_changed);
    c.addListener(_holdVoiceAway);
    c.buddyChatOpener = _openBuddyChat;
    SuperTabChatNotices.of(c).chatShown = _chatShown;
    _registerDial();
    _changed();
  }

  bool _chatShown() => _chatIsVisible;

  /// The composers' one voice message (voice_take.dart), the main chat's or
  /// a thread's, for the chat it was recorded in; none without a recorder.
  late final SuperTabVoiceTake? _voice = switch (widget.voiceRecorder) {
    final recorder? => SuperTabVoiceTake(
      recorder: recorder,
      post: _postVoice,
    )..addListener(_voiceChanged),
    null => null,
  };

  Future<SuperTabVoicePosted> _postVoice(
    String conversationId,
    String? root,
    SuperTabVoiceClip clip,
  ) => c.sendVoice(
    conversationId: conversationId,
    root: root,
    wav: clip.wav,
    // The computer's own language; the server hears English in one it does
    // not serve.
    lang: WidgetsBinding.instance.platformDispatcher.locale.languageCode,
  );

  void _voiceChanged() {
    if (mounted) setState(() {});
  }

  /// A take recording for a chat or thread no longer shown stops and is kept
  /// for it, Send still there: never sent into the one opened instead.
  void _holdVoiceAway() {
    final voice = _voice;
    if (voice == null ||
        (voice.state != SuperTabVoiceState.recording &&
            voice.state != SuperTabVoiceState.starting)) {
      return;
    }
    final root = voice.root;
    final away = root == null
        ? c.selectedId != voice.conversationId
        : c.openedThread?.root != root;
    if (away) voice.hold();
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
    if (state == AppLifecycleState.resumed) {
      _readVisibleTailAfterFrame();
    } else {
      // No frame follows: the poll goes on in the background.
      _syncThreadPane();
    }
  }

  @override
  void didUpdateWidget(SuperTabView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A terminal that opens shows: Manage and Activity outrank it in the pane.
    final terminalNow = widget.terminalsVisible || widget.terminal != null;
    final terminalBefore =
        oldWidget.terminalsVisible || oldWidget.terminal != null;
    if (terminalNow && !terminalBefore && !c.devicesSelected) {
      _showManage = _showNotifications = false;
    }
    if (oldWidget.controller != c) {
      _noticesLeave(oldWidget.controller);
      SuperTabChatNotices.of(c).chatShown = _chatShown;
    }
    if (oldWidget.controller != c || oldWidget.app != widget.app) {
      _dial.cancel();
      _registerDial();
      _facts.dispose();
      _facts = SuperTabPullRequestFacts(widget.app?.readPullRequestsStatus);
    }
    if (oldWidget.controller != c) {
      _board.dispose();
      _board = SuperTabProjectBoard(c);
      oldWidget.controller.threadPaneHidden();
      oldWidget.controller.removeListener(_changed);
      oldWidget.controller.removeListener(_holdVoiceAway);
      // A take belongs to the Swarm it was recorded in.
      _voice?.discard();
      if (oldWidget.controller.buddyChatOpener == _openBuddyChat) {
        oldWidget.controller.buddyChatOpener = null;
      }
      c.addListener(_changed);
      c.addListener(_holdVoiceAway);
      c.buddyChatOpener = _openBuddyChat;
      for (final scroll in _scroll.values) {
        scroll.dispose();
      }
      _scroll.clear();
      _split.clear();
      _latest.clear();
      _following.clear();
      _newAfter.clear();
      _unread.reset();
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
    _takeNotice();
    _takeMessageRequest();
    if (c.accessRevoked) {
      _replies.clear();
      _newAfter.clear();
      _awayFromEnd.clear();
      _unread.reset();
      // With the Swarm dropdown, a tab whose Swarm is taken away moves to
      // Personal once the person has picked it here.
      if ((widget.app, widget.onNewSwarm) case (final app?, _?)) {
        final lost = c;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && widget.controller == lost) {
            unawaited(fallBackToPersonal(app, lost));
          }
        });
      }
    }
    final visible =
        c.snapshot?.conversations.map((g) => g.id).toSet() ?? <String>{};
    _replies.removeWhere((id, _) => !visible.contains(id));
    final id = c.selectedId;
    final firstView = !_scroll.containsKey(id);
    final scroll = _scroll.putIfAbsent(
      id,
      () =>
          SuperTabChatScroll(rows: () => _built.entries)
            ..addListener(_checkUnreadLine),
    );
    final atEnd = scroll.hasClients
        ? scroll.position.extentAfter < 40
        : (_following[id] ?? true);
    final previous = _latest[id] ?? 0;
    final latest = c.messages(id).lastOrNull?.sequence ?? 0;
    final grew = latest > previous && !_loadingOlder.contains(id);
    _latest[id] = latest;
    if (grew && !atEnd) _newAfter.putIfAbsent(id, () => previous);
    if (atEnd && _selected == id && scroll.hasClients && !_jumpingToEnd) {
      _moveSplitToView(id, scroll);
    }
    final draft = c.accessRevoked ? '' : c.draft(id);
    if (_selected != id) {
      _unread.forget(_selected);
      _openedAtMessage = null;
      _scrollRequest++;
      _jumpingToEnd = false;
      // A search or a way back belongs to the conversation it started in. The
      // first conversation shown ends nothing: a tag opened as the view
      // appears is still being found while it is adopted.
      if (_selected != null) _jumpRequest++;
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
    final mark = c.readMark(id), shown = _ownShown(id);
    if (c.awaitsNewest(id)) {
      // Held from an earlier visit: the line is placed, the end followed and
      // anything marked read once the newest messages have landed.
    } else if (_unread.startHistory(
      id,
      shown,
      mark,
      heldBack: c.heldBackTo(id, mark),
    )) {
      _loadBackToMark(id, mark);
    } else if (_unread.waitsForHistory(id)) {
      // The line is placed once the messages reach back to the mark.
    } else if (_unread.decide(id, shown, mark, own: c.isOwn)) {
      if (_openedAtMessage != id) _revealUnreadLine(id);
    } else if (firstView || (grew && atEnd)) {
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

  bool get _chatIsVisible => !_chatCovered && _viewIsVisible;

  /// A person can see this Swarm's chat area, whatever covers the chat itself.
  bool get _viewIsVisible {
    if (!mounted ||
        !_viewEnabled ||
        c.accessRevoked ||
        _devicesVisible ||
        _terminalsVisible ||
        _showPullRequests ||
        _showTasks ||
        _showNotifications ||
        _showManage) {
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
    _syncThreadPane();
    // Widget updates already have a frame in progress. Reuse it so routine
    // polling does not request an otherwise unnecessary frame after each build.
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  /// Whether the open thread's pane is on screen: beside its conversation's
  /// chat, in a view a person can see.
  bool get _threadPaneVisible =>
      c.openedThread?.conversationId == c.selectedId && _viewIsVisible;

  /// Tells the controller whether the open thread's pane is on screen, by the
  /// rule the chat reads by: hidden at once, so a poll landing while it is
  /// away marks no reply read; shown after the frame that draws it, which
  /// marks through its newest reply.
  void _syncThreadPane() {
    if (c.openedThread == null) return;
    if (!_threadPaneVisible) return c.threadPaneHidden();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _threadPaneVisible) c.threadPaneShown();
    });
  }

  void _readToEnd(String id, int sequence) {
    final scroll = _scroll[id];
    if (c.selectedId != id ||
        c.awaitsNewest(id) ||
        _unread.waitsForHistory(id) ||
        !_chatIsVisible ||
        scroll == null ||
        !scroll.hasClients ||
        scroll.position.extentAfter >= 40) {
      return;
    }
    _follow(id, true);
    if (_newAfter.containsKey(id)) setState(() => _newAfter.remove(id));
    c.markRead(id, through: sequence);
  }

  /// Whether [id]'s list follows its end; the controller keeps a reader's
  /// rows while they read back.
  void _follow(String id, bool following) {
    _following[id] = following;
    c.readingBack(id, !following);
  }

  /// Reads [id]'s messages back to the reader's [mark] (bounded by the
  /// controller), then places its line.
  void _loadBackToMark(String id, int mark) {
    unawaited(
      c
          .loadBackTo(id, mark, olderPages: _unread.retrying(id) ? 0 : null)
          .then((reached) => reached, onError: (_) => false)
          .then((reached) {
            _unread.historyLoaded(id, reached: reached);
            if (!mounted) return;
            if (reached) return _changed();
            // Failed: the line waits, and the read back is tried again shortly.
            if (_unread.mayRetry(id)) {
              _historyRetry?.cancel();
              _historyRetry = Timer(_historyRetryAfter, _changed);
            }
          }),
    );
  }

  Timer? _historyRetry;
  static const _historyRetryAfter = Duration(seconds: 5);

  /// Brings [id]'s New messages line into view near the top, and stops
  /// following the end there: what came since the reader's mark is below.
  /// The bar or the pill clicked: the line, with typing back in the composer,
  /// as after Jump to latest. A click outside the composer takes its focus,
  /// and a later Esc then reached nothing in the chat.
  void _jumpToUnreadLine(String id) {
    _focus.requestFocus();
    _revealUnreadLine(id);
  }

  void _revealUnreadLine(String id) {
    final messageId = _unread.lineAt(id);
    if (messageId == null) return;
    final request = ++_scrollRequest;
    _jumpingToEnd = false;
    _follow(id, false);
    // Rebuilt so the target's key moves to the line's row from any row an
    // earlier jump marked.
    setState(() => _target = messageId);
    _revealTarget(
      id,
      0,
      arrived: (row) {
        // A link or tag opened since takes the reader to its message instead.
        if (request != _scrollRequest) return;
        // The line itself, not its row, which can be taller than the view:
        // its top would go above it.
        final line = _unread.key.currentContext;
        unawaited(
          Scrollable.ensureVisible(
            line != null && line.mounted ? line : row,
            alignment: .15,
          ),
        );
      },
    );
  }

  /// Shows the jump pill while the reader is away from a line not yet seen,
  /// and Jump to latest while the list is away from its newest message.
  void _checkUnreadLine() {
    // A jump outside a frame (Jump to latest, a key, a test) moves the
    // position before the list lays out again: the line is measured where it
    // was. Measured again once laid out; a list whose extent then changes said
    // so by itself, one whose extent stays (the composer's two rows, #2662)
    // did not, and the bar never showed.
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.idle) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _checkUnreadLine();
      });
    }
    final scroll = _scroll[c.selectedId];
    // A jump still landing passes lines it does not stop at: the pill stays
    // as it was until the line is measured where the jump landed.
    final landing = _landing != null;
    var away = landing && _unread.away, below = landing && _unread.below;
    if (_unread.lineAt(c.selectedId) case final lineAt?
        when scroll != null && scroll.hasClients && !landing) {
      final line = _unread.key.currentContext;
      final top = line == null ? null : _topInList(line);
      final view = scroll.position.viewportDimension;
      away = top == null || top < 0 || top > view;
      if (!away) _unread.saw(c.selectedId);
      // A line not laid out is told by its place in the list, seen or not:
      // the bar shows whenever it is above.
      below = top != null
          ? top > view
          : _below(c.selectedId, lineAt, scroll.position);
    }
    final id = c.selectedId;
    final awayFromEnd =
        scroll != null &&
        scroll.hasClients &&
        scroll.position.extentAfter >= 40;
    // At the end with nothing newer to load, the reader has read everything
    // a bar would lead back to.
    final readThrough =
        scroll != null &&
        scroll.hasClients &&
        !awayFromEnd &&
        !landing &&
        !c.hasNewer(id) &&
        _unread.readThrough(id);
    if ((!readThrough &&
            away == _unread.away &&
            below == _unread.below &&
            awayFromEnd == _awayFromEnd.contains(id)) ||
        !mounted) {
      return;
    }
    // A list settling its extent moves the position mid-layout: draw the pill
    // on the next frame then.
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _checkUnreadLine());
      return;
    }
    setState(() {
      _unread.away = away;
      _unread.below = below;
      if (awayFromEnd) {
        _awayFromEnd.add(id);
      } else {
        _awayFromEnd.remove(id);
      }
    });
  }

  /// Whether [id] shows the bar: its line above the reader, and its message
  /// still held, since a jump can reach only a held row (the newest page read
  /// in place of the held copy, or 500 newer, let it go).
  bool _showsBar(String id) => _unread.offersBar(id) && _newFromLine(id) > 0;

  /// The bar's count: [id]'s messages from others in the main stream, from
  /// its New messages line on; none while the line's message is not held.
  int _newFromLine(String id) {
    final shown = _shownMessages(id);
    final at = shown.indexWhere((m) => m.id == _unread.lineAt(id));
    if (at < 0) return 0;
    return shown.skip(at).where((m) => m.inMainStream && !c.isOwn(m)).length;
  }

  /// Whether [messageId]'s row in [id]'s list is below [position]'s view, by
  /// its place in the list.
  bool _below(String id, String messageId, ScrollPosition position) {
    final entries = superTabTranscriptEntries(_shownMessages(id));
    final row = _rowShowing(id, messageId);
    final index = entries.indexWhere((e) => e.message.id == row);
    return index >= 0 &&
        _estimate(position, index, entries.length) > position.pixels;
  }

  /// Esc: everything loaded in the open conversation is read, line and all.
  /// Keeps the reader's notification setting for [id]; says so when the
  /// server did not keep it.
  Future<void> _setNotify(String id, SuperTabNotify level) async {
    if (await c.setNotify(id, level) || !mounted || c.accessRevoked) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(
        content: Text('Could not change notifications. Try again.'),
      ),
    );
  }

  /// Slack's Shift+Esc: every chat read, with an Undo while the marks wait.
  bool _markAllRead() {
    final held = c.markAllRead();
    if (held == null) return false;
    setState(() {
      _unread.clear(c.selectedId);
      _newAfter.remove(c.selectedId);
    });
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          key: const ValueKey('super-mark-all-toast'),
          duration: SuperTabController.markAllHold,
          content: Text(
            held.count == 1
                ? 'Marked 1 chat read'
                : 'Marked ${held.count} chats read',
          ),
          action: SnackBarAction(label: 'Undo', onPressed: held.undo),
        ),
      );
    return true;
  }

  /// Slack's Option+Shift+Down and Up (`swarm.next_unread`, `.previous_unread`):
  /// the next or previous chat with something unread, in the sidebar's order,
  /// skipping muted ones. At either end nothing moves.
  bool _jumpUnread(int step) {
    final snapshot = c.snapshot;
    if (snapshot == null || c.accessRevoked) return false;
    final order = superTabSidebarOrder(c);
    var at = order.indexOf(c.selectedId);
    if (at < 0) at = step > 0 ? -1 : order.length;
    for (var i = at + step; i >= 0 && i < order.length; i += step) {
      final group = snapshot.conversation(order[i]);
      if (group == null || !c.unreadShown(group)) continue;
      widget.onCloseTerminal?.call();
      setState(() {
        _showNotifications = _showManage = false;
        _showPullRequests = _showTasks = false;
      });
      unawaited(c.select(group.id));
      return true;
    }
    return false;
  }

  /// The Swarm's own keys, heard from anywhere in it that leaves them.
  KeyEventResult _attentionKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final keys = HardwareKeyboard.instance;
    if (keys.isControlPressed || keys.isMetaPressed) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape &&
        keys.isShiftPressed &&
        !keys.isAltPressed) {
      _markAllRead();
      return KeyEventResult.handled;
    }
    // Esc dismisses the bar from anywhere in the chat, as from its box.
    if (event.logicalKey == LogicalKeyboardKey.escape &&
        !keys.isShiftPressed &&
        !keys.isAltPressed &&
        _showsBar(c.selectedId) &&
        _readAll()) {
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// The region the view sits in (the quick switcher's) with the unread chat
  /// keys added, so the keymap runs them: listed, rebindable, and ahead of
  /// Move pane only while the chat has focus.
  Widget _unreadKeys(Widget child) {
    final region = KeymapRegion.of(context);
    return KeymapRegion(
      contextKind: KeymapContext.swarmChat,
      actions: {
        ...?region?.actions,
        'swarm.next_unread': () => _jumpUnread(1),
        'swarm.previous_unread': () => _jumpUnread(-1),
      },
      composing: region?.composing,
      keeps: region?.keeps,
      child: child,
    );
  }

  /// The bar's Mark as read: Esc's read, with typing back in the composer as
  /// after a click on the bar.
  void _markReadFromBar() {
    _focus.requestFocus();
    _readAll();
  }

  bool _readAll() {
    final id = c.selectedId, group = c.selected;
    if (group == null || (!c.unread(group) && _unread.lineAt(id) == null)) {
      return false;
    }
    setState(() {
      _unread.clear(id);
      _newAfter.remove(id);
    });
    c.markRead(id, explicit: true);
    return true;
  }

  /// More ▸ Mark unread: the New messages line goes above [message] at once,
  /// and back where it was if the server did not keep it.
  Future<void> _markUnread(SuperTabMessage message) async {
    final id = message.conversationId;
    final kept = c.markUnread(id, message);
    if (c.selectedId == id) setState(() => _unread.placeAt(id, message.id));
    if (await kept || !mounted) return;
    if (c.selectedId == id) setState(() => _unread.clear(id));
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(const SnackBar(content: Text("Couldn't mark unread")));
  }

  void _jumpToLatest() {
    final id = c.selectedId;
    _focus.requestFocus();
    if (!c.hasNewer(id)) return _followEnd(id);
    // More are waiting than were read: the latest page first, then its end.
    unawaited(
      c.showLatest(id).then((_) {
        if (mounted && c.selectedId == id) _followEnd(id);
      }),
    );
  }

  void _noticesLeave(SuperTabController controller) {
    final notices = SuperTabChatNotices.of(controller);
    if (notices.chatShown == _chatShown) notices.chatShown = null;
  }

  @override
  void dispose() {
    _noticesLeave(c);
    // The controller outlives its view, reading another Swarm's replies.
    c.threadPaneHidden();
    WidgetsBinding.instance.removeObserver(this);
    _board.dispose();
    _facts.dispose();
    c.removeListener(_changed);
    c.removeListener(_holdVoiceAway);
    _voice?.dispose();
    for (final source in _linkSources) {
      source.removeListener(_linkSourceChanged);
    }
    if (c.buddyChatOpener == _openBuddyChat) c.buddyChatOpener = null;
    _unregisterDial?.call();
    _dial.cancel();
    _litTimer?.cancel();
    _historyRetry?.cancel();
    _composer.dispose();
    _mentionIndex.dispose();
    _dismissedMention.dispose();
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
      choices[_mentionIndex.value.clamp(0, choices.length - 1)].choose();
      return;
    }
    if (!c.canWrite ||
        c.selected == null ||
        c.selected!.archived ||
        c.uploading ||
        ((c.saving || c.hasPendingAction) &&
            (!_files.isEmpty || !c.canQueueText)) ||
        (_composer.text.trim().isEmpty && _files.isEmpty)) {
      return;
    }
    final id = c.selectedId;
    // From here a zip still running belongs to neither this message, which
    // took its files already, nor the next.
    final dropped = _droppedFolders.remove(id);
    final newSession =
        _chatSessions.contains(id) &&
        c.offersChatSessions &&
        c.threadSessionBlocked == null;
    final result = await c.send(
      replyTo: _replies[id]?.id,
      newSession: newSession,
      sessionProjectId: newSession ? _chosenSessionProject() : null,
      // The reply goes with the message, which shows at the end at once.
      onSending: () {
        if (!mounted) return;
        setState(() => _replies.remove(id));
        _followEnd(id);
      },
    );
    if (!mounted) return;
    // In the person's Personal Swarm a project chat with no Lead starts one
    // on their computer; the message waits for it (task #2633).
    final app = widget.app;
    if (result != null && app != null) {
      final lead = PersonalLeadStarter.of(app);
      if (lead.wants(c, id)) unawaited(lead.start(c, id));
    }
    if (newSession && result != null) _chatSessions.remove(id);
    // Refused for New session, its text is back as the chat's draft: it shows
    // in the box, ready to send without it, unless another chat is shown or
    // something was typed meanwhile.
    if (result == null &&
        newSession &&
        c.selectedId == id &&
        _composer.text.isEmpty &&
        c.draft(id).isNotEmpty) {
      final restored = c.draft(id);
      _composer.value = TextEditingValue(
        text: restored,
        selection: TextSelection.collapsed(offset: restored.length),
      );
    }
    setState(() {
      if (result == null && dropped != null) {
        // Not sent: its paths are still offered as zips, in a new record
        // so the zip that was running is still let go.
        final now = _droppedFolders.putIfAbsent(id, () => []);
        now.insertAll(0, [
          for (final path in dropped)
            if (!now.contains(path)) path,
        ]);
      }
    });
  }

  /// New session in the reader's own Buddy chat's composer: the message
  /// starts its own thread's session. Greyed while it can't start, its hover
  /// saying why, as in a thread's reply box.
  Widget _chatSessionChoice(bool writable) {
    final id = c.selectedId;
    final blocked = c.threadSessionBlocked;
    return SuperTabComposerToggle(
      key: const ValueKey('super-chat-new-session'),
      on: _chatSessions.contains(id) && blocked == null,
      label: 'New session',
      hint: blocked ?? 'Starts a separate Buddy session for this message',
      onChanged: writable && blocked == null
          ? (on) => setState(
              () => on ? _chatSessions.add(id) : _chatSessions.remove(id),
            )
          : null,
    );
  }

  /// The project chosen for a New session, the last one on this device (task
  /// #2347), while the reader still reads it: one they lost is no longer
  /// chosen, and the session reads every project (security review 1 of #2437).
  /// None is a session that reads every project and sends to no PM (spec
  /// 2026-10-31-one-buddy-per-swarm).
  String? _chosenSessionProject() {
    final chosen = c.sessionProjectId;
    return c.snapshot?.projects.any((p) => p.id == chosen) == true
        ? chosen
        : null;
  }

  /// Where a New session in the reader's one Buddy chat works: every project
  /// they read, sending to no PM, or one project, whose PM it alone sends to.
  /// A quiet menu beside New session, shown while it is on.
  Widget _chatSessionProject(bool writable) {
    final projects = c.snapshot?.projects ?? const <SuperTabProject>[];
    final chosen = projects
        .where((p) => p.id == _chosenSessionProject())
        .firstOrNull;
    return AppDropdown(
      width: 300,
      children: [
        Tooltip(
          message: 'Reads every project you read. Sends no work to a PM.',
          child: AppMenuItem(
            key: const ValueKey('super-chat-session-any'),
            label: 'All projects · ask anything',
            selected: chosen == null,
            onPressed: () => c.chooseSessionProject(''),
          ),
        ),
        for (final project in projects)
          Tooltip(
            message: 'Reads only ${project.name}, and can hand work to its PM.',
            child: AppMenuItem(
              key: ValueKey('super-chat-session-in-${project.id}'),
              label: '${project.name} · ask and hand off work',
              selected: chosen?.id == project.id,
              onPressed: () => c.chooseSessionProject(project.id),
            ),
          ),
      ],
      builder: (context, menu, _) => Tooltip(
        message: 'Where this session works',
        child: InkWell(
          key: const ValueKey('super-chat-session-project'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          onTap: writable
              ? () => menu.isOpen ? menu.close() : menu.open()
              : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.badgeInset,
              vertical: grid.AppDesktop.listRowGap,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  chosen?.name ?? 'All projects',
                  style: DesktopChrome.metadata(),
                ),
                Icon(
                  AppIcons.chevronDown,
                  size: 12,
                  color: DesktopChrome.muted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// [path] as it goes into a message: as it is, or in double quotes when it
  /// holds a space or anything else a shell reads specially, with `"`, `\`,
  /// `$` and `` ` `` escaped, so it reads back as the same path.
  static String _pathText(String path) =>
      path.contains(RegExp(r'''[\s"'$`\\!*?\[\]{}()<>|&;]'''))
      ? '"${path.replaceAllMapped(RegExp(r'["\\$`]'), (m) => '\\${m[0]}')}"'
      : path;

  /// Puts dropped folders' paths into chat [id]'s message at the cursor,
  /// space-separated, as a terminal takes a dropped folder.
  void _pasteFolders(String id, List<String> paths) {
    if (!mounted) return;
    final shown = c.selectedId == id;
    final text = shown ? _composer.text : c.draft(id);
    final selection = shown && _composer.selection.isValid
        ? _composer.selection
        : TextSelection.collapsed(offset: text.length);
    final before = text.substring(0, selection.start);
    final after = text.substring(selection.end);
    final pasted =
        '${before.isEmpty || RegExp(r'\s$').hasMatch(before) ? '' : ' '}'
        '${paths.map(_pathText).join(' ')}'
        '${after.startsWith(RegExp(r'\s')) ? '' : ' '}';
    final next = before + pasted + after;
    c.setDraft(id, next);
    final dropped = _droppedFolders.putIfAbsent(id, () => []);
    setState(() => dropped.addAll(paths.where((p) => !dropped.contains(p))));
    if (!shown) return;
    _composer.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: before.length + pasted.length),
    );
    _focus.requestFocus();
  }

  /// The dropped folders whose paths are still in chat [id]'s message.
  List<String> _foldersInMessage(String id) => [
    for (final path in _droppedFolders[id] ?? const <String>[])
      if (_composer.text.contains(_pathText(path))) path,
  ];

  /// Whether an agent of [group] runs on another computer than this one,
  /// where a path dropped here means nothing.
  bool _agentsElsewhere(SuperTabConversation group) =>
      group.agentIds.any((agentId) {
        final agent = c.snapshot?.agent(agentId);
        return agent != null &&
            !(widget.isThisComputer?.call(agent.machineId) ?? false);
      });

  /// Attaches each of [folders] to chat [id]'s message as a zip in place of
  /// its path. A message sent meanwhile keeps its paths, and the zips are not
  /// attached to the next one.
  Future<void> _attachFoldersAsZip(String id, List<String> folders) async {
    final dropped = _droppedFolders[id];
    if (dropped == null || !_zipping.add(id)) return;
    setState(() {});
    final files = c.attachments(id);
    final zipped = <String, Uint8List>{};
    final oversized = <String>[], failed = <String>[];
    for (final folder in folders) {
      try {
        final bytes = await zipFolder(
          folder,
          limitBytes: kSuperTabFolderZipMaxBytes,
        );
        bytes == null || bytes.length > kSuperTabFolderZipMaxBytes
            ? oversized.add(
                bytes == null
                    ? folderName(folder)
                    : '${folderName(folder)}.zip',
              )
            : zipped[folder] = bytes;
      } on Exception {
        // Unreadable, or gone since the drop.
        failed.add(folderName(folder));
      }
    }
    if (!mounted) return;
    setState(() => _zipping.remove(id));
    if (!identical(_droppedFolders[id], dropped)) return;
    // Numbered, so two folders of one name are both attached.
    final added = zipped.isEmpty
        ? null
        : files.addPasted([
            for (final MapEntry(key: folder, value: bytes) in zipped.entries)
              HarnessAttachment('${folderName(folder)}.zip', bytes),
          ]);
    final problem = added ?? _folderZipsTooLarge(oversized);
    // Only a folder whose zip was taken gives up its path.
    final attached = [
      for (final MapEntry(key: folder, value: bytes) in zipped.entries)
        if (files.files.any((file) => identical(file.bytes, bytes))) folder,
    ];
    final shown = c.selectedId == id;
    var text = shown ? _composer.text : c.draft(id);
    for (final folder in attached) {
      final path = _pathText(folder);
      text = text.contains('$path ')
          ? text.replaceFirst('$path ', '')
          : text.contains(' $path')
          ? text.replaceFirst(' $path', '')
          : text.replaceFirst(path, '');
    }
    dropped.removeWhere(attached.contains);
    c.setDraft(id, text);
    if (shown && _composer.text != text) {
      _composer.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
    }
    setState(() {});
    reportAttachProblem(
      context,
      problem ??
          (failed.isEmpty ? null : '${failed.join(', ')} could not be zipped.'),
    );
  }

  /// What to say of the folders whose zips are over
  /// [kSuperTabFolderZipMaxBytes], or null for none.
  static String? _folderZipsTooLarge(List<String> names) {
    if (names.isEmpty) return null;
    const limit = '${kSuperTabFolderZipMaxBytes ~/ (1024 * 1024)} MB';
    return names.length == 1
        ? '${names.single} is over $limit.'
        : '${names.length} folders are over $limit.';
  }

  /// The box was edited: keep it as this chat's draft and drop the pick state.
  void _composerEdited(String text) {
    c.setDraft(c.selectedId, text);
    _mentionIndex.value = 0;
    _dismissedMention.value = null;
  }

  /// A line break at the cursor. The field only calls [_composerEdited] for
  /// edits that come from the platform, so this reports its own.
  void _insertNewline() => insertComposerNewline(_composer, _composerEdited);

  void _composerMoved() {
    if (!mounted) return;
    final value = _composer.value;
    final prefix = value.selection.isValid
        ? value.text.substring(0, value.selection.baseOffset)
        : null;
    if (_completionPrefix != prefix) _mentionIndex.value = 0;
    _completionPrefix = prefix;
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
    if (prefix == _dismissedMention.value) return null;
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
          leading: null,
          kind: null,
        );
      }).toList();
    }
    return _mentionChoices;
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
    _dismissedMention.value = text.substring(0, caret);
    _composer.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: caret),
    );
    _focus.requestFocus();
  }

  void _moveCompletion(int index) {
    _mentionIndex.value = index;
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

  ({int start, int end, String query})? get _mentionAtCursor =>
      superTabTagAtCaret(
        _composer.value,
        dismissed: _dismissedMention.value,
        tags: c.mentions(c.selectedId).values,
      );

  /// Who `@` offers here ([superTabTagChoices]).
  List<_ComposerChoice> get _mentionChoices {
    final mention = _mentionAtCursor;
    final group = c.selected;
    if (mention == null || group == null) return const [];
    return superTabTagChoices(
      c,
      group,
      mention.query,
      machineName: widget.machineName,
      choose: _chooseMention,
    );
  }

  void _chooseMention(String id, String name) {
    final at = _mentionAtCursor;
    if (at == null) return;
    final token = '@$name';
    final value = superTabInsertTag(_composer.value, at, token);
    c.setDraft(c.selectedId, value.text);
    c.mention(c.selectedId, id, token);
    _composer.value = value;
    _mentionIndex.value = 0;
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

  /// Near row [index] of [count]: the list measures only rows it built,
  /// from the top of what is read to its end.
  static double _estimate(ScrollPosition position, int index, int count) =>
      position.minScrollExtent +
      (position.maxScrollExtent - position.minScrollExtent) *
          (index + 1) /
          (count + 1);

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
        scroll.jumpTo(_estimate(position, index, entries.length));
        continue;
      }
      if ((top - anchor.top).abs() < .5) return;
      // The list's extent is an estimate until laid out there: only the
      // start bounds the jump, and the next frame measures the row again.
      scroll.jumpTo(
        (position.pixels + top - anchor.top).clamp(
          position.minScrollExtent,
          double.infinity,
        ),
      );
    }
  }

  Future<void> _groupAction(String action, SuperTabConversation group) async {
    final c = this.c;
    if (action == 'instructions') {
      final project = c.snapshot?.projectFor(group.id);
      if (project != null) {
        await showSuperTabInstructions(context, c, project.id);
      }
      return;
    }
    if (action == 'switch-pm') {
      final project = c.snapshot?.projectFor(group.id);
      if (project != null) await showSwitchPm(context, c, project.id);
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
                            !c.hiddenByBuddies(group) &&
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
                            : LaidOutListView(
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
    compact: _phone,
    app: widget.app,
    onNewProject: widget.onNewProject,
    onNewSwarm: widget.onNewSwarm,
    notificationsSelected: _notificationsVisible,
    attention: SuperTabAttention.of(c),
    activity: SuperTabActivity.of(c),
    onManage: _openManage,
    manageSelected: _manageOpen,
    // Activity on every platform (Lead, 10-31): the Mac's menu bar and Dock
    // still say what waits, and the sidebar lists it as Slack does.
    onNotifications: _openActivity,
    needsHuman: (group) => _needsHuman(group).length,
    onSelect: (id) {
      setState(() => _showNotifications = _showManage = _showTasks = false);
      // Choosing a conversation leaves the Manage pane: its Devices page left
      // the controller's flag set, so the sidebar's Manage row stayed lit while
      // a conversation was open.
      c.leaveDevices();
      c.select(id);
      _closeSidebar();
    },
    onOpenBuddyChat: (projectId) => unawaited(_openBuddyChat(projectId)),
  );

  /// Opens the reader's Buddy chat in [projectId] in front of Notifications,
  /// pull requests and a terminal, opening it on the server when they have
  /// none yet: the sidebar's way in and ⇧⌘K's
  /// ([SuperTabController.buddyChatOpener]).
  Future<bool> _openBuddyChat(String projectId) {
    c.leaveDevices();
    setState(() {
      _showNotifications = _showManage = false;
      _showPullRequests = _showTasks = false;
    });
    widget.onCloseTerminal?.call();
    _closeSidebar();
    return c.openBuddyChat(projectId);
  }

  /// What the menu bar asked to open ([SuperTabController.openNotice]): a tag
  /// at its message, a decision on the Notifications page where it is answered.
  void _takeNotice() {
    final request = c.noticeRequest;
    if (request == null || c.snapshot == null) return;
    c.noticeRequest = null;
    widget.onCloseTerminal?.call();
    setState(() {
      _showNotifications = true;
      _showManage = false;
      _showPullRequests = _showTasks = false;
    });
    if (request.kind != 'mention') return;
    final mention = SuperTabMentions.of(c).waiting
        .where((m) => m.id == request.id)
        .firstOrNull;
    if (mention != null) unawaited(_openMention(mention));
  }

  /// Shows Activity in the main pane, as its sidebar row does. [from] is the
  /// controller the asking widget was built for: a press arriving once the
  /// view has moved to another Swarm opens nothing.
  void _openActivity({SuperTabController? from}) {
    if (!mounted || (from != null && from != c)) return;
    _closeSidebar();
    c.leaveDevices();
    setState(() {
      _showNotifications = true;
      _showManage = false;
      _showPullRequests = _showTasks = false;
    });
    widget.onCloseTerminal?.call();
  }

  bool get _notificationsVisible =>
      _showNotifications && !_devicesVisible && !c.accessRevoked;

  /// Activity or Manage holds the main pane, with no chat header.
  bool get _listViewHoldsThePane => _notificationsVisible || _manageVisible;

  bool get _manageVisible =>
      _showManage &&
      !_showNotifications &&
      !_devicesVisible &&
      !c.accessRevoked;

  /// Manage shows, on any of its pages: Devices is one of them, however it
  /// was opened.
  bool get _manageOpen => _manageVisible || _devicesVisible;

  bool get _hasDevices => widget.app?.devicesEnabled == true;

  /// The sidebar's Manage, on the page it last showed.
  void _openManage() {
    _closeSidebar();
    setState(() {
      _showManage = true;
      _showNotifications = _showPullRequests = _showTasks = false;
      if (_manageTab == SuperTabManageTab.devices && !_hasDevices) {
        _manageTab = SuperTabManageTab.machines;
      }
    });
    if (_manageTab == SuperTabManageTab.devices) widget.app!.openDevices();
  }

  void _chooseManageTab(SuperTabManageTab tab) {
    setState(() {
      _showManage = true;
      _manageTab = tab;
    });
    if (tab == SuperTabManageTab.devices) {
      widget.app!.openDevices();
    } else {
      c.leaveDevices();
    }
  }

  /// Opens [root]'s thread in its chat from Activity's New replies.
  void _openThreadFromList(String conversationId, String root) {
    if (_openConversation(conversationId)) c.openThread(root);
  }

  /// Opens chat [conversationId] from a row of Activity; false when it is
  /// gone or the reader's access is.
  bool _openConversation(String conversationId) {
    if (c.accessRevoked || c.snapshot?.conversation(conversationId) == null) {
      return false;
    }
    widget.onCloseTerminal?.call();
    _closeSidebar();
    setState(() {
      _showNotifications = _showManage = false;
      _showPullRequests = _showTasks = false;
    });
    c.select(conversationId);
    return true;
  }

  /// [messageId] of [id], read from the pages held, then what arrived after
  /// them, then older pages, up to 50 (5,000 messages); null when it is not
  /// among them. A message newer than what was read earlier is after it, so
  /// the first read is up to the latest, its own even with a poll's read under
  /// way (that one may hold rows below a reader scrolled up); the rest go back.
  Future<SuperTabMessage?> _findMessage(String id, String messageId) async {
    SuperTabMessage? held() =>
        c.messages(id).where((m) => m.id == messageId).firstOrNull;
    var message = held();
    for (var page = 0; message == null && page < 50; page++) {
      final older = page > 0;
      if (older && !c.hasOlder(id)) break;
      await (older ? c.loadMessages(id, older: true) : c.showLatest(id));
      if (!mounted) return null;
      message = held();
    }
    return message;
  }

  /// The date pill's choice (day_jump.dart): [id]'s first message on or
  /// after [from], lit, as a link opens one. The very beginning (null) is
  /// its first message, and a time after everything said is its newest.
  /// Older pages are read until one from before [from] is held, at most 50
  /// as a link reads; past them it says so, and the list stays.
  Future<void> _jumpToTime(String id, DateTime? from) async {
    void say(String text) =>
        ScaffoldMessenger.maybeOf(context)
            ?.showSnackBar(SnackBar(content: Text(text)));
    final request = ++_jumpRequest;
    bool current() =>
        mounted &&
        request == _jumpRequest &&
        c.selectedId == id &&
        !c.accessRevoked;
    bool before(SuperTabMessage m) =>
        from != null && (m.createdAt?.isBefore(from) ?? false);
    try {
      if (from == null) {
        await c.loadBackTo(id, 0);
      } else {
        // A copy read back to an early page holds nothing from then on: the
        // latest first, then back from there.
        final newest = _shownMessages(id).lastOrNull;
        if (c.hasNewer(id) && (newest == null || before(newest))) {
          await c.showLatest(id);
        }
        for (var page = 0; !_shownMessages(id).any(before); page++) {
          if (!current() || !c.hasOlder(id)) break;
          if (page == 50) {
            say('That day is too far back to open.');
            return;
          }
          // A read that fails keeps its error and its place: nothing came.
          final loaded = c.messages(id).length;
          await c.loadMessages(id, older: true);
          if (current() && c.messages(id).length == loaded) {
            say('Couldn’t load earlier messages.');
            return;
          }
        }
      }
    } catch (_) {
      if (current()) say('Messages could not be read.');
      return;
    }
    if (!current()) return;
    final shown = _shownMessages(id);
    final target = from == null
        ? shown.firstOrNull
        : shown.where((m) => !before(m)).firstOrNull ?? shown.lastOrNull;
    if (target == null) return;
    final row = _rowShowing(id, target.id) ?? target.id;
    setState(() {
      _target = row;
      // Stop following the end: that day's message is what to see.
      _scrollRequest++;
      _jumpingToEnd = false;
      _follow(id, false);
    });
    _revealTarget(
      id,
      0,
      arrived: (at) {
        unawaited(Scrollable.ensureVisible(at, alignment: .3));
        _light(row);
      },
    );
    _focus.requestFocus();
  }

  /// What the reader asked to open by a message link ([SuperTabController.openMessageLink]).
  void _takeMessageRequest() {
    final request = c.messageRequest;
    if (request == null || c.snapshot == null) return;
    c.messageRequest = null;
    unawaited(_openMessage(request.conversationId, request.messageId));
  }

  /// Opens [id] at [messageId], lit. The backend decides what this reader may
  /// read, so a message they may not read and one that is gone are both
  /// "unavailable", with nothing of the conversation shown.
  Future<void> _openMessage(String id, String messageId) async {
    void say(String text) =>
        ScaffoldMessenger.maybeOf(context)
            ?.showSnackBar(SnackBar(content: Text(text)));
    final request = ++_jumpRequest;
    // A closed conversation is asked for by id: the backend says whether this
    // reader may read it, and a refusal looks like a message that is gone.
    final readable = await c.loadGroup(id);
    if (!mounted || request != _jumpRequest || c.accessRevoked) return;
    // The app may open another chat for it (an old Chat with PM, with Buddies
    // on): that is not this message, so the reader stays where they are.
    if (!readable || c.landsOn(id) != id) {
      say('Message unavailable');
      return;
    }
    final message = await _findMessage(id, messageId);
    if (!mounted ||
        request != _jumpRequest ||
        c.accessRevoked ||
        c.snapshot?.conversation(id) == null) {
      return;
    }
    if (message == null) {
      say(
        c.hasOlder(id)
            ? 'This message is too far back to open.'
            : 'Message unavailable',
      );
      return;
    }
    widget.onCloseTerminal?.call();
    _closeSidebar();
    c.select(id);
    // A thread reply opens its thread; one shown only there has no row in the
    // chat to scroll to.
    if (message.threadReply) {
      c.openThread(message.thread!);
      if (!message.inMainStream) return;
    }
    final shownBy = _rowShowing(id, messageId) ?? messageId;
    setState(() {
      _showNotifications = _showManage = false;
      _showPullRequests = _showTasks = false;
      _back = null;
      _target = shownBy;
      _openedAtMessage = id;
      // Stop following the end: the linked message is what to see.
      _scrollRequest++;
      _jumpingToEnd = false;
      _follow(id, false);
    });
    _revealTarget(
      id,
      0,
      arrived: (row) {
        unawaited(Scrollable.ensureVisible(row, alignment: .3));
        _light(messageId);
      },
    );
    _focus.requestFocus();
  }

  /// The Swarms of the account a link may point into, besides this one.
  late final SwarmLinkSwarms? _linkSwarms =
      widget.linkSwarms ??
      (widget.app == null ? null : AppLinkSwarms(widget.app!));

  /// The other Swarms' controllers this view hears from, for their previews.
  final _linkSources = <SuperTabController>{};

  void _linkSourceChanged() {
    if (mounted) setState(() {});
  }

  /// The controller that reads [tabId] for a preview: this Swarm's, or one
  /// already loaded here. None is loaded for a preview, so a Swarm the account
  /// closed is never left polling.
  SuperTabController? _linkSource(String tabId) {
    if (tabId == c.tabId) return c;
    final other = _linkSwarms?.loaded(tabId);
    if (other != null && _linkSources.add(other)) {
      other.addListener(_linkSourceChanged);
    }
    return other;
  }

  /// What [link] points at for the preview under a message that says it. The
  /// Swarm it names reads it with its own session, so the server decides.
  SuperTabLinkTarget _linkTarget(SwarmMessageLink link) {
    final controller = _linkSource(link.tabId);
    if (controller == null) {
      return _linkSwarms?.read(link, _linkSourceChanged) ??
          const SuperTabLinkTarget.unavailable();
    }
    final target = controller.linkTarget(link);
    if (target == null) return const SuperTabLinkTarget.unavailable();
    final message = target.message;
    if (message == null) return const SuperTabLinkTarget.loading();
    return SuperTabLinkTarget.message(
      message,
      author: _shownAuthor(controller, message),
    );
  }

  /// Opens [link]: here, or in the other Swarm of the account it names.
  void _openLink(SwarmMessageLink link) {
    if (link.tabId == c.tabId) {
      c.openMessageLink(link);
      return;
    }
    final swarms = _linkSwarms;
    final opened = swarms?.open(link) ?? Future.value(false);
    unawaited(
      opened.then((ok) {
        if (ok || !mounted) return;
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(const SnackBar(content: Text('Message unavailable')));
      }),
    );
  }

  /// Opens the conversation a tag is in, at its message, replying to it. What
  /// is held is looked in first, then what arrived after it, then older pages,
  /// until the message is among them; one that is not found says so, and the
  /// list stays.
  Future<void> _openMention(SuperTabMention mention) =>
      _openAtMessage(mention.conversationId, mention.messageId, answer: true);

  /// More ▸ Remind me: the message comes back in Activity at [when].
  Future<void> _remind(SuperTabMessage message, SuperTabRemindIn when) async {
    final at = when.from(clock.now());
    final kept = await SuperTabReminders.of(c).set(message, at);
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(
          kept
              ? 'Reminder set for ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(at))}'
              : "Couldn't set the reminder",
        ),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  /// A due reminder opened from Activity: its message, which clears it.
  Future<void> _openReminder(SuperTabReminder reminder) async {
    unawaited(SuperTabReminders.of(c).open(reminder));
    await _openAtMessage(
      reminder.conversationId,
      reminder.messageId,
      answer: false,
    );
  }

  /// Opens conversation [id] at message [messageId], from Activity; [answer]
  /// replies to it (a tag).
  Future<void> _openAtMessage(
    String id,
    String messageId, {
    required bool answer,
  }) async {
    final request = ++_jumpRequest;
    // A closed or quiet conversation is asked for by id, as a message link does: the tag of a task with no worker is in one,
    // and a row that did nothing left the reader not knowing why it was there.
    final readable =
        c.snapshot?.conversation(id) != null || await c.loadGroup(id);
    if (!mounted || request != _jumpRequest || c.accessRevoked) return;
    if (!readable || c.snapshot?.conversation(id) == null) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(const SnackBar(content: Text('Message unavailable')));
      return;
    }
    final message = await _findMessage(id, messageId);
    if (!mounted || request != _jumpRequest) return;
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
    // A tag in a thread opens the thread; one in a thread reply shown only
    // there is not in the chat to scroll to.
    if (message.thread case final root?) {
      c.openThread(root);
      if (!message.inMainStream) return;
    }
    setState(() {
      if (answer &&
          c.canWrite &&
          c.selected?.archived == false &&
          message.thread == null) {
        _replies[id] = message;
      }
      _target = message.id;
      _openedAtMessage = id;
      // Stop following the end: the tagged message is what to see.
      _scrollRequest++;
      _jumpingToEnd = false;
      _follow(id, false);
    });
    _revealTarget(id, 0);
    _focus.requestFocus();
  }

  /// The list is lazy: jump near the target until its row is built, then
  /// bring it into view, or hand its row to [arrived] to place it. Until it
  /// has landed or given up, the New messages line is not measured.
  void _revealTarget(
    String id,
    int attempt, {
    void Function(BuildContext row)? arrived,
    int? landing,
  }) {
    landing ??= _landing = ++_landings;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (c.selectedId != id || _target == null) return _landed(landing!);
      if (_targetKey.currentContext case final target?) {
        if (arrived != null) {
          arrived(target);
        } else {
          unawaited(Scrollable.ensureVisible(target, alignment: .3));
        }
        return _landed(landing!);
      }
      final scroll = _scroll[id];
      final entries = superTabTranscriptEntries(_shownMessages(id));
      final index = entries.indexWhere((e) => e.message.id == _target);
      if (scroll == null || !scroll.hasClients || index < 0 || attempt > 20) {
        return _landed(landing!);
      }
      scroll.jumpTo(_estimate(scroll.position, index, entries.length));
      _revealTarget(id, attempt + 1, arrived: arrived, landing: landing);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// Jump [landing] is over: the line is measured where the list lays out
  /// next, unless a newer jump has started.
  void _landed(int landing) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _landing != landing) return;
      _landing = null;
      _checkUnreadLine();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// The messages [id]'s list shows, in order.
  /// A thread reply shows in its thread, and here only when also sent.
  List<SuperTabMessage> _shownMessages(String id, {bool replies = false}) {
    final messages = c.taskMessages(id);
    final answered = answeredPromptAlerts(
      messages,
      (agentId) => c.snapshot?.agent(agentId),
    );
    return messages
        .where(
          (m) =>
              _shown(m) &&
              (replies || m.inMainStream) &&
              !answered.contains(m.id),
        )
        .toList();
  }

  /// [id]'s own rows as its list shows them: without its steps' rows, which
  /// are numbered in their own conversations (task steps design).
  List<SuperTabMessage> _ownShown(String id) => [
    for (final m in _shownMessages(id))
      if (m.conversationId == id) m,
  ];

  /// What people never read in a chat, in the list and as a reply's quote: a
  /// message waiting for an agent, notices older backends stored, the PM's own
  /// notices about the work (backend NOTICE_READERS).
  static const _neverShown = {
    'delivery-hold',
    'work-stalled',
    'work-lost',
    'work-resumed',
    'idle-stop',
    'idle',
    'review-failed',
    'update-request',
    'digest-request',
    'overlap',
    'pair-loop',
    'notice-digest',
  };

  static bool _shown(SuperTabMessage m) =>
      !_neverShown.contains(m.source['kind']);

  /// The row of [id]'s list that shows [messageId]: its own, or the notice
  /// that folds it in. Null while the message is not loaded.
  String? _rowShowing(String id, String messageId) {
    final message = _shownMessages(id)
        .where((m) => m.id == messageId)
        .firstOrNull;
    if (message == null) return null;
    // A step's row is a row of its own: no notice of the task folds it in.
    if (message.conversationId != id) return message.id;
    final shown = _ownShown(id);
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
      _follow(id, false);
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
            scroll.position.minScrollExtent,
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

  /// What the card over [message]'s name or avatar shows, worked out as it
  /// opens (Huy, 11-04): a person's status and zone; an agent's engine and
  /// model, machine and task, as its details dialog reads them.
  SuperTabIdentityFacts _identityFacts(
    SuperTabMessage message,
    SuperTabAgent? agent,
  ) {
    final name = c.snapshot?.authorName(message) ?? message.authorName;
    if (agent == null) {
      if (message.fromAgent) return SuperTabAgentFacts(name);
      final person = _people[message.authorId];
      return SuperTabPersonFacts(
        person?.shownName ?? name,
        status: person?.statusAt(clock.now()),
        timeZone: person?.timeZone,
      );
    }
    final info = SuperTabAgentInfo(c, widget.app, agent);
    final place = c.snapshot?.placeOf(agent.machineId) ?? agent.machineId;
    final device = superTabMap(
      superTabMap(c.snapshot?.pool(place)?['observation'])['resources'],
    )['deviceType'];
    final group = info.taskGroup;
    return SuperTabAgentFacts(
      agent.displayName ?? name,
      engine: agent.engine,
      model: info.model,
      machine: superTabMachineName(
        info.machine ?? widget.machineName(agent.machineId),
      ),
      deviceType: device is String ? device : null,
      task: group == null ? null : _taskLine(info, group),
      onOpenTask: group == null ? null : () => _openGroup(group.id),
    );
  }

  /// What the agent does with [group], its number and title in place of the
  /// quoted title: "Working on #2605 Chat: a card…".
  static String _taskLine(SuperTabAgentInfo info, SuperTabConversation group) {
    final named = switch (group.number) {
      final number? => '#$number ${group.title}',
      null => group.title,
    };
    final status = info.status;
    final quoted = '"${group.title}"';
    return status != null && status.contains(quoted)
        ? status.replaceFirst(quoted, named)
        : named;
  }

  void _openGroup(String id) {
    setState(() => _showPullRequests = false);
    c.select(id);
    c.selectTerminal(id, null);
  }

  void _openAgent(SuperTabAgent agent) {
    setState(() {
      _showPullRequests = _showTasks = false;
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

  /// The reader's own chat with their Buddy.
  bool _isBuddyChat(SuperTabConversation group) =>
      c.buddyChat(group.projectId)?.id == group.id;

  /// The name of the reader's Buddy that [group] is the chat with: the name
  /// they chose while it has none (removed, or starting), else "your Buddy".
  /// Null when [group] is no Buddy chat of the reader's.
  String? _buddyName(SuperTabConversation? group) {
    if (group == null || !_isBuddyChat(group)) return null;
    final agent = c.buddy(group.projectId);
    return agent == null
        ? group.buddyName ?? 'your Buddy'
        : c.snapshot!.agentName(agent.id, fallback: agent.name);
  }

  /// The open conversation's name, or what the pane shows instead of one,
  /// named as the sidebar names it: "# openharness", or a workgroup's
  /// [SuperTabWorkgroupName].
  Widget _title(SuperTabConversation? group) {
    final style = DesktopChrome.text(medium: true);
    final project = group == null ? null : c.snapshot?.projectFor(group.id);
    final name = _manageOpen
        ? 'Manage'
        : _notificationsVisible
        ? 'Activity'
        : group == null
        ? c.snapshot?.projects.isEmpty == true
              ? c.snapshot!.name
              : 'Choose a project'
        : _groupName(group);
    if (name == null) return SuperTabWorkgroupName(group!, style: style);
    if (group != null &&
        c.snapshot!.isProjectLead(group.id) &&
        !_devicesVisible &&
        !_listViewHoldsThePane) {
      return _projectMenu(group, name, style);
    }
    if (group != null &&
        c.snapshot!.isProjectLead(group.id) &&
        project!.isPrivate) {
      return Text.rich(
        TextSpan(
          children: [
            WidgetSpan(
              alignment: PlaceholderAlignment.middle,
              child: PrivateProjectLock(
                size: AppIcons.inlineSize,
                color: DesktopChrome.muted,
              ),
            ),
            TextSpan(text: ' $name', style: style),
          ],
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      );
    }
    return Text(
      name,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );
  }

  /// [group]'s name as the sidebar names it: "# openharness", a Buddy chat's;
  /// null for a workgroup, named by [SuperTabWorkgroupName].
  String? _groupName(SuperTabConversation group) =>
      c.snapshot!.isProjectLead(group.id)
      ? switch (c.snapshot!.projectFor(group.id)!) {
          final project => '${project.isPrivate ? '' : '# '}${project.name}',
        }
      // An older Buddy chat in a project says which, as the menu that opens
      // it does; the one Buddy chat is the sidebar's # buddy.
      : c.isEarlierBuddyChat(group)
      ? 'Earlier Buddy chat · ${c.snapshot!.projects.where((p) => p.id == group.projectId).firstOrNull?.name ?? 'a project'}'
      : _buddyName(group) == null
      ? null
      : group.isSwarmBuddyChat
      ? 'Buddy'
      : c.buddy(group.projectId) == null && group.buddyName == null
      ? 'Your Buddy'
      : '${_buddyName(group)} · Your Buddy';

  /// The pictures [messages] show in place, oldest first, each with its
  /// sender as its row shows them and where it was posted, for the viewer.
  List<SuperTabImageItem> _images(List<SuperTabMessage> messages) {
    final group = c.selected;
    final place = group == null
        ? null
        : _groupName(group) ?? SuperTabWorkgroupName.plain(group);
    return [
      for (final message in messages)
        for (final file in message.attachments)
          if (SuperTabFileRef(
                file,
                conversationId: message.conversationId,
                messageId: message.id,
                fresh: widget.controller.readFileLink,
              )
              case final ref when superTabShowsInPlace(ref))
            SuperTabImageItem(
              ref: ref,
              sender: _shownAuthor(c, message),
              avatar: superTabMessageAvatar(
                message,
                author: _shownAuthor(c, message),
                agent: message.fromAgent
                    ? c.snapshot?.agent(message.authorId)
                    : null,
                person: message.fromAgent ? null : _people[message.authorId],
                size: _viewerAvatar,
              ),
              postedAt: message.createdAt,
              place: place,
              onShowInChat: () =>
                  unawaited(_openMessage(message.conversationId, message.id)),
            ),
    ];
  }

  static const _viewerAvatar = 32.0;

  /// The pictures open in the viewer, in the conversation (and thread) they
  /// were opened in; another one closes it.
  ({
    String? conversationId,
    String? thread,
    List<SuperTabImageItem> images,
    int index,
  })?
  _viewing;

  void _openImages(
    List<SuperTabImageItem> images,
    int index, {
    String? thread,
  }) => setState(
    () => _viewing = (
      conversationId: c.selectedId,
      thread: thread,
      images: images,
      index: index,
    ),
  );

  void _closeImages() => setState(() => _viewing = null);

  /// The open viewer, while its conversation and thread still are.
  Widget? _imageViewer() {
    final viewing = _viewing;
    if (viewing == null) return null;
    if (viewing.conversationId != c.selectedId ||
        (viewing.thread != null && c.openedThread?.root != viewing.thread)) {
      _viewing = null;
      return null;
    }
    return SuperTabImageViewer(
      key: ObjectKey(viewing),
      images: viewing.images,
      index: viewing.index,
      onClose: _closeImages,
    );
  }

  /// The composer's hint, naming the open conversation as its sidebar row
  /// does: "Message #openharness", "Message Wren".
  String _messageHint(SuperTabConversation group) {
    final snapshot = c.snapshot!;
    if (snapshot.isProjectLead(group.id)) {
      final project = snapshot.projectFor(group.id)!;
      return 'Message ${project.isPrivate ? project.name : '#${project.name}'}';
    }
    if (_buddyName(group) case final buddy?) {
      // A Buddy's name is its person's and long: a phone's one line says Buddy.
      return _phone ? 'Message Buddy' : 'Message $buddy';
    }
    return 'Message ${group.title}';
  }

  /// On a phone the header's bar holds Chat and ⋮, each a finger's size, and
  /// ⋮ names the rest (terminals, pull requests, people) instead of five bare
  /// icons. Desktop, which sets no [WorkspaceChrome.compactBelow], never.
  bool get _phone => workspaceIsCompact(context);

  /// Keeps the field mounted when a phone turns past the compact width: a
  /// remounted field keeps focus but loses its text input connection.
  final _composerFieldKey = GlobalKey();

  /// The height above the keyboard below which a phone's composer keeps one row.
  static const _phoneComposerTwoRowsFrom = 320.0;

  /// The lines a phone's field may grow to with [room] above the keyboard: 5,
  /// less what the header and the actions need on a small phone, whose pane
  /// overflowed otherwise (320x568 with a 216 px keyboard, review of #2583).
  /// Never 1: a field of one line is single-line, which strips line breaks
  /// from a draft ("one\ntwo" became "onetwo", test of #2583).
  int _phoneComposerLines(double room) {
    final line = MediaQuery.textScalerOf(context).scale(20);
    return ((room - 275) / line).floor().clamp(2, 5);
  }

  /// The composer's field and its controls, as on the phone (Huy and Scholes,
  /// 11-04): the field on top with the width, and one row under it with
  /// [attach] (+), [tag] (@ Tag) and [options] (New session) at the left, and
  /// [trailing] (the mic) and [send] at the right. Send keeps the box's
  /// bottom-right corner however long the message (Scholes, 11-03).
  Widget _composerLayout({
    required double room,
    required Widget field,
    required Widget attach,
    required Widget tag,
    required List<Widget> options,
    required List<Widget> trailing,
    required Widget send,
    Widget? voice,
  }) {
    // Too little height for a second row (a phone on its side with its keyboard
    // up): the actions take the row's end. A narrow phone with so little
    // height gets the squeezed row, which beats a composer that overflows; it
    // has no room for @ Tag there, and an @ typed still opens the list.
    if (_phone && room < _phoneComposerTwoRowsFrom && voice == null) {
      return ConstrainedBox(
        constraints: BoxConstraints(
          minHeight: grid.AppControl.heightFieldScaled,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(child: field),
            attach,
            ...options,
            ...trailing,
            send,
          ],
        ),
      );
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(
            right: grid.AppDesktop.controlGap,
            bottom: grid.AppDesktop.controlGap,
          ),
          child: field,
        ),
        // A voice message under way takes the row's place (#2665).
        voice ??
            Row(
              key: const ValueKey('super-message-composer-actions'),
              children: [
                attach,
                tag,
                Expanded(
                  child: Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: options,
                  ),
                ),
                ...trailing,
                send,
              ],
            ),
      ],
    );
  }

  /// @ Tag: `@` at the caret, reported as an edit so the tag list opens.
  void _promptTag() {
    _composer.value = superTabTagPrompt(_composer.value);
    _composerEdited(_composer.text);
    _focus.requestFocus();
  }

  /// Whether ⋮ carries the views a wider header draws as icons.
  bool get _menuNamesViews =>
      _phone && !_devicesVisible && !_listViewHoldsThePane;

  /// How many terminals [group]'s [term] opens: its agents' (a project chat's
  /// coordinator alone), and in the person's own Personal Swarm their panes of
  /// its project.
  int _terminalCount(SuperTabConversation group) =>
      (c.snapshot?.paneAgentIds(group.id) ?? group.agentIds).length +
      switch (widget.app) {
        final app? => PersonalProjects.of(app).panesFor(c, group.id).length,
        null => 0,
      };

  /// How many of the person's own panes a project of their Personal Swarm
  /// holds (personal_projects.dart); none elsewhere.
  int _personalPaneCount(SuperTabConversation group) =>
      c.snapshot?.isProjectLead(group.id) == true
      ? switch (widget.app) {
          final app? => PersonalProjects.of(app).panesFor(c, group.id).length,
          null => 0,
        }
      : 0;

  /// A Personal project's empty chat when it holds panes: the panes are behind
  /// the header's terminals button, so the empty view says so and opens them
  /// (Huy, 11-03: # scratch looked empty with four panes in it).
  Widget _panesWaiting(SuperTabConversation group) {
    final count = _personalPaneCount(group);
    return EmptyState(
      icon: AppIcons.terminal,
      title: count == 1
          ? '1 pane in this project'
          : '$count panes in this project',
      message:
          'Discuss the plan with ${c.snapshot!.coordinatorNameOf(group.projectId)}.',
      action: OutlinedButton(
        key: const ValueKey('super-project-show-panes'),
        onPressed: _openTerminals(group),
        child: const Text('Show panes'),
      ),
    );
  }

  /// Opens the group's terminals beside the chat; null when it has none this
  /// reader may open (a read-only viewer's terminal reads are refused).
  VoidCallback? _openTerminals(SuperTabConversation group) =>
      _terminalCount(group) > 0 && c.canWrite
      ? () {
          setState(() => _showPullRequests = _showTasks = false);
          widget.onOpenGroupTerminals?.call();
        }
      : null;

  void _openPullRequests() {
    widget.onCloseTerminal?.call();
    setState(() {
      _showPullRequests = true;
      _showTasks = false;
    });
  }

  /// Opens [group]'s project's Tasks view; from a task's chat, its project's
  /// chat is selected under it.
  void _openTasks(SuperTabConversation group) {
    final project = c.snapshot?.projectById(group.projectId);
    if (project == null) return;
    widget.onCloseTerminal?.call();
    if (c.selectedId != project.leadConversationId) {
      unawaited(c.select(project.leadConversationId));
    }
    setState(() {
      _showTasks = true;
      _showPullRequests = false;
    });
  }

  /// A task's chat, opened from its card: read first when it is one of the
  /// shipped tasks only the Tasks view holds.
  Future<void> _openTask(String id) async {
    if (!await c.loadGroup(id) || !mounted) return;
    _openConversation(id);
  }

  /// How many of [project]'s tasks need the reader: the Tasks icon's count.
  int _tasksNeedingYou(SuperTabProject project) => superTabTasksNeedingYouIn(
    superTabProjectBoard(
      c,
      project,
      now: clock.now(),
      needsHuman: (g) => _needsHuman(g).length,
    ),
  );

  /// The open project's Tasks view, while it holds the pane.
  Widget _tasksPage() {
    final project = _showTasks
        ? c.snapshot?.projectById(c.selected?.projectId ?? '')
        : null;
    if (project == null) return const SizedBox.shrink();
    return SuperTabTasksView(
      key: ValueKey('super-tasks-${project.id}'),
      controller: c,
      project: project,
      storage: widget.app?.localStore,
      needsHuman: (g) => _needsHuman(g).length,
      onOpenTask: (id) => unawaited(_openTask(id)),
      onOpenProposal: (id) =>
          _openThreadFromList(project.leadConversationId, id),
    );
  }

  /// The Tasks icon of a project's header and of its tasks' (Dee, task
  /// #2569): selected while the board shows, and in a task opened from it;
  /// its red count is the tasks that need the reader, none at 0.
  Widget _tasksButton(SuperTabConversation group, {required bool task}) {
    final project = c.snapshot!.projectById(group.projectId)!;
    final selected = task || (_showTasks && !_terminalsVisible);
    final count = _tasksNeedingYou(project);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        fingerTarget(
          enabled: _phone,
          AppIconButton(
            key: const ValueKey('super-tasks'),
            icon: AppIcons.squareKanban,
            size: AppIcons.inlineSize,
            tooltip: 'Tasks',
            selected: selected,
            color: selected ? DesktopChrome.foreground : DesktopChrome.muted,
            onPressed: () => _openTasks(group),
          ),
        ),
        if (count > 0)
          SuperTabCountBadge(
            count,
            key: const ValueKey('super-tasks-badge'),
            tooltip: count == 1 ? '1 task needs you' : '$count tasks need you',
          ),
      ],
    );
  }

  /// Members takes the right side from an open thread, as in Slack.
  void _toggleRoster() {
    if (!_rosterOpen) c.closeThread();
    setState(() {
      _rosterOpen = !_rosterOpen;
    });
  }

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
  /// group's linked tasks.
  Widget? _subtitle(SuperTabConversation? group) {
    final line = c.linkedLine(group);
    final linked = line == null
        ? null
        : Text(
            line,
            key: const ValueKey('super-linked-line'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(),
          );
    final view = _openViewName;
    if (view == null) return linked;
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
        if (linked != null) ...[
          Text(' · ', style: DesktopChrome.metadata()),
          Flexible(child: linked),
        ],
      ],
    );
  }

  Widget _header(SuperTabConversation? group, bool narrow) {
    final isProject =
        group != null && c.snapshot?.isProjectLead(group.id) == true;
    // The one Buddy has one chat, as a project does; it has no pull requests.
    final oneBuddy = group?.isSwarmBuddyChat == true;
    final restsOnChat = isProject || oneBuddy;
    // A project's task: its header leads back to the board it came from.
    final isTask =
        group != null &&
        !isProject &&
        !oneBuddy &&
        !group.isBuddyChat &&
        c.snapshot?.projectById(group.projectId) != null;
    return Container(
      constraints: const BoxConstraints(minHeight: 52),
      // A phone's rows line up (Huy, 2026-11-02): the sidebar icon starts at
      // the top bar's edge, and the people icon sits under its avatar.
      padding: _phone
          ? kPhoneBarRowPadding
          : const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
      ),
      child: Row(
        children: [
          if (narrow)
            fingerTarget(
              enabled: _phone,
              AppIconButton(
                icon: AppIcons.menu,
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
                  if (!_devicesVisible && !_listViewHoldsThePane)
                    ?_subtitle(group),
                ],
              ),
            ),
          ),
          if (group != null && !_devicesVisible && !_listViewHoldsThePane) ...[
            // A project's chat is where its header rests: the button back
            // to it shows only from another view (Quiet Swarm, screen 1).
            if (!restsOnChat ||
                _terminalsVisible ||
                _showPullRequests ||
                _showTasks)
              fingerTarget(
                enabled: _phone,
                AppIconButton(
                  key: const ValueKey('super-chat'),
                  icon: AppIcons.messageSquare,
                  size: AppIcons.inlineSize,
                  tooltip: 'Chat',
                  selected:
                      !_terminalsVisible && !_showPullRequests && !_showTasks,
                  color: !_terminalsVisible && !_showPullRequests && !_showTasks
                      ? DesktopChrome.foreground
                      : DesktopChrome.muted,
                  onPressed: () {
                    setState(() => _showPullRequests = _showTasks = false);
                    widget.onCloseTerminal?.call();
                    _readVisibleTailAfterFrame();
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted) _focus.requestFocus();
                    });
                  },
                ),
              ),
            if (isProject || !_menuNamesViews) ...[
              const SizedBox(width: 4),
              fingerTarget(
                enabled: _phone,
                AppIconButton(
                  key: const ValueKey('super-terminals'),
                  icon: AppIcons.terminal,
                  size: AppIcons.inlineSize,
                  tooltip: 'Group terminals (${_terminalCount(group)})',
                  selected: _terminalsVisible,
                  color: _terminalsVisible
                      ? DesktopChrome.foreground
                      : DesktopChrome.muted,
                  onPressed: _openTerminals(group),
                ),
              ),
            ],
            if (isProject || isTask) ...[
              const SizedBox(width: 4),
              _tasksButton(group, task: isTask),
            ],
            if (!isProject) ...[
              if (!_menuNamesViews && !oneBuddy) ...[
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
              fingerTarget(
                enabled: _phone,
                _options(group, views: _menuNamesViews),
              ),
            ],
          ],
          // The right column opens only from here (Quiet Swarm, Dee,
          // 2026-11-02): closed at rest, at every width.
          if (group != null &&
              !_listViewHoldsThePane &&
              !oneBuddy &&
              !_devicesVisible)
            fingerTarget(
              enabled: _phone,
              AppIconButton(
                key: const ValueKey('super-members-button'),
                icon: AppIcons.users,
                tooltip: 'Members',
                selected: _rosterOpen,
                onPressed: _toggleRoster,
              ),
            ),
        ],
      ),
    );
  }

  /// These menus' width.
  static const double _menuWidth = 220;

  /// A menu's row: the app's one menu row ([AppMenuItem]), a finger's height
  /// on a phone.
  Widget _menuItem(
    String label,
    VoidCallback? action, {
    Key? key,
    bool finger = false,
    Widget? trailing,
    bool selected = false,
  }) => fingerTarget(
    enabled: finger,
    AppMenuItem(
      key: key,
      label: label,
      trailing: trailing,
      selected: selected,
      onPressed: action,
    ),
  );

  /// The reader's own setting for a chat, kept on every device (Slack's channel
  /// notifications); a viewer has one too. The app's one submenu row, so it
  /// opens beside the panel exactly as the Windows ☰'s sections do.
  Widget _notifyMenu(SuperTabConversation group) => fingerTarget(
    enabled: _phone,
    AppSubmenuItem(
      itemKey: const ValueKey('super-notify-menu'),
      label: 'Notifications',
      trailing: const Icon(AppIcons.chevronRight, size: 14),
      width: _menuWidth,
      menuChildren: [
        for (final (level, label) in const [
          (SuperTabNotify.all, 'All new messages'),
          (SuperTabNotify.mentions, 'Mentions only'),
          (SuperTabNotify.muted, 'Muted'),
        ])
          _menuItem(
            label,
            () => unawaited(_setNotify(group.id, level)),
            key: ValueKey('super-notify-${level.name}'),
            finger: _phone,
            selected: c.notifyOf(group.id) == level,
          ),
      ],
    ),
  );

  /// Until all of the project's closed groups are read, it may have archived
  /// ones: the list reads them when it opens.
  bool _mayHaveArchived(String projectId) =>
      !c.dormantLoaded(projectId) ||
      c.hasEarlierDormant(projectId) ||
      c.snapshot?.conversations.any(
            (g) => g.archived && g.projectId == projectId,
          ) ==
          true;

  /// A project's chat header, `# name ▾`, which opens its menu (Quiet Swarm,
  /// screen 9).
  Widget _projectMenu(
    SuperTabConversation group,
    String name,
    TextStyle style,
  ) {
    final project = c.snapshot!.projectFor(group.id)!;
    final editable = c.canWrite && !c.saving && !c.hasPendingAction;
    final owner = project.ownerId == c.accountId;
    Widget item(String label, VoidCallback? action, {Widget? trailing}) =>
        _menuItem(label, action, finger: _phone, trailing: trailing);
    return AppDropdown(
      width: _menuWidth,
      consumeOutsideTap: false,
      alignmentOffset: Offset.zero,
      children: [
        item(
          'Status',
          project.status == null
              ? null
              : () => unawaited(
                  showSuperTabProjectStatus(context, c, project.id),
                ),
          trailing: const Icon(AppIcons.chevronRight, size: 14),
        ),
        item('Pull requests', _openPullRequests),
        // Every member reads the project's instructions; a backend without
        // them sends no coordinatorName.
        if (project.hasInstructions)
          item('Instructions', () => _groupAction('instructions', group)),
        if (editable && owner)
          item('Sharing', () => _groupAction('sharing', group)),
        _notifyMenu(group),
        const AppMenuDivider(),
        item(
          'Project settings…',
          () => unawaited(_projectSettings(group, project)),
        ),
      ],
      builder: (context, menu, _) => Tooltip(
        message: 'Project options',
        child: InkWell(
          key: const ValueKey('super-project-menu'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          onTap: () => menu.isOpen ? menu.close() : menu.open(),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (project.isPrivate)
                PrivateProjectLock(
                  size: AppIcons.inlineSize,
                  color: DesktopChrome.muted,
                ),
              if (project.isPrivate) const SizedBox(width: 4),
              Flexible(
                child: Text(
                  project.isPrivate ? project.name : name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: style,
                ),
              ),
              const SizedBox(width: 4),
              Icon(
                AppIcons.chevronDown,
                size: AppIcons.inlineSize,
                color: DesktopChrome.muted,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _projectSettings(
    SuperTabConversation group,
    SuperTabProject project,
  ) {
    final editable = c.canWrite && !c.saving && !c.hasPendingAction;
    final owner = project.ownerId == c.accountId;
    void act(String action) => unawaited(_groupAction(action, group));
    return showProjectSettings(context, c, project, [
      if (editable && owner) ('Rename project', () => act('rename')),
      ('Project details', () => act('details')),
      // While the PM has a switch under way, there is nothing to ask for.
      if (editable &&
          c.snapshot?.maySwitchLead(project.id, c.accountId) == true &&
          c.snapshot?.leadOf(project.id)?.switchRequest == null)
        ('Switch PM…', () => act('switch-pm')),
      if (_mayHaveArchived(group.projectId))
        ('Archived conversations', () => act('archived')),
      if (editable && owner) ('Delete Project', () => act('delete')),
    ], rowHeight: _phone ? kFingerTarget : 32);
  }

  /// The group's ⋮ menu. With [views] (a phone) it opens on the views the
  /// header has no room for — the group's terminals and its pull requests —
  /// each a finger's height.
  Widget _options(SuperTabConversation group, {bool views = false}) {
    final editable = c.canWrite && !c.saving && !c.hasPendingAction;
    Widget item(String label, VoidCallback? action) =>
        _menuItem(label, action, finger: views);
    return AppDropdown(
      width: _menuWidth,
      consumeOutsideTap: false,
      alignmentOffset: Offset.zero,
      children: [
        if (views) ...[
          item(
            'Group terminals (${_terminalCount(group)})',
            _openTerminals(group),
          ),
          item('Pull requests', _openPullRequests),
          const AppMenuDivider(),
        ],
        if (_isBuddyChat(group)) ...[
          // A Buddy chat is the reader's own: the Buddy itself to name, any
          // time, and to remove. Nothing to archive, and no way to a Chat with
          // PM (Ken, 10-28).
          if (editable)
            item(
              'Rename Buddy…',
              () => unawaited(showRenameBuddy(context, c, group.projectId)),
            ),
          if (editable && c.buddy(group.projectId) != null)
            item(
              'Remove Buddy',
              () => unawaited(confirmRemoveBuddy(context, c, group.projectId)),
            ),
          // The one Buddy's chat lists the person's older chats in projects
          // they still read, each read only (spec: history).
          if (group.isSwarmBuddyChat)
            for (final project
                in c.snapshot?.projects ?? const <SuperTabProject>[])
              // One with nothing in it has no history to keep (security
              // review 1 of #2437).
              if (c.buddyChat(project.id) case final earlier?
                  when earlier.lastMessageSequence > 0)
                item(
                  'Earlier chat in ${project.name}',
                  () => unawaited(c.select(earlier.id)),
                ),
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
        _notifyMenu(group),
        if (_mayHaveArchived(group.projectId))
          item('Archived conversations', () => _groupAction('archived', group)),
      ],
      builder: (context, menu, _) => AppIconButton(
        key: const ValueKey('super-group-options'),
        icon: AppIcons.ellipsisVertical,
        tooltip: _isBuddyChat(group) ? 'Buddy options' : 'Workgroup options',
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

  Future<void> _react(
    SuperTabMessage message,
    SuperTabReactionEmoji emoji,
  ) async {
    final failure = await c.react(message, emoji);
    if (failure == null || !mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(failure)));
  }

  SuperTabMessage _outgoingMessage(SuperTabOutgoing sent) {
    final id = sent.conversationId;
    final person = c.snapshot?.people
        .where((p) => p.id == c.accountId)
        .firstOrNull;
    return SuperTabMessage.fromJson({
      'id': sent.operationId ?? 'outgoing',
      'conversationId': id,
      'text': sent.text,
      'replyTo': sent.replyTo,
      'sequence': 0,
      'createdAt': sent.confirmedAt ?? DateTime.now().toUtc().toIso8601String(),
      // As the backend writes the sender (model.ts author()), so the row
      // groups the same before and after it is confirmed.
      'author': {
        'kind': 'person',
        'id': c.accountId,
        'name': person?.email ?? '',
        'membershipGeneration': ?person?.generation,
      },
    });
  }

  /// Uses the transcript's own row identity before and after acknowledgement.
  Widget _outgoingRow(
    SuperTabOutgoing sent,
    Map<String, SuperTabMessage> byId, {
    required bool grouped,
  }) {
    final message = _outgoingMessage(sent);
    final person = c.snapshot?.people
        .where((p) => p.id == c.accountId)
        .firstOrNull;
    final reply = byId[sent.replyTo];
    return KeyedSubtree(
      key: const ValueKey('super-outgoing'),
      child: SuperTabMessageRow(
        message: message,
        dimmed: sent.state == SuperTabOutgoingState.sending,
        author: _shownAuthor(c, message),
        person: person,
        member: _member,
        grouped: grouped,
        reply: reply,
        replyAuthor: reply == null ? null : _shownAuthor(c, reply),
        onReturnToComposer: _focus.requestFocus,
        readerId: c.accountId,
        headerStatus: sent.state == SuperTabOutgoingState.confirmed
            ? null
            : SuperTabOutgoingReceipt(
                inline: true,
                message: sent,
                // A refused message goes again only when nothing else is on
                // its way.
                onRetry:
                    c.saving ||
                        (sent.state == SuperTabOutgoingState.refused &&
                            c.hasPendingAction)
                    ? null
                    : () {
                        unawaited(c.retryOutgoing(sent));
                        _focus.requestFocus();
                      },
                // The click lands in the transcript; typing goes on in the
                // composer, as after Reply.
                onDelete: () {
                  c.discardOutgoing(sent);
                  _focus.requestFocus();
                },
              ),
        receipts: const [],
      ),
    );
  }

  // What every row reads from the Swarm, built once per snapshot read rather
  // than over every group and person for each row.
  SuperTabSnapshot? _indexed;
  Map<int, String> _references = const {};
  Map<String, SuperTabPerson> _people = const {};
  void _index() {
    final snapshot = c.snapshot;
    if (identical(snapshot, _indexed)) return;
    _indexed = snapshot;
    _references = {
      for (final g in snapshot?.conversations ?? <SuperTabConversation>[])
        if (g.number != null) g.number!: g.id,
    };
    _people = {};
    for (final person in snapshot?.people ?? <SuperTabPerson>[]) {
      _people.putIfAbsent(person.id, () => person);
    }
  }

  /// A reply author as the Swarm last read them, so a thread's line shows
  /// the faces their own messages wear; both null for anyone no longer in
  /// it.
  ({SuperTabPerson? person, SuperTabAgent? agent}) _member(
    String kind,
    String id,
  ) {
    _index();
    return (
      person: kind == 'person' ? _people[id] : null,
      agent: kind == 'agent' ? c.snapshot?.agent(id) : null,
    );
  }

  Widget _message(
    SuperTabMessage message,
    bool grouped,
    Map<String, SuperTabMessage> byId, {
    bool showReceipt = false,
    bool inThread = false,
  }) {
    _index();
    if (SuperTabShipRow.shows(message)) {
      return SuperTabShipRow(
        key: ValueKey(
          '${inThread ? 'super-thread-message' : 'super-message'}-${message.id}',
        ),
        message: message,
        controller: c,
      );
    }
    if (message.terminalEvent) {
      return SuperTabTerminalRow(
        key: ValueKey(
          '${inThread ? 'super-thread-message' : 'super-message'}-${message.id}',
        ),
        message: message,
        controller: c,
      );
    }
    final route = message.route;
    if (route != null) {
      return SuperTabRouteRow(
        key: ValueKey(
          '${inThread ? 'super-thread-message' : 'super-message'}-${message.id}',
        ),
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
    final writable =
        c.canWrite &&
        c.selected?.archived == false &&
        !c.isEarlierBuddyChat(c.selected);
    final root = message.thread;
    // A message that started a session has its line before any reply comes,
    // so the session is found again after its pane closes.
    final thread = inThread || root != message.id
        ? null
        : c.thread(message.conversationId, message.id) ??
              (c.threadSession(message.id) != null
                  ? SuperTabThread.empty(message.id)
                  : null);
    final group = inThread
        ? null
        : c.snapshot?.conversation(message.conversationId);
    final card = group?.cards.of(message.id);
    return SuperTabMessageRow(
      key: ValueKey(
        '${inThread ? 'super-thread-message' : 'super-message'}-${message.id}',
      ),
      message: message,
      card: card == null
          ? null
          : SuperTabLiveCard(
              group: group!,
              card: card,
              controller: c,
              facts: _facts,
            ),
      author: _shownAuthor(c, message),
      // A person is found by their username, as they are tagged, and reads
      // as the name they set.
      mentions: [
        for (final id in message.mentions)
          if (_people[id] case final person?) person.username,
      ],
      mentionAddresses: {
        for (final id in message.mentions)
          if (_people[id] case final person?) person.username: person.email,
      },
      mentionLabels: {
        for (final id in message.mentions)
          if (_people[id] case SuperTabPerson(:final username, :final name?))
            username: name,
      },
      references: _references,
      onOpenGroup: (id) {
        setState(() => _showPullRequests = _showTasks = false);
        c.select(id);
        c.selectTerminal(id, null);
      },
      agent: agent,
      person: message.fromAgent ? null : _people[message.authorId],
      member: _member,
      identity: grouped ? null : () => _identityFacts(message, agent),
      onOpenAgent: agent == null ? null : () => _openAgent(agent),
      machineName: agent == null ? null : widget.machineName(agent.machineId),
      grouped: grouped,
      reply: reply,
      replyAuthor: reply == null ? null : _shownAuthor(c, reply),
      replyGone: quoted != null && reply == null,
      onOpenReply: (row) => unawaited(_openOriginal(message, row)),
      link: SwarmMessageLink(
        tabId: c.tabId,
        conversationId: message.conversationId,
        messageId: message.id,
      ),
      linkTarget: _linkTarget,
      onOpenLink: _openLink,
      // A reply only in its thread is read with its thread's own mark.
      onMarkUnread: inThread || !message.inMainStream
          ? null
          : () => unawaited(_markUnread(message)),
      onRemind: (when) => unawaited(_remind(message, when)),
      // A message with a thread is answered there; one from before threads
      // keeps the inline reply.
      onReply: !writable || inThread
          ? null
          : root != null
          ? () => c.openThread(root)
          : () {
              setState(() => _replies[c.selectedId] = message);
              _focus.requestFocus();
            },
      thread: thread,
      threadUnread: thread != null && c.threadUnread(thread),
      threadTagged:
          thread != null &&
          SuperTabAttention.of(c).hasUnreadTagInThread(c.selectedId, thread.id),
      // A thread its own Buddy session answers says so on its line.
      threadTrailing: switch (thread == null || inThread
          ? null
          : c.threadSession(thread.id)) {
        final session? => SuperTabThreadSessionMark(
          key: ValueKey('super-thread-session-mark-${thread!.id}'),
          activity: superTabSessionActivity(c, widget.app, session),
          alone: thread.replies == 0,
        ),
        null => null,
      },
      threadEnd:
          thread == null ||
              inThread ||
              !c.canWrite ||
              c.threadSession(thread.id) == null
          ? null
          : SuperTabSessionEnd(
              key: ValueKey('super-thread-session-end-${thread.id}'),
              controller: c,
              root: thread.id,
              metadata: true,
            ),
      onOpenThread:
          !inThread && root != null && (thread != null || message.threadReply)
          ? () => c.openThread(root)
          : null,
      onReturnToComposer: _focus.requestFocus,
      readerId: c.accountId,
      reactorName: (kind, id) => kind == 'agent'
          ? c.snapshot?.agentName(id) ?? 'Agent'
          : switch (_people[id]) {
              final person? => person.shownName,
              null => 'Someone',
            },
      // An older Buddy chat is kept to read: no reaction there (security review 1 of #2437).
      onReact:
          c.canWrite &&
              c.selected?.archived == false &&
              !c.isEarlierBuddyChat(c.selected)
          ? (emoji) => unawaited(_react(message, emoji))
          : null,
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

  /// The open thread of the selected conversation, beside the chat.
  Widget? _threadPanel() {
    final open = c.openedThread;
    if (open == null || open.conversationId != c.selectedId) return null;
    final rows = c.threadMessages(open.root);
    final byId = {for (final m in rows) m.id: m};
    return SuperTabImageGallery(
      images: () => _images(rows),
      thread: open.root,
      child: SuperTabThreadPanel(
        controller: c,
        root: open.root,
        row: (message, grouped) =>
            _message(message, grouped, byId, inThread: true),
        // The thread panel groups its own rows; one on its way keeps its name.
        outgoing: (sent) => _outgoingRow(sent, byId, grouped: false),
        sessionActivity: (session) =>
            superTabSessionActivity(c, widget.app, session),
        machineName: widget.machineName,
        onScroll: (list) => _threadScroll = list,
        voice: _voice,
      ),
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

  static String _rowKey(String messageId) => 'super-row-$messageId';

  /// Where [id]'s list divides: the first row drawn when it opened. Older
  /// pages go above it and newer messages below, so neither moves the rows
  /// already there.
  int _splitAt(
    String id,
    List<({SuperTabMessage message, int interruptions})> entries,
  ) {
    if (entries.isEmpty) return 0;
    final split = _split[id];
    final at = split == null
        ? -1
        : entries.indexWhere(
            (e) => superTabMessageOrder(e.message, split) >= 0,
          );
    if (at >= 0) return at;
    _split[id] = entries.first.message;
    c.keepFrom(id, entries.first.message);
    return 0;
  }

  /// Rows below the dividing row before a reader at the end has it moved to
  /// the rows on screen ([_moveSplitToView]).
  static const _rowsBelowSplit = 200;

  /// For a reader at the end of [id]: moves the dividing row down to the
  /// first row of the group at the top edge of the view, its place
  /// unchanged, so the controller may cut the rows above (it never cuts below
  /// it). From a group's first row the groups below stay as they were; only
  /// rows above the view can regroup.
  void _moveSplitToView(String id, SuperTabChatScroll scroll) {
    final split = _split[id];
    if (split == null) return;
    final messages = _ownShown(id);
    final at = messages.indexWhere((m) => superTabMessageOrder(m, split) >= 0);
    final top = _rowAtTop();
    if (at < 0 || messages.length - at <= _rowsBelowSplit || top == null) {
      return;
    }
    final joined = _joined(messages, split);
    var index = messages.indexWhere((m) => m.id == top);
    while (index > at && joined.contains(messages[index].id)) {
      index--;
    }
    if (index <= at) return;
    final first = messages[index];
    final offset = _offsetInList(_built[first.id]);
    if (offset == null) return;
    // Its row starts the newer rows now: the rows are measured from it.
    scroll.moveContent(-offset);
    _split[id] = first;
    c.keepFrom(id, first);
  }

  /// The built row at the top edge of the view: the one it cuts through,
  /// else the highest one below it.
  String? _rowAtTop() {
    ({String messageId, double top})? at;
    for (final MapEntry(key: messageId, value: row) in _built.entries) {
      final top = row.mounted ? _topInList(row) : null;
      if (top == null) continue;
      final better =
          at == null ||
          (top <= 0 ? at.top > 0 || top > at.top : at.top > 0 && top < at.top);
      if (better) at = (messageId: messageId, top: top);
    }
    return at?.messageId;
  }

  /// Where [row] is laid out in the newer rows' list, from its start; null
  /// when it is not laid out there.
  static double? _offsetInList(BuildContext? row) {
    if (row == null || !row.mounted) return null;
    RenderObject? child = row.findRenderObject();
    while (child != null && child.parent is! RenderSliverMultiBoxAdaptor) {
      child = child.parent;
    }
    final data = child?.parentData;
    return data is SliverMultiBoxAdaptorParentData ? data.layoutOffset : null;
  }

  /// The rows that join the one above them, without their name: one
  /// sender's messages within five minutes of each other, up to
  /// [SuperTabMessageRow.groupLimit] to a group. Groups are counted from the
  /// list's dividing row both ways, so a page read in above regroups none of
  /// the rows already shown.
  Set<String> _joined(List<SuperTabMessage> messages, SuperTabMessage? split) {
    bool tagged(SuperTabMessage m) =>
        c.thread(m.conversationId, m.id)?.askTag != null;
    final at = split == null
        ? -1
        : messages.indexWhere((m) => superTabMessageOrder(m, split) >= 0);
    if (at <= 0) {
      return SuperTabMessageRow.consecutiveUpdates(messages, tagged: tagged);
    }
    final joined = SuperTabMessageRow.consecutiveUpdates(
      messages.sublist(at),
      tagged: tagged,
    );
    // Above it, upward: each group, newest first, keeps the name on its
    // oldest row.
    var group = [at - 1];
    for (var i = at - 2; i >= -1; i--) {
      if (i >= 0 &&
          group.first - i < SuperTabMessageRow.groupLimit &&
          SuperTabMessageRow.groupsWith(
            messages[i + 1],
            messages[i],
            tagged: tagged,
          )) {
        group.add(i);
        continue;
      }
      for (final j in group.take(group.length - 1)) {
        joined.add(messages[j].id);
      }
      group = [i];
    }
    return joined;
  }

  /// Above the oldest row read: room for, or the button to read, earlier
  /// messages. Its spinner only when [near] the view, where it is seen.
  Widget _earlierRow({required bool near}) {
    final id = c.selectedId;
    if (!c.hasOlder(id)) return const SizedBox.shrink();
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
      child: near && _loadingOlder.contains(id)
          ? const Center(
              child: SizedBox.square(
                key: ValueKey('super-earlier-loading'),
                dimension: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          : null,
    );
  }

  Widget _date(DateTime time) => Padding(
    padding: const EdgeInsets.fromLTRB(24, 20, 24, 4),
    child: Row(
      children: [
        Expanded(child: Divider(color: DesktopChrome.rim)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          // The day pill takes its place once it reaches the pill.
          child: SuperTabDayLabel(
            day: time,
            child: Text(
              MaterialLocalizations.of(context)
                  .formatMediumDate(time.toLocal()),
              style: DesktopChrome.metadata(),
            ),
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
    // An older Buddy chat in a project reads, but is no longer written to
    // here, where one Buddy answers in # buddy.
    final writable =
        c.canWrite &&
        group != null &&
        !group.archived &&
        !c.isEarlierBuddyChat(group);
    final busy = c.saving || c.uploading;
    final latestOwn = c
        .messages(c.selectedId)
        .reversed
        .where(c.isOwn)
        .firstOrNull;
    final actualMessages = _shownMessages(c.selectedId);
    // A thread's reply sends in its thread; only what shows here is pending here.
    final outgoing = c
        .outgoing(c.selectedId)
        .where((sent) => sent.inMainStream)
        .toList();
    final pendingById = {for (final sent in outgoing) sent.operationId: sent};
    final messages = [...actualMessages, ...outgoing.map(_outgoingMessage)];
    // The task's own rows, for what is placed by sequence (the split, its
    // grouping, the count of new rows, the read mark): each conversation
    // numbers its own messages, so its steps' rows have no place in it.
    final ownMessages = [
      for (final m in actualMessages)
        if (m.conversationId == c.selectedId) m,
    ];
    final ownWithOutgoing = [...ownMessages, ...outgoing.map(_outgoingMessage)];
    final entries = superTabTranscriptEntries(messages);
    final byId = {for (final message in messages) message.id: message};
    final rowIndex = {
      for (final (index, entry) in entries.indexed)
        _rowKey(c.messageIdentity(entry.message.id)): index,
    };
    // A row stays the same row as pages arrive above it, state and all.
    int? rowOf(Key key) => key is ValueKey<String> ? rowIndex[key.value] : null;
    final split = _splitAt(
      c.selectedId,
      superTabTranscriptEntries(ownMessages),
    );
    // Rows on their way group by the same rule, so a quick line keeps the
    // shape it will have once confirmed; one Not sent keeps its name and
    // actions.
    final grouped = _joined(ownWithOutgoing, _split[c.selectedId])
      ..removeWhere(
        (id) => switch (pendingById[id]?.state) {
          SuperTabOutgoingState.refused ||
          SuperTabOutgoingState.unconfirmed => true,
          _ => false,
        },
      );
    Widget row(int index) {
      final entry = entries[index];
      final message = entry.message;
      final agent = message.fromAgent
          ? c.snapshot?.agent(message.authorId)
          : null;
      final previous = index > 0 ? entries[index - 1].message : null;
      // Grouping is decided on the task's own rows; a step's row drawn between
      // two of them still ends the group, or the next would read as its agent's.
      final joined =
          grouped.contains(message.id) &&
          previous?.conversationId == message.conversationId;
      final time = message.createdAt;
      return SuperTabDayMark(
        key: ValueKey(_rowKey(c.messageIdentity(message.id))),
        time: time,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (time != null &&
                !DateUtils.isSameDay(
                  time.toLocal(),
                  previous?.createdAt?.toLocal(),
                ))
              _date(time),
            if (message.id == _unread.lineAt(c.selectedId))
              SuperTabNewMessagesLine(key: _unread.key),
            // The message itself is kept in place: its
            // date moves above earlier ones as they come.
            _BuiltRow(
              id: message.id,
              rows: _built,
              child: KeyedSubtree(
                key: message.id == _target ? _targetKey : null,
                child: SuperTabMessageHighlight(
                  on: message.id == _lit,
                  child: pendingById.containsKey(message.id)
                      ? _outgoingRow(
                          pendingById[message.id]!,
                          byId,
                          grouped: joined,
                        )
                      : entry.interruptions > 0
                      ? SuperTabRecordingNotice(
                          key: ValueKey('super-message-${message.id}'),
                          author: _shownAuthor(c, message),
                          count: entry.interruptions,
                          onOpenTerminal: agent == null
                              ? null
                              : () => _openAgent(agent),
                        )
                      : _message(
                          message,
                          joined,
                          byId,
                          showReceipt: message.id == latestOwn?.id,
                        ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    final newAfter = _newAfter[c.selectedId];
    final newCount = newAfter == null
        ? 0
        : ownWithOutgoing
              .where((message) => message.sequence > newAfter)
              .length;
    // More came than were read: the count is a floor.
    final moreNew = c.hasNewer(c.selectedId);
    // Scrolled away from the newest message, or newer pages wait unread.
    final awayFromEnd = _awayFromEnd.contains(c.selectedId) || moreNew;
    final reply = _replies[c.selectedId];
    // A failed message says so in its own row, with what can be done. Only
    // this conversation's own error is said there; another's never hides it.
    final composerError = c.composerError(c.selectedId);
    final errorInRow = outgoing.any(
      (sent) => switch (sent.state) {
        SuperTabOutgoingState.sending ||
        SuperTabOutgoingState.confirmed => false,
        SuperTabOutgoingState.unconfirmed => c.hasPendingAction,
        SuperTabOutgoingState.refused =>
          composerError != null && sent.error == composerError,
      },
    );
    final finding = _finding?.conversationId == c.selectedId ? _finding : null;
    final back = finding == null && _back?.conversationId == c.selectedId;
    final chatId = c.selectedId;
    // Read as the message changes, by the composer's own builders.
    List<String> pastedFolders() => group != null && _agentsElsewhere(group)
        ? _foldersInMessage(chatId)
        : const <String>[];
    final completing = Listenable.merge([
      _composer,
      _mentionIndex,
      _dismissedMention,
    ]);
    // No conversation read yet: its error is the page itself, not a line over "Loading".
    final unread = _readsFirst && c.snapshot == null;
    // The reader's own Buddy chat shows what the PM asked them.
    final decisions = group != null && _isBuddyChat(group)
        ? ({required bool edge}) => SuperTabDecisionsPanel(
            decisions: SuperTabDecisions.of(c),
            projectId: group.projectId,
            edge: edge,
          )
        : null;
    return Column(
      children: [
        if (c.error != null && !unread)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
            child: Row(
              children: [
                // A Swarm that was read and now cannot be (a backend or this
                // computer's Harness restarting) keeps what it shows and says
                // so quietly; it reads again by itself (task #2647).
                Expanded(
                  child: c.backendUnreachable && c.snapshot != null
                      ? Text(
                          'Reconnecting…',
                          key: const ValueKey('super-reconnecting'),
                          style: DesktopChrome.metadata(),
                        )
                      : Text(c.error!, style: DesktopChrome.control()),
                ),
                if (!c.accessRevoked && !c.updateRequired)
                  TextButton(
                    onPressed: () => unawaited(c.refresh()),
                    child: const Text('Retry'),
                  ),
              ],
            ),
          ),
        if (group != null && decisions != null && !c.isEarlierBuddyChat(group))
          // The list stops at an edge under the Buddy's line, as it does under
          // the header: without one, a message scrolled up to the line read as
          // cut off under it (Huy, 11-03).
          DecoratedBox(
            key: const ValueKey('super-buddy-edge'),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                SuperTabBuddyBar(controller: c, chat: group, app: widget.app),
                decisions(edge: false),
              ],
            ),
          )
        // An earlier Buddy chat has no Buddy line: its decisions, when it has
        // any, end at the same edge.
        else if (decisions != null)
          decisions(edge: true),
        Expanded(
          child: c.loading
              ? const Center(child: CircularProgressIndicator())
              : unread && c.error != null
              ? _firstReadFailed(c.error!)
              : messages.isEmpty &&
                    outgoing.isEmpty &&
                    !c.accessRevoked &&
                    group != null &&
                    _personalPaneCount(group) > 0
              ? _panesWaiting(group)
              : messages.isEmpty && outgoing.isEmpty
              ? Padding(
                  // The pane's side padding, as the composer has: a long line
                  // wraps inside it, centered.
                  padding: const EdgeInsets.symmetric(
                    horizontal: grid.AppDesktop.panelPadding,
                  ),
                  child: Center(
                    child: Text(
                      c.accessRevoked
                          ? 'Conversation unavailable.'
                          : group == null
                          ? 'Loading conversation…'
                          : c.snapshot!.isProjectLead(group.id)
                          ? 'Discuss the plan with ${c.snapshot!.coordinatorNameOf(group.projectId)}.'
                          : _buddyName(group) != null
                          ? "Only you and ${_buddyName(group)} read this chat. Say what you want to build; say 'send to the ${c.snapshot!.coordinatorNameOf(group.projectId)}' when it's ready."
                          : 'Start the conversation.',
                      textAlign: TextAlign.center,
                      style: DesktopChrome.text(color: DesktopChrome.muted),
                    ),
                  ),
                )
              : Column(
                  children: [
                    // Above the list, never over a message.
                    SuperTabUnreadBand(
                      key: ValueKey('super-unread-band-${c.selectedId}'),
                      scroll: _scroll[c.selectedId],
                      child: _showsBar(c.selectedId)
                          ? SuperTabUnreadBar(
                              count: _newFromLine(c.selectedId),
                              more: c.hasNewer(c.selectedId),
                              onPressed: () => _jumpToUnreadLine(c.selectedId),
                              onMarkRead: _markReadFromBar,
                            )
                          : _unread.offersDown(c.selectedId)
                          ? Padding(
                              padding: const EdgeInsets.fromLTRB(
                                grid.AppDesktop.panelPadding,
                                grid.AppDesktop.controlGap,
                                grid.AppDesktop.panelPadding,
                                0,
                              ),
                              child: Center(
                                child: SuperTabJumpToUnread(
                                  onPressed: () =>
                                      _jumpToUnreadLine(c.selectedId),
                                ),
                              ),
                            )
                          : null,
                    ),
                    Expanded(
                      child: Stack(
                        children: [
                          SuperTabStickyDay(
                            pillKey: const ValueKey('super-day-pill'),
                            hidden: finding != null,
                            onJump: (from) =>
                                unawaited(_jumpToTime(c.selectedId, from)),
                            child: NotificationListener<ScrollNotification>(
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
                                _follow(id, atEnd);
                                // Once the scroll ends, so keeping the place never
                                // cuts a drag short.
                                if (event is ScrollEndNotification) {
                                  _readEarlierNearTop(id, event.metrics);
                                }
                                if (atEnd) {
                                  // A row still sending has no place in the transcript.
                                  final sequence =
                                      ownMessages.lastOrNull?.sequence ?? 0;
                                  WidgetsBinding.instance.addPostFrameCallback((
                                    _,
                                  ) {
                                    if (mounted && c.selectedId == id) {
                                      _readToEnd(id, sequence);
                                    }
                                  });
                                }
                                return false;
                              },
                              child: SelectionArea(
                                child: CustomScrollView(
                                  controller: _scroll[c.selectedId],
                                  key: PageStorageKey(
                                    'super-messages-${c.tabId}-${c.selectedId}',
                                  ),
                                  // Pages read in grow upward from the rows first
                                  // shown, new messages downward: no row on screen
                                  // moves for either.
                                  center: _newerRows,
                                  slivers: [
                                    // Its spinner runs only near the view.
                                    SliverLayoutBuilder(
                                      builder: (context, constraints) =>
                                          SliverToBoxAdapter(
                                            child: Padding(
                                              padding: EdgeInsets.only(
                                                top: grid.AppDesktop.controlGap,
                                              ),
                                              child: _earlierRow(
                                                near:
                                                    constraints
                                                        .remainingCacheExtent >
                                                    0,
                                              ),
                                            ),
                                          ),
                                    ),
                                    LaidOutSliverList(
                                      delegate: SliverChildBuilderDelegate(
                                        (context, index) =>
                                            row(split - 1 - index),
                                        childCount: split,
                                        findChildIndexCallback: (key) =>
                                            switch (rowOf(key)) {
                                              final i? when i < split =>
                                                split - 1 - i,
                                              _ => null,
                                            },
                                      ),
                                    ),
                                    SliverPadding(
                                      key: _newerRows,
                                      padding: EdgeInsets.only(
                                        bottom: grid.AppDesktop.controlGap,
                                      ),
                                      sliver: LaidOutSliverList(
                                        delegate: SliverChildBuilderDelegate(
                                          // Messages on their way end the list.
                                          (context, index) =>
                                              row(split + index),
                                          childCount: entries.length - split,
                                          findChildIndexCallback: (key) =>
                                              switch (rowOf(key)) {
                                                final i? when i >= split =>
                                                  i - split,
                                                _ => null,
                                              },
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
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
                          if (newCount > 0 || back || awayFromEnd)
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
                                    if (newCount > 0 || awayFromEnd)
                                      SuperTabJumpToLatest(
                                        onPressed: _jumpToLatest,
                                        count: newCount,
                                        more: moreNew,
                                      ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
        ),
        if (composerError != null && !errorInRow)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Row(
              children: [
                Expanded(
                  child: Text(composerError, style: DesktopChrome.control()),
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
                    text: superTabQuoteText(reply),
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
        ListenableBuilder(
          listenable: completing,
          builder: (context, _) {
            final choices = _completionChoices;
            if (choices.isEmpty) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
              child: SuperTabCompletionList(
                listKey: const ValueKey('super-composer-completions'),
                choices: choices,
                index: _mentionIndex.value,
                rowKeys: _completionKeys,
              ),
            );
          },
        ),
        // A chat kept to read gets one muted bar in place of the box, so
        // nothing looks typeable: a closed group, or an older Buddy chat in a
        // project, which also leads to the one Buddy (Lead's design review,
        // 10-31).
        if (group != null && (c.isEarlierBuddyChat(group) || group.archived))
          Padding(
            key: c.isEarlierBuddyChat(group)
                ? const ValueKey('super-earlier-buddy-chat')
                : null,
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    c.isEarlierBuddyChat(group)
                        ? 'This is an earlier chat, kept to read.'
                        : 'This group is closed. You can read it but not write.',
                    style: DesktopChrome.metadata(),
                  ),
                ),
                if (c.isEarlierBuddyChat(group))
                  TextButton(
                    key: const ValueKey('super-open-swarm-buddy'),
                    onPressed: () => unawaited(
                      c.openBuddyChat(SuperTabController.kSwarmBuddyKey),
                    ),
                    child: const Text('Open # buddy'),
                  )
                else if (c.canWrite)
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
          ListenableBuilder(
            // Keyed: the lines that come and go above it (a reply, mention
            // choices, an error) would otherwise take over this element and
            // remount the field. A remounted field keeps focus but loses its
            // text input connection, so typing, Backspace included, would go
            // nowhere.
            key: const ValueKey('super-message-composer-row'),
            listenable: _composer,
            builder: (context, field) => Padding(
              // On a phone the box sits against the keyboard, with the width.
              padding: _phone
                  ? const EdgeInsets.all(grid.AppDesktop.controlGap)
                  : EdgeInsets.fromLTRB(
                      24,
                      12,
                      24,
                      pastedFolders().isEmpty ? ProjectSidebar.footGap : 6,
                    ),
              child: _phone
                  ? Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (c.offersChatSessions &&
                            _chatSessions.contains(chatId) &&
                            c.threadSessionBlocked == null)
                          Padding(
                            padding: const EdgeInsets.only(
                              bottom: grid.AppDesktop.controlGap,
                            ),
                            child: Text(
                              'Your message starts its own thread and Buddy session',
                              key: const ValueKey('super-chat-session-note'),
                              style: DesktopChrome.metadata(
                                color: DesktopChrome.muted,
                              ),
                            ),
                          ),
                        KeyedSubtree(
                          key: const ValueKey('super-message-composer-box'),
                          child: field!,
                        ),
                      ],
                    )
                  : field,
            ),
            child: Focus(
              onKeyEvent: (node, event) {
                final composing = _composer.value.composing;
                final picked =
                    _focus.hasFocus &&
                        !(composing.isValid && !composing.isCollapsed)
                    ? superTabCompletionKey(
                        event,
                        choices: () => _completionChoices,
                        index: _mentionIndex.value,
                        move: _moveCompletion,
                        dismiss: () => _dismissedMention.value = _composer.text
                            .substring(0, _composer.selection.baseOffset),
                      )
                    : null;
                if (picked != null) return picked;
                if (event is KeyDownEvent &&
                    event.logicalKey == LogicalKeyboardKey.escape &&
                    !HardwareKeyboard.instance.isShiftPressed &&
                    _readAll()) {
                  return KeyEventResult.handled;
                }
                switch (composerEnter(
                  event,
                  focused: _focus.hasFocus,
                  value: _composer.value,
                )) {
                  case ComposerEnter.ignore:
                    return KeyEventResult.ignored;
                  case ComposerEnter.newline:
                    _insertNewline();
                    return KeyEventResult.handled;
                  case ComposerEnter.send:
                    break;
                }
                unawaited(_send());
                return KeyEventResult.handled;
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
                  // A browser has no path to give; there a folder is not
                  // taken, as before.
                  onFolders: kIsWeb
                      ? null
                      : (paths) => _pasteFolders(chatId, paths),
                  child: GestureDetector(
                    behavior: HitTestBehavior.translucent,
                    onTap: writable ? _focus.requestFocus : null,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(12, 3, 4, 3),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          SuperTabComposerChips(controller: c, files: _files),
                          ViewRoom(
                            builder: (context, room) => _composerLayout(
                              room: room,
                              field: NewHarnessPasteTarget(
                                key: _composerFieldKey,
                                attachments: _files,
                                enabled: writable && !busy,
                                focusNode: _focus,
                                child: TextField(
                                  key: const ValueKey('super-message-composer'),
                                  controller: _composer,
                                  focusNode: _focus,
                                  autofocus: !_terminalsVisible,
                                  enabled: writable,
                                  minLines: 1,
                                  // A phone's keyboard takes the height, so
                                  // its height says nothing about the room
                                  // a draft should have (Huy, 2026-11-02).
                                  maxLines: _phone
                                      ? _phoneComposerLines(room)
                                      : MediaQuery.sizeOf(context).height < 600
                                      ? 3
                                      : 8,
                                  maxLength: kComposerMaxLength,
                                  inputFormatters: [_tagBackspace],
                                  keyboardType: TextInputType.multiline,
                                  textAlignVertical: TextAlignVertical.center,
                                  style: SwarmType.composer(context),
                                  decoration: InputDecoration(
                                    // The row centers the line. Inheriting a decorated
                                    // field's minimum height leaves slack below its text.
                                    isCollapsed: true,
                                    constraints: const BoxConstraints(),
                                    visualDensity: VisualDensity.standard,
                                    hintStyle: SwarmType.composer(
                                      context,
                                      color: DesktopChrome.hint,
                                    ),
                                    contentPadding: EdgeInsets.zero,
                                    hintMaxLines: _phone ? 1 : null,
                                    hintText: _readsFirst && c.snapshot == null
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
                                  onChanged: _composerEdited,
                                ),
                              ),
                              attach: fingerTarget(
                                enabled: _phone,
                                NewHarnessAttachButton(
                                  attachments: _files,
                                  enabled: writable && !busy,
                                  icon: AppIcons.plus,
                                ),
                              ),
                              tag: fingerTarget(
                                enabled: _phone,
                                SuperTabComposerTagButton(
                                  key: const ValueKey('super-composer-tag'),
                                  onPressed: writable ? _promptTag : null,
                                ),
                              ),
                              options: [
                                if (c.offersChatSessions)
                                  Padding(
                                    padding: const EdgeInsets.only(
                                      left: grid.AppDesktop.controlGap,
                                    ),
                                    child: _chatSessionChoice(writable),
                                  ),
                                if (c.offersChatSessions &&
                                    c.selected?.isSwarmBuddyChat == true &&
                                    _chatSessions.contains(c.selectedId))
                                  Padding(
                                    padding: const EdgeInsets.only(
                                      left: grid.AppDesktop.controlGap,
                                    ),
                                    child: _chatSessionProject(writable),
                                  ),
                              ],
                              trailing: [
                                if (_voice case final voice?)
                                  fingerTarget(
                                    enabled: _phone,
                                    SuperTabComposerMic(
                                      key: const ValueKey('super-composer-mic'),
                                      onPressed: writable
                                          ? () => voice.start(
                                              conversationId: chatId,
                                            )
                                          : null,
                                    ),
                                  ),
                              ],
                              voice: switch (_voice) {
                                final voice?
                                    when voice.activeIn(chatId, null) =>
                                  SuperTabVoiceRow(
                                    key: const ValueKey('super-voice-row'),
                                    take: voice,
                                  ),
                                _ => null,
                              },
                              send: ListenableBuilder(
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
                                            !c.uploading &&
                                            ((!busy && !c.hasPendingAction) ||
                                                (_files.isEmpty &&
                                                    c.canQueueText)) &&
                                            (_composer.text.trim().isNotEmpty ||
                                                !_files.isEmpty)
                                        ? () => unawaited(_send())
                                        : null,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          if (_voice case final voice?)
                            SuperTabVoiceNotice(
                              take: voice,
                              conversationId: chatId,
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        // While New session can be chosen here, its line's place is kept, so
        // the box never moves as the choice is toggled. Not on a phone, where
        // that line held the box off the keyboard: it shows above the box.
        if (c.offersChatSessions && !_phone)
          Container(
            alignment: Alignment.centerLeft,
            padding: const EdgeInsets.only(
              left: grid.AppDesktop.panelPadding,
              right: grid.AppDesktop.panelPadding,
              bottom: grid.AppDesktop.controlGap,
            ),
            child: Visibility(
              visible:
                  _chatSessions.contains(chatId) &&
                  c.threadSessionBlocked == null,
              maintainSize: true,
              maintainAnimation: true,
              maintainState: true,
              child: Text(
                'Your message starts its own thread and Buddy session',
                key: const ValueKey('super-chat-session-note'),
                style: DesktopChrome.metadata(color: DesktopChrome.muted),
              ),
            ),
          ),
        if (!(group?.archived ?? true))
          ListenableBuilder(
            listenable: _composer,
            builder: (context, _) {
              final pasted = pastedFolders();
              if (pasted.isEmpty) return const SizedBox.shrink();
              return Padding(
                key: const ValueKey('super-folder-path-hint'),
                padding: const EdgeInsets.fromLTRB(28, 0, 24, 10),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        pasted.length == 1
                            ? "This path is on this computer. Agents on other "
                                  "computers can't open it."
                            : "These paths are on this computer. Agents on "
                                  "other computers can't open them.",
                        style: DesktopChrome.metadata(),
                      ),
                    ),
                    TextButton(
                      onPressed: _zipping.contains(chatId) || !writable || busy
                          ? null
                          : () =>
                                unawaited(_attachFoldersAsZip(chatId, pasted)),
                      child: Text(
                        _zipping.contains(chatId)
                            ? 'Zipping…'
                            : 'Attach as zip',
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
      ],
    );
  }

  // Every message's files ask this Swarm's controller for fresh links; another
  // Swarm or account is another source, so a late answer is dropped.
  @override
  Widget build(BuildContext context) {
    _syncThreadPane();
    return SuperTabFiles(
      fresh: widget.controller.readFileLink,
      child: SuperTabImageStage(open: _openImages, child: _swarm(context)),
    );
  }

  Widget _swarm(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      grid.AppTheme.watch(context);
      final terminal = widget.terminal;
      final narrow =
          constraints.maxWidth < MediaQuery.textScalerOf(context).scale(720);
      // Wide enough for a right column beside the chat; it shows only an
      // open thread or Members, closed at rest (Quiet Swarm, 2026-11-02).
      final wide =
          constraints.maxWidth >= MediaQuery.textScalerOf(context).scale(1080);
      final thread = _threadPanel();
      final viewer = _imageViewer();
      // A thread opened since Members takes its side and closes it.
      if (thread != null) _rosterOpen = false;
      final threadDrawer = thread != null && !wide;
      final chatCovered =
          (narrow && _sidebarOpen) || (!wide && _rosterOpen) || threadDrawer;
      if (_chatCovered && !chatCovered) {
        // Both dismissing a drawer and widening the window reveal the cached
        // transcript without loading another message.
        _readVisibleTailAfterFrame();
      }
      _chatCovered = chatCovered;
      final roster = SuperTabRoster(
        // A new board is a new roster: the old one read another Swarm.
        key: ObjectKey(_board),
        controller: c,
        app: widget.app,
        board: _board,
        storage: widget.app?.localStore,
        onInvite: widget.onInvite,
        onOpenAgent: (agent) {
          setState(() {
            _showPullRequests = _showTasks = false;
            _rosterOpen = false;
            _showManage = _showNotifications = false;
          });
          (widget.onChooseAgentTerminal ?? widget.onOpenTerminal)(agent);
        },
        onAddAgent: (group) {
          setState(() => _rosterOpen = false);
          widget.onAddAgent(group);
        },
        onAnswer: (id) {
          setState(() {
            _showPullRequests = _showTasks = false;
            _rosterOpen = false;
          });
          unawaited(c.select(id));
        },
        onClose: _closeRoster,
      );
      final view = Focus(
        canRequestFocus: false,
        skipTraversal: true,
        onKeyEvent: _attentionKey,
        child: Stack(
          children: [
            ExcludeFocus(
              excluding: chatCovered,
              child: SuperTabPaneLayout(
                storage: widget.app?.localStore,
                onLeave: _leaveResize,
                left: narrow ? null : _sidebar(),
                // An open thread takes the roster's side, as in Slack.
                right: !wide ? null : thread ?? (_rosterOpen ? roster : null),
                rightDefault: thread == null
                    ? SuperTabPaneLayout.rightWidth
                    : SuperTabPaneLayout.threadWidth,
                // Over the chat, beside an open thread, as in Slack.
                over: wide ? viewer : null,
                center: Column(
                  children: [
                    _header(c.selected, narrow),
                    if (_manageOpen)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: SuperTabManageTabs(
                          selected: _devicesVisible
                              ? SuperTabManageTab.devices
                              : _manageTab,
                          devices: _hasDevices,
                          onChoose: _chooseManageTab,
                        ),
                      ),
                    Expanded(
                      child: SuperTabPages(
                        index: _devicesVisible
                            ? 1
                            : _manageVisible
                            ? 4
                            : _notificationsVisible
                            ? 3
                            : c.snapshot?.projects.isEmpty == true
                            ? 0
                            : _terminalsVisible
                            ? 1
                            : _showPullRequests
                            ? 2
                            : _showTasks
                            ? 5
                            : 0,
                        children: [
                          SuperTabImageGallery(
                            images: () => _images(_shownMessages(c.selectedId)),
                            child: _conversation(narrow),
                          ),
                          terminal ?? const SizedBox.shrink(),
                          _showPullRequests
                              ? SuperTabPullRequests(
                                  controller: c,
                                  app: widget.app,
                                  visible: !_terminalsVisible,
                                )
                              : const SizedBox.shrink(),
                          _notificationsVisible
                              ? SuperTabActivityView(
                                  activity: SuperTabActivity.of(c),
                                  onOpenMention: (mention) =>
                                      unawaited(_openMention(mention)),
                                  onOpenThread: _openThreadFromList,
                                  onOpenConversation: _openConversation,
                                  onOpenReminder: (reminder) =>
                                      unawaited(_openReminder(reminder)),
                                )
                              : const SizedBox.shrink(),
                          _manageVisible
                              ? SuperTabManagePage(
                                  controller: c,
                                  app: widget.app,
                                  board: _board,
                                  tab: _manageTab,
                                  onAddAgent: widget.onAddAgent,
                                  onOpenAgent: (agent) {
                                    setState(() => _showManage = false);
                                    (widget.onChooseAgentTerminal ??
                                            widget.onOpenTerminal)
                                        .call(agent);
                                  },
                                  onOpenConversation: _openConversation,
                                  facts: _facts,
                                )
                              : const SizedBox.shrink(),
                          _tasksPage(),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (threadDrawer)
              Positioned.fill(
                child: BlockSemantics(
                  child: GestureDetector(
                    onTap: () {
                      c.closeThread();
                    },
                    child: ColoredBox(
                      color: grid.AppDesktop.veil(Theme.of(context).brightness),
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: GestureDetector(
                          // A click inside the thread stays there.
                          onTap: () {},
                          child: SizedBox(
                            width: SuperTabPaneLayout.drawerWidth(
                              constraints.maxWidth,
                              max: SuperTabPaneLayout.threadWidth,
                            ),
                            child: thread,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            if (!wide && _rosterOpen && !threadDrawer)
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
                        color: grid.AppDesktop.veil(
                          Theme.of(context).brightness,
                        ),
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
                        color: grid.AppDesktop.veil(
                          Theme.of(context).brightness,
                        ),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: SizedBox(
                            width: 240,
                            child: Material(
                              color: grid.AppPalette.swarmWelcome,
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
            // Without a thread beside the chat, over the whole window.
            if (!wide && viewer != null)
              Positioned.fill(child: BlockSemantics(child: viewer)),
          ],
        ),
      );
      return _unreadKeys(view);
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

  // A row taken out of the tree is not measured, even before it is disposed.
  @override
  void deactivate() {
    if (widget.rows[widget.id] == context) widget.rows.remove(widget.id);
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    widget.rows[widget.id] = context;
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
