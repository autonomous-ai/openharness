import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show RenderSliverMultiBoxAdaptor, SliverMultiBoxAdaptorParentData;
import 'package:flutter/scheduler.dart' show SchedulerBinding, SchedulerPhase;
import 'package:flutter/services.dart';

import '../browser/browser_availability.dart';
import '../browser/browser_panel.dart';
import '../measurement/speed_marks.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/swarm_layout.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../shared/widgets/empty_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/new_harness_attachments.dart';
import '../widgets/new_harness_paste.dart';
import '../widgets/terminal_name_prompt.dart';
import '../widgets/terminal_prompt.dart';
import '../core/local_key_value_store.dart';
import '../core/models.dart' show Agent;
import '../core/runtime_platform.dart';
import '../logging/app_log.dart';
import '../state/app_state.dart';
import '../state/harness_attachments.dart';
import '../state/workspace_chrome.dart';
import '../shortcuts/app_keymap.dart' show KeymapRegion;
import '../shortcuts/keymap.dart' show KeymapContext;
import 'chat_find.dart';
import 'chat_scroll.dart';
import 'leaderboard/leaderboard_page.dart';
import 'leaderboard/shipping.dart';
import 'jump_to_latest.dart';
import 'unread_line.dart';
import 'profile_actions.dart';
import 'personal_agents.dart';
import 'personal_projects.dart';
import 'private_project_lock.dart';
import 'attachment_upload.dart' show kSuperTabFolderZipMaxBytes;
import 'composer_files.dart';
import 'composer_newline.dart';
import 'composer_tags.dart';
import 'attachment_chips.dart' show superTabShowsInPlace;
import 'attachment_image.dart';
import 'channel_talk.dart';
import 'places.dart';
import 'agent_state.dart';
import 'terminal_button.dart';
import '../state/harness_activity.dart';
import 'back_to_chat.dart';
import 'choose_pm.dart';
import 'controller.dart';
import 'file_links.dart';
import 'dialog_scope.dart';
import 'folder_zip.dart';
import 'model.dart';
import 'new_agent.dart' show swarmAttachAgent;
import 'agent_info.dart';
import 'identity.dart' show SuperTabAvatar;
import 'workgroup_name.dart';
import 'message_link.dart';
import 'message_link_swarms.dart';
import 'message_link_preview.dart';
import 'message_row.dart';
import 'message_receipt.dart';
import 'notifications.dart';
import 'day_pill.dart';
import 'agent_instructions.dart';
import '../core/test_run.dart';
import 'github_issues.dart';
import 'goal_score.dart';
import 'github_row.dart';
import 'instructions_link.dart';
import 'issue_panel.dart';
import 'task_board.dart';
import 'thread_panel.dart';
import 'manage_page.dart';
import 'sharing.dart';
import 'project_sidebar.dart';
import 'swarm_switcher.dart' show fallBackToPersonal;
import 'project_options.dart';
import 'pane_layout.dart';
import 'composer_actions.dart';
import 'view_room.dart';
import 'voice_recorder.dart';
import 'voice_row.dart';
import 'voice_send.dart';
import 'voice_take.dart';
import 'swarm_type.dart';
import '../terminal/terminal_font_store.dart';
import 'visible_tick.dart';
import 'chat/chat_time.dart';
import 'chat/column.dart';
import 'chat/composer_pill.dart';
import 'chat/send_button.dart';
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
    this.onNewAgent,
    this.onAttachAgent,
    this.onNewSwarm,
    this.onRenameSwarm,
    this.onChooseAgentTerminal,
    this.linkSwarms,
    this.voiceRecorder,
    this.paneStore,
    this.github,
    this.instructions,
  });
  final SuperTabController controller;

  /// Where pane widths are remembered; the app's local store when null.
  final LocalKeyValueStore? paneStore;

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

  /// + New agent (task #4196): opens the workspace's Cmd-N form with Member or
  /// Lead. Null shows no + New agent.
  final VoidCallback? onNewAgent;

  /// Attach beside + New agent (Swarm v4): the picker of agents already running on its person's own computers. Null shows
  /// no Attach.
  final VoidCallback? onAttachAgent;

  /// The existing New Swarm, for the Swarm dropdown atop the left bar; none
  /// without it.
  final VoidCallback? onNewSwarm;

  /// Rename in that dropdown, for this Swarm; none without it.
  final VoidCallback? onRenameSwarm;
  final ValueChanged<SuperTabAgent>? onChooseAgentTerminal;

  /// How a message link reaches the account's other Swarms. Without it, and
  /// without an [app], a link into another Swarm is not followed.
  final SwarmLinkSwarms? linkSwarms;

  /// Makes the microphone the composers' mic records with
  /// ([superTabVoiceRecorder]: macOS, Windows and the web); without it, no mic shows.
  final SuperTabVoiceRecorder Function()? voiceRecorder;

  /// Reads a project's tasks, its GitHub issues, with `gh` on this computer; tests give their own.
  final SwarmGitHub? github;

  /// How an agent's instructions file is asked of its computer; the app's own link unless a test brings one.
  final SwarmInstructionsLink? instructions;

  @override
  State<SuperTabView> createState() => _SuperTabViewState();
}

class _SuperTabViewState extends State<SuperTabView>
    with WidgetsBindingObserver {
  final _composer = TextEditingController();

  /// The app's own writes into [_composer], held while an input method
  /// composes in it.
  late final _composerWrites = SuperTabComposerWrites(_composer);
  final _focus = FocusNode(debugLabel: 'Swarm message');
  final _scroll = <String, SuperTabChatScroll>{};
  final _latest = <String, int>{};
  final _following = <String, bool>{};
  final _newAfter = <String, int>{};
  // Conversations whose list is scrolled away from its newest message.
  final _awayFromEnd = <String>{};
  final _unread = SuperTabUnreadLines();
  final _replies = <String, SuperTabMessage>{};

  String? _selected;
  int _scrollRequest = 0;
  bool _jumpingToEnd = false;
  bool _sidebarOpen = false;

  /// Opens the chat of an agent chosen in My agents in the middle: the Board closes and the chat takes its place.
  void _openAgentChat(String id) {
    c.leaveDevices();
    _leaveFor(id);
    setState(() {
      _page = null;
      _showManage = false;
    });
    c.select(id);
    _closeSidebar();
  }

  /// Opens the terminal of an agent chosen in My agents that has no chat to open (task #4220), as Members opens one.
  void _openAgentTerminal(SuperTabAgent agent) {
    setState(() {
      _showManage = false;
      _page = null;
    });
    (widget.onChooseAgentTerminal ?? widget.onOpenTerminal)(agent);
    _closeSidebar();
  }

  /// The panes joining the Swarm now, by the id they get in it: a pane joins once at a time.
  final _joining = <String>{};

  /// Opens a pane of the person's own listed under Your Team in their Personal Swarm (Swarm v4: every pane they run is an agent
  /// there): it joins the Swarm as Attach joins one, its 1:1 chat opens, and its terminal shows beside the chat. A refusal is
  /// said, and the next click finishes the join.
  Future<void> _openPane(PersonalAgent row) async {
    final app = widget.app;
    final controller = c;
    if (app == null || _joining.contains(row.swarmId)) return;
    // The app's: a refusal is said even when the person left this Swarm meanwhile.
    final messenger = ScaffoldMessenger.maybeOf(context);
    setState(() => _joining.add(row.swarmId));
    try {
      final chat = await swarmAttachAgent(
        app,
        controller.tabId,
        row.machineId,
        row.agent,
        name: row.name,
      );
      if (!mounted || c != controller) return;
      // The join opened its chat: what holds the middle steps aside for it.
      c.leaveDevices();
      setState(() {
        _page = null;
        _showManage = false;
      });
      _closeSidebar();
      final snapshot = controller.snapshot;
      final agentId = snapshot?.conversation(chat)?.agentIds.firstOrNull;
      final agent = agentId == null ? null : snapshot?.agent(agentId);
      if (agent != null) widget.onOpenTerminal(agent);
    } catch (failure) {
      appLog.warn(
        'super-tabs',
        'A pane could not join Your Team '
            '(${failure is SuperTabFailure ? failure.code : failure.runtimeType})',
      );
      messenger?.showSnackBar(
        SnackBar(
          content: Text(
            failure is SuperTabFailure
                ? failure.message
                : "Couldn't join. Try again.",
          ),
        ),
      );
    } finally {
      _joining.remove(row.swarmId);
      if (mounted) setState(() {});
    }
  }

  /// The Swarm's page holding the main pane, if one does: the Leaderboard.
  SwarmPage? _page;

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
  // Find in the open chat (task #2826): the search, the conversation it is
  // in, and the match last brought into view.
  SuperTabChatFind? _find;
  String? _findIn, _foundMatch;
  final _findFocus = FocusNode(debugLabel: 'Find in chat');
  final _threadFind = GlobalKey<SuperTabThreadPanelState>();
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

  /// Where a list's groups are counted from when the list divides inside a group ([_moveSplitToView]): that group's first
  /// row. Otherwise they are counted from the dividing row.
  final _groupFrom = <String, SuperTabMessage>{};
  // Each list's rebuilds around a new dividing row ([_restartAtEnd]): its
  // rows' slivers are keyed by it, so a restart lays out no old row.
  final _restarts = <String, int>{};
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

  /// What each agent of Your Team is doing, its row's one line (agent_state.dart): read where an app is.
  SwarmAgentStates? _states;

  SwarmAgentStates? _agentStates() => widget.app == null
      ? null
      : SwarmAgentStates(
          controller: c,
          github: _github,
          app: widget.app,
          localRepository: (agent) =>
              PersonalProjects.of(widget.app!).agentRepository(c, agent),
          // A test never waits for the next read of a board.
          boardEvery: kUnderTest ? null : const Duration(minutes: 1),
        );

  /// The Swarm's leaderboard, read for the left pane's Top Teams and the Leaderboard page, so both show one board. Made when
  /// first shown: a view torn down before then reads none.
  SuperTabShippingBoard? _shippingBoard;
  SuperTabShippingBoard get _shipping =>
      _shippingBoard ??= SuperTabShippingBoard(c);

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

  /// Your own message reads You, in the row and in the quote of it.
  String _shownAuthor(SuperTabController c, SuperTabMessage message) {
    if (message.authorId == c.accountId && !message.fromAgent) return 'You';
    // The controller's own snapshot names the author: a preview may be of
    // another Swarm's message.
    return c.snapshot?.authorName(message) ?? message.authorName;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _composer.addListener(_composerMoved);
    _composerWrites; // listening before anything is composed
    c.addListener(_changed);
    c.addListener(_holdVoiceAway);
    SuperTabChatNotices.of(c).chatShown = _chatShown;
    SuperTabPlaces.of(c).addListener(_takePlace);
    _registerDial();
    _states = _agentStates();
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
    // A terminal that opens shows: Manage and the pages outrank it in the pane.
    final terminalNow = widget.terminalsVisible || widget.terminal != null;
    final terminalBefore =
        oldWidget.terminalsVisible || oldWidget.terminal != null;
    if (terminalNow && !terminalBefore && !c.devicesSelected) {
      _showManage = false;
      _page = null;
    }
    if (oldWidget.controller != c) {
      _noticesLeave(oldWidget.controller);
      SuperTabPlaces.of(oldWidget.controller).removeListener(_takePlace);
      SuperTabPlaces.of(c).addListener(_takePlace);
      SuperTabChatNotices.of(c).chatShown = _chatShown;
    }
    if (oldWidget.controller != c || oldWidget.app != widget.app) {
      _dial.cancel();
      _registerDial();
      _states?.dispose();
      _states = _agentStates();
    }
    if (oldWidget.controller != c) {
      _shippingBoard?.dispose();
      _shippingBoard = null;
      oldWidget.controller.threadPaneHidden();
      oldWidget.controller.removeListener(_changed);
      oldWidget.controller.removeListener(_holdVoiceAway);
      // A take belongs to the Swarm it was recorded in.
      _voice?.discard();
      c.addListener(_changed);
      c.addListener(_holdVoiceAway);
      for (final scroll in _scroll.values) {
        scroll.dispose();
      }
      _scroll.clear();
      _split.clear();
      _groupFrom.clear();
      _restarts.clear();
      _latest.clear();
      _following.clear();
      _newAfter.clear();
      _unread.reset();
      _replies.clear();
      _jumpRequest++;
      _finding = null;
      _back = null;
      _closeFind(refocus: false);
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
      _closeFind(refocus: false);
      if (_anchors.remove(id) case final anchor?) {
        unawaited(_keepRow(id, anchor));
      }
      _dial.cancel(); // a fling from the last conversation never scrolls this one
    }
    if (_selected != id) {
      _composerWrites.cancel();
      _composer.value = TextEditingValue(
        text: draft,
        selection: TextSelection.collapsed(offset: draft.length),
      );
    } else if (_composer.text != draft) {
      // The draft changed under the box: shown at once, or once an input
      // method has finished composing, from the draft held then.
      _composerWrites.write(
        (_) => c.accessRevoked
            ? ''
            : c.selectedId == id
            ? c.draft(id)
            : null,
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
    _scroll[id]?.holdEnd(request);
    void advance(int attempt) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final scroll = _scroll[id];
        if (!mounted ||
            request != _scrollRequest ||
            c.selectedId != id ||
            scroll == null ||
            !scroll.hasClients) {
          scroll?.releaseEnd(request);
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
            scroll.releaseEnd(request);
            return;
          }
          // Short of the end, or past it: an end estimated from rows not yet
          // laid out moves once they are, and on a Mac's bouncing scroll a
          // view left past it shows no row until it springs back.
          final position = scroll.position;
          if ((position.extentAfter > 1 ||
                  position.pixels > position.maxScrollExtent + 1) &&
              attempt < 12) {
            advance(attempt + 1);
          } else {
            _jumpingToEnd = false;
            scroll.releaseEnd(request);
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
        _page != null ||
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
    final shown = _shownMessages(id);
    final index = shown.indexWhere((m) => m.id == messageId);
    return index >= 0 &&
        _estimate(position, index, shown.length) > position.pixels;
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
    final order = superTabSidebarOrder(c, app: widget.app);
    var at = order.indexOf(c.selectedId);
    if (at < 0) at = step > 0 ? -1 : order.length;
    for (var i = at + step; i >= 0 && i < order.length; i += step) {
      final group = snapshot.conversation(order[i]);
      if (group == null || !c.unreadShown(group)) continue;
      _leaveFor(group.id);
      setState(() {
        _page = null;
        _showManage = false;
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

  /// The region the view sits in, if any, with the unread chat keys added, so
  /// the keymap runs them: listed, rebindable, and ahead of Move pane only
  /// while the chat has focus.
  Widget _unreadKeys(Widget child) {
    final region = KeymapRegion.of(context);
    return KeymapRegion(
      contextKind: KeymapContext.swarmChat,
      actions: {
        ...?region?.actions,
        'swarm.next_unread': () => _jumpUnread(1),
        'swarm.previous_unread': () => _jumpUnread(-1),
        'swarm.find_in_chat': _findKey,
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
    final far = _farFromEnd(id);
    if (!c.hasNewer(id) && !far) return _followEnd(id);
    // More are waiting than were read, or the reader is far up: the latest
    // page replaces the rows read back, then its end shows. The rows on screen
    // stay until it lands, so the list is never empty (task #3630).
    unawaited(
      c.showLatest(id, replace: far).then((_) {
        if (!mounted || c.selectedId != id) return;
        _restartAtEnd(id);
        _followEnd(id);
      }),
    );
  }

  /// At most this many rows lie below a list's dividing row after a
  /// restart: all a jump to the end lays out.
  static const _restartRows = 40;

  /// Whether more rows lie below the top of [id]'s view than a restart
  /// keeps below its dividing row. A list reaches a row of unknown height
  /// only by laying out every row on the way, so a jump across thousands
  /// of them took seconds, and an end estimated from rows of very different
  /// heights left the view past the last row, showing none (Huy, #3049).
  bool _farFromEnd(String id) {
    final top = _rowAtTop();
    final own = _ownShown(id);
    final at = top == null ? -1 : own.indexWhere((m) => m.id == top);
    return at < 0 ? own.length > _restartRows : own.length - at > _restartRows;
  }

  /// Rebuilds [id]'s list around its newest rows instead of travelling to
  /// them: the dividing row moves to the newest [_restartRows], both of its
  /// slivers start empty, and the view starts at the dividing row. The rows
  /// above it read back as the reader scrolls up, as from a first open.
  void _restartAtEnd(String id) {
    final own = _ownShown(id);
    if (own.isEmpty) return;
    final first = own[(own.length - _restartRows).clamp(0, own.length - 1)];
    _split[id] = first;
    _groupFrom.remove(id);
    c.keepFrom(id, first);
    _restarts[id] = (_restarts[id] ?? 0) + 1;
    _anchors.remove(id);
    _scrollRequest++;
    _scroll[id]?.restart();
    setState(() {});
  }

  void _noticesLeave(SuperTabController controller) {
    final notices = SuperTabChatNotices.of(controller);
    if (notices.chatShown == _chatShown) notices.chatShown = null;
  }

  @override
  void dispose() {
    _noticesLeave(c);
    SuperTabPlaces.of(c).removeListener(_takePlace);
    // The controller outlives its view, reading another Swarm's replies.
    c.threadPaneHidden();
    WidgetsBinding.instance.removeObserver(this);
    _states?.dispose();
    _shippingBoard?.dispose();
    c.removeListener(_changed);
    c.removeListener(_holdVoiceAway);
    _voice?.dispose();
    for (final source in _linkSources) {
      source.removeListener(_linkSourceChanged);
    }
    _unregisterDial?.call();
    _dial.cancel();
    _litTimer?.cancel();
    _find
      ?..removeListener(_findMoved)
      ..dispose();
    _findFocus.dispose();
    _historyRetry?.cancel();
    _composerWrites.dispose();
    _composer.dispose();
    _mentionIndex.dispose();
    _dismissedMention.dispose();
    _focus.dispose();
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
    final result = await c.send(
      replyTo: _replies[id]?.id,
      // The reply goes with the message, which shows at the end at once.
      onSending: () {
        if (!mounted) return;
        setState(() => _replies.remove(id));
        _followEnd(id);
      },
    );
    if (!mounted) return;
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
        '${paths.map(folderPathText).join(' ')}'
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
      if (_composer.text.contains(folderPathText(path))) path,
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
    String withoutPaths(String text) {
      for (final folder in attached) {
        final path = folderPathText(folder);
        text = text.contains('$path ')
            ? text.replaceFirst('$path ', '')
            : text.contains(' $path')
            ? text.replaceFirst(' $path', '')
            : text.replaceFirst(path, '');
      }
      return text;
    }

    final shown = c.selectedId == id;
    dropped.removeWhere(attached.contains);
    c.setDraft(id, withoutPaths(shown ? _composer.text : c.draft(id)));
    if (shown) {
      // From the box's text when it is written: what was composed meanwhile
      // stays, the paths go.
      _composerWrites.write((current) {
        if (c.selectedId != id) return null;
        final text = withoutPaths(current);
        if (text != current) c.setDraft(id, text);
        return text;
      });
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

  void _closeSidebar() {
    setState(() => _sidebarOpen = false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_sidebarOpen && !_devicesVisible && !_terminalsVisible) {
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

  /// Older pages are read while fewer rows than this are above the view: a
  /// page takes about a second to arrive, and in a busy chat most of its
  /// rows are thread replies, so a reader who scrolled to the top waited at
  /// a spinner every few rows (#3049). Counted in rows, not pixels: the
  /// height above the rows laid out is an estimate, and one not laid out
  /// again while the view stands still.
  static const _readAheadRows = 40;

  /// The list's rows as last built, by row key: their place in it.
  Map<String, int> _rowPlaces = const {};

  /// Whether the reader is near the top of what is read: once a scroll
  /// ends, within 400 px; reading [ahead] (moving up, or pages read on),
  /// fewer than [_readAheadRows] rows above the view, never by pixels.
  bool _nearTop(ScrollMetrics metrics, {required bool ahead}) {
    if (!ahead) return metrics.extentBefore <= 400;
    final top = _rowAtTop();
    final at = top == null ? null : _rowPlaces[_rowKey(c.messageIdentity(top))];
    return at != null && at < _readAheadRows;
  }

  /// A scroll near the top reads the earlier page with no click: [ahead]
  /// while it moves up or pages read on, and once it ends. A scroll that
  /// ends at the bottom, as opening a chat does, reads nothing ahead.
  void _readEarlierNearTop(
    String id,
    ScrollMetrics metrics, {
    bool ahead = false,
  }) {
    if (!_nearTop(metrics, ahead: ahead) ||
        _finding != null ||
        _find?.reading != null) {
      return;
    }
    if (_loadingOlder.contains(id) ||
        _olderFailed.contains(id) ||
        !c.hasOlder(id)) {
      return;
    }
    WidgetsBinding.instance
      ..addPostFrameCallback((_) {
        if (mounted && c.selectedId == id && !_loadingOlder.contains(id)) {
          unawaited(_loadEarlier(id));
        }
      })
      ..scheduleFrame();
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
    // While the reader scrolls, the list keeps their place as it lays the
    // page out (SuperTabChatScroll); a jump now would cut their scroll short.
    final scrolling =
        scroll.hasClients && scroll.position.isScrollingNotifier.value;
    if (anchor != null && !scrolling) {
      await _keepRow(id, anchor, request: request);
    }
    // Still near the top once the page is laid out, as after a page of
    // thread replies: the next one.
    if (!mounted || c.selectedId != id) return;
    WidgetsBinding.instance
      ..addPostFrameCallback((_) {
        if (mounted && c.selectedId == id && scroll.hasClients) {
          _readEarlierNearTop(id, scroll.position, ahead: true);
        }
      })
      ..scheduleFrame();
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
        final shown = _shownMessages(id);
        final index = shown.indexWhere((m) => m.id == anchor.messageId);
        if (index < 0) return;
        scroll.jumpTo(_estimate(position, index, shown.length));
        continue;
      }
      if ((top - anchor.top).abs() < .5) return;
      // The list's extent is an estimate until laid out there, and the next
      // frame measures the row again. Never past the end: a jump there only
      // ends in a bounce back (#3124), and its scroll ending near the top
      // read the page before again, with no input.
      final to = (position.pixels + top - anchor.top).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      if ((to - position.pixels).abs() < .5) return;
      scroll.jumpTo(to);
    }
  }

  Future<void> _groupAction(String action, SuperTabConversation group) async {
    final c = this.c;
    if (action == 'choose-pm') {
      final project = c.snapshot?.projectFor(group.id);
      if (project != null) {
        await showChoosePm(context, c, project.id, app: widget.app);
      }
      return;
    }
    if (c.snapshot?.isProjectLead(group.id) == true) {
      final project = c.snapshot!.projectFor(group.id);
      if (project != null) await showProjectAction(context, c, project, action);
    }
  }

  /// [boardProjectId]: the project whose Board holds the middle, whose row is then lit.
  Widget _sidebar({String? boardProjectId}) => ProjectSidebar(
    leaderboard: _shipping,
    agentStates: _states,
    boardProjectId: boardProjectId,
    controller: c,
    compact: _phone,
    app: widget.app,
    onNewProject: widget.onNewProject,
    onNewAgent: widget.onNewAgent,
    onAttachAgent: widget.onAttachAgent,
    onOpenAgentChat: _openAgentChat,
    onOpenAgentTerminal: _openAgentTerminal,
    onOpenPane: _openPane,
    joining: _joining,
    onNewSwarm: widget.onNewSwarm,
    onRenameSwarm: widget.onRenameSwarm,
    page: _pageShown,
    onManage: _openManage,
    onInvite: () => showSuperTabSharing(context, c, title: 'Invite people'),
    onManageMachines: () {
      // Set before Manage opens, so a last page of Devices is not opened here only to be left at once.
      _manageTab = SuperTabManageTab.machines;
      _openManage();
      c.leaveDevices();
    },
    manageSelected: _manageOpen,
    // On every platform: the Mac's menu bar and Dock still say what waits,
    // and the sidebar lists it as Slack does (task #2996).
    onPage: _openPage,
    onSelect: (id) {
      setState(() {
        _page = null;
        _showManage = false;
      });
      // Choosing a conversation leaves the Manage pane: its Devices page left
      // the controller's flag set, so the sidebar's Manage row stayed lit while
      // a conversation was open.
      c.leaveDevices();
      c.select(id);
      _closeSidebar();
    },
  );

  /// What the menu bar asked to open ([SuperTabController.openNotice]): the chat of an agent that asks the reader.
  void _takeNotice() {
    final request = c.noticeRequest;
    if (request == null || c.snapshot == null) return;
    c.noticeRequest = null;
    setState(() {
      _page = null;
      _showManage = false;
    });
    if (request.kind == 'chat') _openConversation(request.id);
  }

  /// Shows [page] in the main pane, as its sidebar row does.
  void _openPage(SwarmPage page) {
    if (!mounted) return;
    _closeSidebar();
    c.leaveDevices();
    setState(() {
      _page = page;
      _showManage = false;
    });
    // A page outranks a terminal in the pane: the chat's terminal stays, for when its person comes back to it.
  }

  /// The page on screen: none under Devices or once access is gone.
  SwarmPage? get _pageShown =>
      _devicesVisible || c.accessRevoked ? null : _page;

  bool get _notificationsVisible => _pageShown != null;

  /// Where the reader is, for Back and Forward: a page, or the chat with the
  /// thread open beside it. Elsewhere (Manage, Tasks, pull requests) is no
  /// place of its own. A chat with its terminal open is still that chat: the
  /// terminal stays with it (`_leaveFor`), and Back from the next chat comes
  /// back to it (the review of #4213).
  SuperTabPlace? get _place {
    if (_pageShown case final page?) return SuperTabPlace.page(page);
    if (_manageOpen || c.snapshot?.conversation(c.selectedId) == null) {
      return null;
    }
    return SuperTabPlace.chat(c.selectedId, root: c.threadOnScreen);
  }

  /// Records where the reader is once this frame is drawn: a build never
  /// tells listeners (the sidebar's arrows) anything.
  void _recordPlace() {
    final place = _place;
    if (place == null) return;
    final controller = c;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && c == controller && _place == place) {
        SuperTabPlaces.of(controller).record(place);
      }
    });
  }

  /// Back or Forward asked for a place ([SuperTabPlaces.step]): go there.
  void _takePlace() {
    final place = SuperTabPlaces.of(c).takeStep();
    if (place == null || !mounted) return;
    if (place.page case final page?) return _openPage(page);
    // A step back or forward goes to a place as it was, its terminal too.
    if (!_openConversation(place.conversationId!, leave: false)) return;
    if (place.root case final root?) {
      c.openThread(root);
    } else {
      c.closeThread();
    }
  }

  /// A page or Manage holds the main pane, with no chat header.
  bool get _listViewHoldsThePane => _notificationsVisible || _manageVisible;

  bool get _manageVisible =>
      _showManage && _page == null && !_devicesVisible && !c.accessRevoked;

  /// Manage shows, on any of its pages: Devices is one of them, however it
  /// was opened.
  bool get _manageOpen => _manageVisible || _devicesVisible;

  bool get _hasDevices => widget.app?.devicesEnabled == true;

  /// The sidebar's Manage, on the page it last showed.
  void _openManage() {
    _closeSidebar();
    setState(() {
      _showManage = true;
      _page = null;
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

  /// Opens chat [conversationId] from a row of a page; false when it is
  /// gone or the reader's access is.
  bool _openConversation(String conversationId, {bool leave = true}) {
    final group = c.snapshot?.conversation(conversationId);
    if (c.accessRevoked || group == null) return false;
    if (leave) _leaveFor(conversationId);
    _closeSidebar();
    setState(() {
      _page = null;
      _showManage = false;
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
    // The app may open another chat for it (a private chat it hides): that
    // is not this message, so the reader stays where they are.
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
    _leaveFor(id);
    _closeSidebar();
    c.select(id);
    // A thread reply opens its thread; one shown only there has no row in the
    // chat to scroll to.
    if (message.threadReply) {
      c.openThread(message.thread!, at: message.id);
      if (!message.inMainStream) return;
    }
    setState(() {
      _page = null;
      _showManage = false;
      _back = null;
      _target = messageId;
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
      final shown = _shownMessages(id);
      final index = shown.indexWhere((m) => m.id == _target);
      if (scroll == null || !scroll.hasClients || index < 0 || attempt > 20) {
        return _landed(landing!);
      }
      scroll.jumpTo(_estimate(scroll.position, index, shown.length));
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
    return c.messages(id).where((m) => replies || m.inMainStream).toList();
  }

  /// [id]'s own rows as its list shows them: without its steps' rows, which
  /// are numbered in their own conversations (task steps design).
  List<SuperTabMessage> _ownShown(String id) => [
    for (final m in _shownMessages(id))
      if (m.conversationId == id) m,
  ];

  /// The row of [id]'s list that shows [messageId], its own. Null while the
  /// message is not loaded.
  String? _rowShowing(String id, String messageId) =>
      _shownMessages(id).any((m) => m.id == messageId) ? messageId : null;

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
        SnackBar(content: Text(note ?? 'Original message removed')),
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

  /// Cmd+F: the thread's find while the thread has focus, else the chat's.
  void _findKey() {
    if (_threadFind.currentState case final thread? when thread.focused) {
      return thread.openFind();
    }
    _openFind();
  }

  void _openFind() {
    final id = c.selectedId;
    if (_find != null && _findIn == id) return _findFocus.requestFocus();
    _closeFind(refocus: false);
    final find = SuperTabChatFind(
      rows: () => _shownMessages(id),
      hasOlder: () => c.hasOlder(id),
      readOlder: () async {
        final loaded = c.messages(id).length;
        await _loadEarlier(id, keep: _find?.current);
        return c.messages(id).length > loaded || !c.hasOlder(id);
      },
    )..addListener(_findMoved);
    setState(() {
      _find = find;
      _findIn = id;
    });
  }

  void _closeFind({bool refocus = true}) {
    final find = _find;
    if (find == null) return;
    find
      ..removeListener(_findMoved)
      ..clear()
      ..dispose();
    _find = null;
    _findIn = _foundMatch = null;
    if (!mounted) return;
    setState(() {});
    if (refocus) _focus.requestFocus();
  }

  /// A new current match is brought into view, as a followed link is.
  void _findMoved() {
    final find = _find, id = _findIn;
    if (find == null || id == null || !mounted) return;
    final match = find.current;
    setState(() {});
    if (match == null || match == _foundMatch) return;
    _foundMatch = match;
    setState(() {
      _target = match;
      _scrollRequest++;
      _jumpingToEnd = false;
      _follow(id, false);
    });
    _revealTarget(
      id,
      0,
      arrived: (row) => unawaited(Scrollable.ensureVisible(row, alignment: .3)),
    );
  }

  void _light(String messageId) {
    _litTimer?.cancel();
    setState(() => _lit = messageId);
    _litTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _lit = null);
    });
  }

  void _openAgent(SuperTabAgent agent) {
    widget.onOpenTerminal(agent);
  }

  void _leaveResize() {
    if (_terminalsVisible || _devicesVisible) {
      FocusManager.instance.primaryFocus?.unfocus();
      final app = widget.app, paneId = widget.app?.focusedPaneId;
      if (app != null && paneId != null) app.focusPane(paneId, reveal: true);
    } else {
      _focus.requestFocus();
    }
  }

  bool get _terminalsVisible =>
      !_devicesVisible && (widget.terminalsVisible || widget.terminal != null);

  /// The open conversation's name, or what the pane shows instead of one,
  /// named as the sidebar names it: "# openharness", or a workgroup's
  /// [SuperTabWorkgroupName].
  Widget _title(SuperTabConversation? group) {
    final style = DesktopChrome.text(medium: true);
    final project = group == null ? null : c.snapshot?.projectFor(group.id);
    final name = _manageOpen
        ? 'Manage'
        : _pageShown != null
        ? switch (_pageShown!) {
            SwarmPage.leaderboard => 'Leaderboard',
          }
        : group == null
        ? c.snapshot?.projects.isEmpty == true
              ? c.snapshot!.name
              : 'Choose a project'
        : _groupName(group);
    if (name == null) {
      return SuperTabWorkgroupName(group!, style: style);
    }
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

  /// [group]'s name as the sidebar names it: "# openharness"; null for any
  /// other conversation, named by [SuperTabWorkgroupName].
  String? _groupName(SuperTabConversation group) =>
      c.snapshot!.isProjectLead(group.id)
      ? switch (c.snapshot!.projectFor(group.id)!) {
          final project => '${project.isPrivate ? '' : '# '}${project.name}',
        }
      : null;

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
    // An agent's own chat keeps the title it was opened with; a rename changes the agent (audit finding 8 of #4436).
    if (_ownAgent(group) case final agent?) {
      return 'Message ${snapshot.agentName(agent.id, fallback: agent.name)}';
    }
    return 'Message ${group.title}';
  }

  /// The agent whose own chat [group] is (#4116), not a project's PM, whose chat is its project's.
  SuperTabAgent? _ownAgent(SuperTabConversation group) =>
      c.snapshot?.isProjectLead(group.id) == true
      ? null
      : c.snapshot?.agents.where((a) => a.chatId == group.id).firstOrNull;

  /// An agent chat's name, which its person clicks to rename it; anyone else's reads as text.
  Widget _agentTitle(SuperTabAgent agent) {
    final name = Text(
      _agentName(agent),
      key: const ValueKey('swarm-agent-name'),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: DesktopChrome.text(medium: true),
    );
    final mine = agent.myAgent ?? agent.contributorId == c.accountId;
    if (!mine || !c.canWrite) {
      return Padding(padding: SwarmLayout.nameInset, child: name);
    }
    return Tooltip(
      message: 'Rename',
      child: InkWell(
        onTap: () => _renameAgent(agent),
        borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
        child: Padding(padding: SwarmLayout.namePadding, child: name),
      ),
    );
  }

  /// Renames [agent] for everyone in the Swarm, in the app's one rename prompt.
  void _renameAgent(SuperTabAgent agent) => unawaited(
    showTerminalPrompt<void>(
      context,
      builder: (_) => TerminalNamePrompt(
        title: 'Rename agent',
        name: c.snapshot!.agentName(agent.id, fallback: agent.name),
        fieldKey: const Key('agent-rename-input'),
        fieldLabel: 'Agent name',
        save: (name) => c.renameAgent(agent.id, name),
      ),
    ),
  );

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
  /// [attach] (+) at the left, and [trailing] (the mic) and [send] at the
  /// right. Send keeps the box's
  /// bottom-right corner however long the message (Scholes, 11-03).
  Widget _composerLayout({
    required double room,
    required Widget field,
    required Widget attach,
    required List<Widget> trailing,
    required Widget send,
    Widget? voice,
  }) {
    // Too little height for a second row (a phone on its side with its keyboard
    // up): the actions take the row's end. A narrow phone with so little
    // height gets the squeezed row, which beats a composer that overflows.
    final target = _phone ? kFingerTarget : grid.AppControl.height;
    final row = composerRowInsets(target: target);
    // Desktop's composer is one pill row (anh Dee's mockup, 11-07, #4529):
    // the paperclip, the text, and at its end the mic while there is nothing
    // to send, send once there is.
    // The paperclip stays at the pill's start: without it no file could be
    // picked, only dropped or pasted.
    if (!_phone && voice == null) {
      return Row(
        key: const ValueKey('super-message-composer-actions'),
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: SwarmComposerPill(
              child: Padding(
                padding: EdgeInsets.only(
                  left: row.left,
                  right: grid.AppDesktop.composerSide,
                ),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight: grid.AppControl.heightFieldScaled,
                  ),
                  // A long draft keeps its buttons by its last line.
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      attach,
                      // One line centres on the buttons beside it.
                      Expanded(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(
                            minHeight: grid.AppControl.height,
                          ),
                          child: Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: field,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          SizedBox(
            height: grid.AppControl.heightFieldScaled,
            child: Center(
              child: ListenableBuilder(
                listenable: Listenable.merge([_composer, _files]),
                builder: (context, _) =>
                    _composer.text.trim().isNotEmpty || !_files.isEmpty
                    ? send
                    : Row(mainAxisSize: MainAxisSize.min, children: trailing),
              ),
            ),
          ),
        ],
      );
    }
    if (_phone && room < _phoneComposerTwoRowsFrom && voice == null) {
      return Padding(
        padding: EdgeInsets.only(
          left: grid.AppDesktop.composerSide,
          right: row.right,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: grid.AppControl.heightFieldScaled,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(child: field),
              attach,
              ...trailing,
              send,
            ],
          ),
        ),
      );
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: composerFieldInsets(target: target),
          child: field,
        ),
        Padding(
          padding: row,
          // A voice message under way takes the row's place (#2665).
          child:
              voice ??
              Row(
                key: const ValueKey('super-message-composer-actions'),
                children: [
                  // Only the paperclip on the left: an @ typed tags
                  // (River, 11-07, #4467).
                  attach,
                  const Spacer(),
                  ...trailing,
                  send,
                ],
              ),
        ),
      ],
    );
  }

  /// Whether [message] is said between the two parties of an agent's own chat:
  /// the reader and that chat's own agent. Its
  /// bubble carries no name or face (#4529); a line from anyone else there,
  /// such as the PM's to the reader, keeps its name.
  bool _oneOnOne(SuperTabMessage message) =>
      switch (c.snapshot?.conversation(message.conversationId)) {
        final group? when group.isAgentChat =>
          message.fromAgent
              ? group.agentIds.contains(message.authorId)
              : message.authorId == c.accountId,
        _ => false,
      };

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
      action: OutlinedButton(
        key: const ValueKey('super-project-show-panes'),
        onPressed: _openTerminals(group),
        child: const Text('Show panes'),
      ),
    );
  }

  /// Whether [group]'s empty channel offers its owner to choose its PM: a project's channel with none (anh Dee, 2026-11-11:
  /// the person chooses the PM from their agents).
  bool _offersLead(SuperTabConversation group) {
    final snapshot = c.snapshot;
    if (!c.canWrite || snapshot == null || group.archived) return false;
    if (!snapshot.isProjectLead(group.id)) return false;
    final project = snapshot.projectFor(group.id);
    // A PM New project is starting (its chat waits for it, `pmChatId`) is the one: nothing to choose meanwhile.
    return project != null &&
        project.ownerId == c.accountId &&
        project.pmChatId == null &&
        snapshot.leadOf(project.id) == null;
  }

  /// A project's empty channel with no PM: the card that chooses one, and under it its panes when it holds any.
  Widget _leadWaiting(SuperTabConversation group) => Center(
    child: SingleChildScrollView(
      padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: grid.AppDesktop.formWidth),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmPmChoose(
              onChoose: c.saving
                  ? null
                  : () {
                      final project = c.snapshot?.projectFor(group.id);
                      if (project != null) {
                        unawaited(
                          showChoosePm(context, c, project.id, app: widget.app),
                        );
                      }
                    },
            ),
            // Nothing more for a chat with no panes (rule 7, task #4465).
            if (_personalPaneCount(group) > 0) _panesWaiting(group),
          ],
        ),
      ),
    ),
  );

  /// Opens the group's terminals beside the chat; null when it has none this
  /// reader may open (a read-only viewer's terminal reads are refused).
  VoidCallback? _openTerminals(SuperTabConversation group) =>
      _terminalCount(group) > 0 && c.canWrite
      ? () => widget.onOpenGroupTerminals?.call()
      : null;

  /// On a phone, the view ⋮ opened in place of the chat, which the bar has no
  /// icon to mark as selected; null while the chat is the view.
  String? get _openViewName =>
      _menuNamesViews && _terminalsVisible ? 'Group terminals' : null;

  /// The line under the header's title: on a phone, the open view.
  Widget? get _subtitle => switch (_openViewName) {
    final view? => Text(
      view,
      key: const ValueKey('super-open-view'),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: DesktopChrome.metadata(color: DesktopChrome.foreground),
    ),
    null => null,
  };

  /// The project's task list, open beside its channel (Swarm v4).
  bool _taskListOpen = false;

  /// Which list the pane beside the channel shows: its tasks (▦), or its pull requests (⑂, anh Dee 2026-11-10).
  bool _boardPulls = false;

  /// The task open beside its channel, in place of the list: its project's channel, repository and issue number. Or a pull
  /// request opened from its task's row ([pull]), with the task it was opened from ([back]), which closing it goes back to.
  ({String channel, String repository, int number, bool pull, int? back})?
  _issue;

  /// The pull request open in place of Pull requests.
  ({String channel, String repository, int number})? _pullOpen;

  late final SwarmGitHub _github = widget.github ?? SwarmGitHub();

  late final SwarmInstructionsLink? _instructions =
      widget.instructions ??
      (widget.app == null
          ? null
          : SwarmInstructionsLink(
              widget.app!.askMachine,
              gate: widget.app!.instructionsGate,
            ));

  /// An agent's instructions file, what the app knows of it, and its own Chrome, each open beside its chat (Swarm v4). Kept
  /// per chat, as its terminal is (controller.dart besidePane): a person who opens one, goes to another chat and comes back
  /// finds it open (anh Dee, 2026-11-12). One is open at a time; setting one false closes it only when it is the one open.
  bool get _instructionsOpen => c.besidePane(c.selectedId) == 'instructions';
  set _instructionsOpen(bool open) => _beside('instructions', open);
  bool get _infoOpen => c.besidePane(c.selectedId) == 'info';
  set _infoOpen(bool open) => _beside('info', open);
  bool get _browserOpen => c.besidePane(c.selectedId) == 'browser';
  set _browserOpen(bool open) => _beside('browser', open);

  void _beside(String pane, bool open) {
    if (open) {
      c.showBeside(c.selectedId, pane);
    } else if (c.besidePane(c.selectedId) == pane) {
      c.showBeside(c.selectedId, null);
    }
  }

  /// Leaving for chat [target]: a terminal stays with the chat it was opened beside, and shows again when its person comes back
  /// (anh Dee, 2026-11-12: "i open the terminal side by side and i go to another chat and come back and the terminal is
  /// closed"). Only a move within the chat on screen closes it, so what it moves to is not under a terminal.
  void _leaveFor(String? target) {
    if (target == c.selectedId) widget.onCloseTerminal?.call();
  }

  /// Keep each pane's state (what is typed in the instructions, what the tasks read and where they are scrolled) as a window
  /// resize moves it between the right pane and the chat's place.
  final _instructionsKey = GlobalKey(), _taskBoardKey = GlobalKey();
  final _infoKey = GlobalKey();
  final _issueKey = GlobalKey();

  /// Chat, over a pane in the chat's place: the instructions, the info or the tasks close, not a pane beside.
  void _closePanesInPlace() {
    setState(() {
      _instructionsOpen = false;
      _infoOpen = false;
      _browserOpen = false;
      _closeTaskList();
    });
    _returnToChat();
  }

  /// Closes a project's tasks; the task open among them stays, where the person left it. Within setState.
  void _closeTaskList() => _taskListOpen = false;

  /// ▦ or ⑂: shows that list beside the channel, or closes the pane when it already shows it. Within setState.
  void _showBoard({required bool pulls}) {
    if (_taskListOpen && _boardPulls == pulls) return _closeTaskList();
    _taskListOpen = true;
    _boardPulls = pulls;
  }

  /// Chat, over a terminal in the chat's place: the terminal closes, and a pane beside stays.
  void _closeTerminalInPlace() {
    widget.onCloseTerminal?.call();
    _returnToChat();
  }

  /// Back in the chat, it reads to the end and its composer has the keys again, as the v3 bar's Chat did.
  void _returnToChat() {
    _readVisibleTailAfterFrame();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  /// Under 720 the list of conversations is a drawer, behind this button at the start of the bar.
  Widget _conversationsButton() => fingerTarget(
    enabled: _phone,
    AppIconButton(
      icon: AppIcons.menu,
      tooltip: 'Conversations',
      onPressed: () => setState(() => _sidebarOpen = !_sidebarOpen),
    ),
  );

  /// The agent of a person's chat with their own agent, or null.
  SuperTabAgent? _chatAgent(SuperTabConversation? group) =>
      group != null && group.isAgentChat && group.agentIds.isNotEmpty
      ? c.snapshot?.agent(group.agentIds.first)
      : null;

  /// [agent] as its machine lists it, or null when it does not.
  Agent? _machineAgent(SuperTabAgent agent) => widget.app
      ?.stateOf(agent.machineId)
      ?.agents
      .where((a) => a.id == agent.harnessId)
      .firstOrNull;

  /// Whether [agent]'s chat has Browser: it runs on one of the person's own machines, and never on the web build or
  /// Windows. A machine shared with them is another person's, and so is the login in its browser.
  bool _offersBrowser(SuperTabAgent agent) {
    final machine = widget.app?.stateOf(agent.machineId);
    final running = _machineAgent(agent)?.isStopped == false;
    final own =
        machine != null &&
        !machine.machine.isShared &&
        !machine.machine.isSharedMachine;
    return browserOffered(
      web: kIsWeb,
      windows: RuntimePlatform.isWindows,
      offersBrowser: own && running,
    );
  }

  /// A project's channel: agents post there, people read (Swarm v4). A person's chat with their own agent is the one
  /// place they write.
  bool _agentsOnly(SuperTabConversation group) =>
      c.snapshot?.isProjectLead(group.id) == true;
  bool _agentsOnlyId(String id) => switch (c.snapshot?.conversation(id)) {
    final group? => _agentsOnly(group),
    null => false,
  };

  /// Whether [id] is where Swarm v4's agents talk to each other: a project's channel, drawn as the board draws them.
  bool _agentTalk(String id) => _agentsOnlyId(id);

  /// The teammates [message] is to, by the name their tags read, and the names they are stored under where those differ: each
  /// its words do not tag by either opens its bubble.
  ({List<String> names, Map<String, String> stored}) _postTo(
    SuperTabMessage message,
  ) => _agentTalk(message.conversationId)
      ? superTabPostTo(c.snapshot, message)
      : (names: const [], stored: const {});

  /// An agent chat's header (Swarm v4): the agent, where it runs, then its instructions and its terminal, each opening
  /// beside the chat. The name takes two thirds of the room the buttons leave at most and is cut with an ellipsis, where the
  /// agent runs the rest, so a long name never pushes the buttons off the bar; under 720 the list of conversations is behind
  /// a button first, as a project's bar has it.
  Widget _agentHeader(
    SuperTabConversation group,
    SuperTabAgent agent, {
    required bool narrow,
  }) {
    final machine = widget.machineName(agent.machineId);
    // A message to it waits while its engine starts (its frame's waitingFor): its bar says so.
    final starting =
        agent.downSince == null &&
        (widget.app?.engineStarting(agent.machineId, agent.harnessId) ?? false);
    final detail = [
      machine,
      ?swarmEngineName(agent),
      if (starting) 'starting',
    ].join(' · ');
    final terminalOpen = _terminalsVisible;
    return Container(
      key: const ValueKey('swarm-agent-header'),
      constraints: const BoxConstraints(minHeight: 52),
      padding: SwarmLayout.barPadding,
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
      ),
      child: Row(
        children: [
          if (narrow) _conversationsButton(),
          SuperTabAvatar.agent(agent, size: 22, engineBadge: false),
          const SizedBox(width: 6),
          Expanded(
            child: LayoutBuilder(
              builder: (context, room) => Row(
                children: [
                  // Its person renames it here, by its name (the v3 bar's ⋮ menu is gone).
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxWidth: room.maxWidth * SwarmLayout.nameShare,
                    ),
                    child: _agentTitle(agent),
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      detail,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(),
                    ),
                  ),
                ],
              ),
            ),
          ),
          // A cut line never touches the first button.
          const SizedBox(width: 6),
          AppIconButton(
            key: const ValueKey('swarm-info-button'),
            icon: AppIcons.info,
            size: AppIcons.inlineSize,
            tooltip: 'Info',
            selected: _infoOpen,
            onPressed: () => setState(() {
              _infoOpen = !_infoOpen;
              if (_infoOpen) {
                _instructionsOpen = _browserOpen = false;
                if (terminalOpen) widget.onCloseTerminal?.call();
              }
            }),
          ),
          const SizedBox(width: 4),
          AppIconButton(
            key: const ValueKey('swarm-instructions-button'),
            icon: AppIcons.fileText,
            size: AppIcons.inlineSize,
            tooltip: 'Instructions',
            selected: _instructionsOpen,
            onPressed: () => setState(() {
              _instructionsOpen = !_instructionsOpen;
              if (_instructionsOpen) {
                _infoOpen = _browserOpen = false;
                if (terminalOpen) widget.onCloseTerminal?.call();
              }
            }),
          ),
          const SizedBox(width: 4),
          // Redrawn as its computer's daemon tells of a question, through the agents' states, which move only when a row's
          // word does: the app itself notifies on every word an agent writes.
          ListenableBuilder(
            listenable: _states ?? c,
            builder: (context, _) => SwarmTerminalButton(
              stuck: _terminalStuck(agent),
              selected: terminalOpen,
              onPressed: terminalOpen
                  ? widget.onCloseTerminal
                  : () {
                      setState(
                        () => _instructionsOpen = _infoOpen = _browserOpen =
                            false,
                      );
                      _openTerminals(group)?.call();
                    },
            ),
          ),
          if (_offersBrowser(agent)) ...[
            const SizedBox(width: 4),
            BrowserButton(
              open: _browserOpen,
              running: _machineAgent(agent)?.browser?.state == 'ready',
              onPressed: () => setState(() {
                _browserOpen = !_browserOpen;
                if (_browserOpen) {
                  _instructionsOpen = _infoOpen = false;
                  if (terminalOpen) widget.onCloseTerminal?.call();
                }
              }),
            ),
          ],
        ],
      ),
    );
  }

  /// Whether [agent]'s terminal waits on its person: a question on its screen, as its computer's daemon tells this Desktop, or a
  /// prompt its computer has seen it sit on for 3 minutes ([SuperTabAgent.atPrompt]).
  bool _terminalStuck(SuperTabAgent agent) =>
      agent.atPrompt ||
      (widget.app != null &&
          harnessActivity(widget.app!, agent.machineId, agent.harnessId) ==
              HarnessActivity.needsInput);

  Widget _header(SuperTabConversation? group, bool narrow) {
    final chatAgent = _chatAgent(group);
    if (chatAgent != null) {
      return _agentHeader(group!, chatAgent, narrow: narrow);
    }
    final isProject =
        group != null && c.snapshot?.isProjectLead(group.id) == true;
    final restsOnChat = isProject;
    // A project's goal follows its name where its menu does: on Desktop, in its own bar. A phone's bar has no room for it,
    // and a browser has no gh to read it with.
    final goalRepository =
        isProject &&
            !kIsWeb &&
            !_phone &&
            !_devicesVisible &&
            !_listViewHoldsThePane
        ? SwarmTaskBoard.repositoryOf(c, group.id)
        : null;
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
          if (narrow) _conversationsButton(),
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
                  else if (goalRepository != null)
                    // The name gives way first: the score is whole beside a long name.
                    Row(
                      children: [
                        Flexible(child: _title(group)),
                        SwarmGoalScore(
                          repository: goalRepository,
                          github: _github,
                          refreshEvery: kUnderTest
                              ? null
                              : const Duration(minutes: 5),
                        ),
                      ],
                    )
                  else
                    _title(group),
                  if (!_devicesVisible && !_listViewHoldsThePane) ?_subtitle,
                ],
              ),
            ),
          ),
          if (group != null && !_devicesVisible && !_listViewHoldsThePane) ...[
            if (!_terminalsVisible) ...[
              fingerTarget(
                enabled: _phone,
                AppIconButton(
                  key: const ValueKey('super-find-button'),
                  icon: AppIcons.search,
                  size: AppIcons.inlineSize,
                  tooltip: 'Find in chat',
                  selected: _find != null,
                  color: DesktopChrome.muted,
                  onPressed: _openFind,
                ),
              ),
              const SizedBox(width: 4),
            ],
            // A project's chat is where its header rests: the button back
            // to it shows only from another view (Quiet Swarm, screen 1).
            if (!restsOnChat || _terminalsVisible)
              fingerTarget(
                enabled: _phone,
                AppIconButton(
                  key: const ValueKey('super-chat'),
                  icon: AppIcons.messageSquare,
                  size: AppIcons.inlineSize,
                  tooltip: 'Chat',
                  selected: !_terminalsVisible,
                  color: !_terminalsVisible
                      ? DesktopChrome.foreground
                      : DesktopChrome.muted,
                  onPressed: () {
                    widget.onCloseTerminal?.call();
                    _readVisibleTailAfterFrame();
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted) _focus.requestFocus();
                    });
                  },
                ),
              ),
            if (isProject) ...[
              const SizedBox(width: 4),
              AppIconButton(
                key: const ValueKey('swarm-tasks-button'),
                icon: AppIcons.squareKanban,
                size: AppIcons.inlineSize,
                tooltip: 'Tasks',
                selected: _taskListOpen && !_boardPulls,
                color: _taskListOpen && !_boardPulls
                    ? DesktopChrome.foreground
                    : DesktopChrome.muted,
                onPressed: () => setState(() => _showBoard(pulls: false)),
              ),
              const SizedBox(width: 4),
              AppIconButton(
                key: const ValueKey('swarm-pulls-button'),
                icon: AppIcons.gitPullRequest,
                size: AppIcons.inlineSize,
                tooltip: 'Pull requests',
                selected: _taskListOpen && _boardPulls,
                color: _taskListOpen && _boardPulls
                    ? DesktopChrome.foreground
                    : DesktopChrome.muted,
                onPressed: () => setState(() => _showBoard(pulls: true)),
              ),
            ],
            if (!isProject) ...[
              const SizedBox(width: 4),
              fingerTarget(
                enabled: _phone,
                _options(group, views: _menuNamesViews),
              ),
            ],
          ],
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

  /// A project's chat header, `# name ▾`, which opens its menu (Quiet Swarm,
  /// screen 9).
  Widget _projectMenu(
    SuperTabConversation group,
    String name,
    TextStyle style,
  ) {
    final project = c.snapshot!.projectFor(group.id)!;
    Widget item(String label, VoidCallback? action, {Widget? trailing}) =>
        _menuItem(label, action, finger: _phone, trailing: trailing);
    return AppDropdown(
      width: _menuWidth,
      consumeOutsideTap: false,
      alignmentOffset: Offset.zero,
      children: [
        // Swarm v4 (anh Dee, 2026-11-09): a project has its settings and nothing else; notifications are v3 (agents
        // talk to agents).
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
    SuperTabProject opened,
  ) => showProjectSettings(
    context,
    c,
    opened,
    () => _projectSettingsRows(
      group,
      c.snapshot?.projectById(opened.id) ?? opened,
    ),
    app: widget.app,
    rowHeight: _phone ? kFingerTarget : 32,
  );

  /// Project settings' rows from what is held now: the dialog asks again on each change (task #4705).
  List<ProjectSettingsRow> _projectSettingsRows(
    SuperTabConversation group,
    SuperTabProject project,
  ) {
    final editable = c.canWrite && !c.saving && !c.hasPendingAction;
    final owner = project.ownerId == c.accountId;
    void act(String action) => unawaited(_groupAction(action, group));
    ProjectSettingsRow row(
      String label,
      String action, {
      String? value,
      bool danger = false,
    }) =>
        (label: label, value: value, action: () => act(action), danger: danger);
    // Each value from what is held already, in Project details' own words
    // (task #3194).
    final repository = project.repository;
    final leadId = c.snapshot?.conversation(project.leadConversationId)?.leadId;
    return [
      if (editable && owner)
        row('Rename project', 'rename', value: project.name),
      row(
        'Project details',
        'details',
        value:
            repository?['repositoryUrl'] as String? ??
            repository?['cwd'] as String? ??
            'Not set',
      ),
      // Its owner chooses its PM from their own agents (backend `project.pm`).
      if (editable && owner)
        row(
          'Product Manager',
          'choose-pm',
          value: leadId != null
              ? c.snapshot!.agentName(leadId)
              : project.pmChatId != null
              ? 'Starting…'
              : 'None',
        ),
      if (editable && owner) row('Delete Project', 'delete', danger: true),
    ];
  }

  /// The group's ⋮ menu. With [views] (a phone) it opens on the views the
  /// header has no room for — the group's terminals —
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
          const AppMenuDivider(),
        ],
        if (editable)
          // An agent's own chat renames the agent, whose name its header shows (audit finding 16 of #4436).
          if (_ownAgent(group) case final agent?)
            item('Rename', () => _renameAgent(agent)),
        _notifyMenu(group),
      ],
      builder: (context, menu, _) => AppIconButton(
        key: const ValueKey('super-group-options'),
        icon: AppIcons.ellipsis,
        tooltip: _ownAgent(group) != null
            ? 'Agent options'
            : 'Workgroup options',
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

  /// More ▸ Edit message, saved: a refusal says why, and the row keeps the
  /// text it had.
  Future<void> _editMessage(SuperTabMessage message, String text) async {
    final failure = await c.editMessage(message, text);
    if (failure == null || !mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(failure)));
  }

  /// More ▸ Delete message: asks first, and only Delete sends it.
  Future<void> _deleteMessage(SuperTabMessage message) async {
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (context) => SuperTabDialogScope(
        controller: c,
        conversationId: message.conversationId,
        child: AlertDialog(
          title: const Text('Delete message?'),
          content: Text("This can't be undone.", style: DesktopChrome.text()),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const ValueKey('super-message-delete-confirm'),
              style: FilledButton.styleFrom(
                backgroundColor: grid.AppPalette.dangerFill,
              ),
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Delete'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !mounted) return;
    final failure = await c.deleteMessage(message);
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
    bool joinsBelow = false,
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
        joinsBelow: joinsBelow,
        oneOnOne: _oneOnOne(message),
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
  // One list for every row: each reads its several-word names once for a
  // list (message_text.dart).
  List<String> _agentNames = const [];
  void _index() {
    final snapshot = c.snapshot;
    if (identical(snapshot, _indexed)) return;
    _indexed = snapshot;
    _references = {
      for (final g in snapshot?.conversations ?? <SuperTabConversation>[])
        if (g.number != null) g.number!: g.id,
    };
    // Each agent's tag as it is written: its own name, which a PM's role name is not ("@Ray", stored as Product Manager).
    _agentNames = [
      for (final agent in snapshot?.agents ?? const <SuperTabAgent>[]) ...{
        agent.name,
        ?agent.displayName,
      },
    ];
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
    bool joinsBelow = false,
  }) {
    _index();
    if (SuperTabGitHubRow.shows(message)) {
      // What GitHub said to a person's agent is the person's news, in their chat with it.
      return SuperTabGitHubRow(
        key: ValueKey(
          '${inThread ? 'super-thread-message' : 'super-message'}-${message.id}',
        ),
        message: message,
      );
    }
    final agent = message.fromAgent
        ? c.snapshot?.agent(message.authorId)
        : null;
    final answers = message.replyTo;
    // An original outside the pages read is read by itself for its quote.
    final quoted = answers == null || byId.containsKey(answers)
        ? null
        : c.quoted(message.conversationId, answers);
    final reply = byId[answers] ?? quoted?.message;
    final to = _postTo(message);
    final writable = c.canWrite && c.selected?.archived == false;
    final root = message.thread;
    final thread = inThread || root != message.id
        ? null
        : c.thread(message.conversationId, message.id);
    return SuperTabMessageRow(
      key: ValueKey(
        '${inThread ? 'super-thread-message' : 'super-message'}-${message.id}',
      ),
      message: message,
      joinsBelow: joinsBelow,
      oneOnOne: _oneOnOne(message),
      to: to.names,
      storedNames: to.stored,
      author: _shownAuthor(c, message),
      // A person is found by their username, as they are tagged, and reads
      // as the name they set.
      mentions: [
        for (final id in message.mentions)
          if (_people[id] case final person?) person.username,
      ],
      agentNames: _agentNames,
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
        setState(() {
          // From a page, the chat comes forward: changing only the chat
          // behind the page left the link looking dead (#3751).
          _page = null;
        });
        c.select(id);
        c.selectTerminal(id, null);
      },
      agent: agent,
      person: message.fromAgent ? null : _people[message.authorId],
      member: _member,
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
      // Only the author's own plain message (the server decides): its edit not where only agents post.
      onEdit: c.canEdit(message) ? (text) => _editMessage(message, text) : null,
      onDelete: c.canChange(message)
          ? () => unawaited(_deleteMessage(message))
          : null,
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
      onOpenThread:
          !inThread && root != null && (thread != null || message.threadReply)
          ? () => c.openThread(root)
          : null,
      onReturnToComposer: _focus.requestFocus,
      readerId: c.accountId,
      receipts: [
        if (message.source['truncated'] == true ||
            message.source['interrupted'] == true)
          SuperTabPostNote(
            message.source['truncated'] == true
                ? 'Excerpt · open the terminal for the full response'
                : 'Response interrupted',
          ),
        if (_agentTalk(message.conversationId))
          if (superTabPostOfflineLine(c.snapshot, message) case final line?)
            SuperTabPostNote(
              line,
              key: ValueKey('super-message-offline-${message.id}'),
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
              final group = c.selected;
              if (group == null) return;
              // A project's channel: its PM is chosen from its owner's agents, never started here.
              if (c.snapshot?.isProjectLead(group.id) == true) {
                final project = c.snapshot!.projectFor(group.id);
                if (project != null) {
                  unawaited(
                    showChoosePm(context, c, project.id, app: widget.app),
                  );
                }
                return;
              }
              widget.onAddAgent(group);
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
        key: _threadFind,
        controller: c,
        root: open.root,
        row: (message, grouped) =>
            _message(message, grouped, byId, inThread: true),
        // The thread panel groups its own rows; one on its way keeps its name.
        outgoing: (sent) => _outgoingRow(sent, byId, grouped: false),
        machineName: widget.machineName,
        onScroll: (list) => _threadScroll = list,
        voice: _voice,
        agentsOnly: _agentsOnlyId(open.conversationId),
      ),
    );
  }

  /// What the Swarm cannot read, with Retry, over whatever the middle holds: a chat, a Board or a page (audit finding 7
  /// of task #4211; it was drawn in the chat column only, so the Board and the pages looked live while offline).
  Widget _connectionLine(SuperTabController c) {
    if (c.error == null) return const SizedBox.shrink();
    return Padding(
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
          if (!c.accessRevoked)
            TextButton(
              onPressed: () => unawaited(c.retryRead()),
              child: const Text('Retry'),
            ),
        ],
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
          if (!c.accessRevoked) ...[
            const SizedBox(height: 12),
            TextButton(
              style: _thumb,
              onPressed: () => unawaited(c.retryRead()),
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
  int _splitAt(String id, List<SuperTabMessage> messages) {
    if (messages.isEmpty) return 0;
    final split = _split[id];
    final at = split == null
        ? -1
        : messages.indexWhere((m) => superTabMessageOrder(m, split) >= 0);
    if (at >= 0) return at;
    _split[id] = messages.first;
    _groupFrom.remove(id);
    c.keepFrom(id, messages.first);
    return 0;
  }

  /// Rows below the dividing row before a reader at the end has it moved to
  /// the rows on screen ([_moveSplitToView]).
  static const _rowsBelowSplit = 200;

  /// For a reader at the end of [id]: moves the dividing row down to the
  /// first row of the group at the top edge of the view, its place
  /// unchanged, so the controller may cut the rows above (it never cuts below
  /// it). From a group's first row the groups below stay as they were; only
  /// rows above the view can regroup. When that row is above the rows laid out
  /// (a group taller than the room above the view), the list divides at the row
  /// at the top edge, which always is, and its groups are still counted from the
  /// group's first row ([_groupFrom]), where the cut stops: before, the dividing
  /// row never moved there, and nothing was ever cut.
  void _moveSplitToView(String id, SuperTabChatScroll scroll) {
    final split = _split[id];
    if (split == null) return;
    final messages = _ownShown(id);
    final at = messages.indexWhere((m) => superTabMessageOrder(m, split) >= 0);
    final top = _rowAtTop();
    if (at < 0 || messages.length - at <= _rowsBelowSplit || top == null) {
      return;
    }
    final joined = _joined(messages, _groupFrom[id] ?? split);
    final topAt = messages.indexWhere((m) => m.id == top);
    var index = topAt;
    while (index > at && joined.contains(messages[index].id)) {
      index--;
    }
    if (index <= at) return;
    final first = messages[index];
    final groupLaidOut = _offsetInList(_built[first.id]);
    final divide = groupLaidOut == null ? messages[topAt] : first;
    final offset = groupLaidOut ?? _offsetInList(_built[top]);
    if (offset == null) return;
    // Its row starts the newer rows now: the rows are measured from it.
    scroll.moveContent(-offset);
    _split[id] = divide;
    if (divide == first) {
      _groupFrom.remove(id);
    } else {
      _groupFrom[id] = first;
    }
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
    // A task (a message with a thread, Swarm v4) stands on its own row, with its name and face, as a tagged one does; so
    // does a post to a teammate, its name over its tags. That reads the message alone, so no roster change regroups a row.
    final talk =
        messages.isNotEmpty && _agentTalk(messages.first.conversationId);
    bool tagged(SuperTabMessage m) =>
        (talk && m.namesAgents) ||
        switch (c.thread(m.conversationId, m.id)) {
          final thread? => thread.replies > 0,
          null => false,
        };
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

  /// A chat's rows, composer and the notes around them sit in one centred column ([SwarmChatColumn], anh Dee
  /// 2026-11-09). Everything the chat draws between its list and the window's edge, a note under the list included, goes
  /// through here; the bars over the list and the buttons floating on it stay the pane's width.
  Widget _inColumn(Widget child) => SwarmChatColumn(child: child);

  Widget _conversation(bool narrow) {
    // The Desktop keeps an agent's chat open in a Swarm with no projects; with none open, there is nothing to load and
    // the way to start shows instead (task #4219).
    if (c.selected == null &&
        c.snapshot?.projects.isEmpty == true &&
        !c.accessRevoked) {
      // The same + New agent as the left pane's: the Cmd-N form (task #4196).
      final newAgent = widget.onNewAgent;
      final newProject = widget.onNewProject;
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // One sentence for both ways to start (audit finding 20, #4445).
              Text(
                newAgent != null
                    ? 'Start a project, or bring an agent to work with you.'
                    : 'Create a project to get started.',
                style: DesktopChrome.text(color: DesktopChrome.muted),
              ),
              if (newProject != null || newAgent != null) ...[
                const SizedBox(height: 12),
                // Both in one style and one width, so neither reads as the lesser choice.
                IntrinsicWidth(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (newProject != null)
                        TextButton.icon(
                          style: _thumb,
                          onPressed: c.canWrite ? newProject : null,
                          icon: const Icon(AppIcons.plus, size: 16),
                          label: const Text('New project'),
                        ),
                      if (newProject != null && newAgent != null)
                        const SizedBox(height: 8),
                      if (newAgent != null)
                        TextButton.icon(
                          key: const ValueKey('super-empty-new-agent'),
                          style: _thumb,
                          onPressed: c.canWrite ? newAgent : null,
                          icon: const Icon(AppIcons.plus, size: 16),
                          label: const Text('New agent'),
                        ),
                    ],
                  ),
                ),
              ],
              if (c.operationError != null) ...[
                const SizedBox(height: 12),
                Text(c.operationError!, style: DesktopChrome.metadata()),
              ],
              if (c.hasPendingAction)
                TextButton(
                  onPressed: c.saving ? null : c.retry,
                  child: const Text('Check again'),
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
    final byId = {for (final message in messages) message.id: message};
    final rowIndex = {
      for (final (index, message) in messages.indexed)
        _rowKey(c.messageIdentity(message.id)): index,
    };
    _rowPlaces = rowIndex;
    // A row stays the same row as pages arrive above it, state and all.
    int? rowOf(Key key) => key is ValueKey<String> ? rowIndex[key.value] : null;
    final split = _splitAt(c.selectedId, ownMessages);
    // Rows on their way group by the same rule, so a quick line keeps the
    // shape it will have once confirmed; one Not sent keeps its name and
    // actions.
    final grouped =
        _joined(
          ownWithOutgoing,
          _groupFrom[c.selectedId] ?? _split[c.selectedId],
        )..removeWhere(
          (id) => switch (pendingById[id]?.state) {
            SuperTabOutgoingState.refused ||
            SuperTabOutgoingState.unconfirmed => true,
            _ => false,
          },
        );
    // Find matches the rows as they are drawn now.
    final search = _findIn == c.selectedId ? (_find?..refresh()) : null;
    Widget row(int index) {
      final message = messages[index];
      final previous = index > 0 ? messages[index - 1] : null;
      // Grouping is decided on the task's own rows; a step's row drawn between
      // two of them still ends the group, or the next would read as its agent's.
      final joined =
          grouped.contains(message.id) &&
          previous?.conversationId == message.conversationId;
      final next = index + 1 < messages.length ? messages[index + 1] : null;
      final joinsBelow =
          next != null &&
          grouped.contains(next.id) &&
          next.conversationId == message.conversationId &&
          next.id != _unread.lineAt(c.selectedId);
      final time = message.createdAt;
      return SuperTabDayMark(
        key: ValueKey(_rowKey(c.messageIdentity(message.id))),
        time: time,
        child: _inColumn(
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (time != null &&
                  !DateUtils.isSameDay(
                    time.toLocal(),
                    previous?.createdAt?.toLocal(),
                  ))
                _date(time),
              if (time != null &&
                  SwarmChatTime.after(previous?.createdAt, time))
                SwarmChatTime(
                  time,
                  key: ValueKey('swarm-chat-time-${message.id}'),
                ),
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
                    on: message.id == _lit || message.id == search?.current,
                    match: search?.matching.contains(message.id) ?? false,
                    child: pendingById.containsKey(message.id)
                        ? _outgoingRow(
                            pendingById[message.id]!,
                            byId,
                            grouped: joined,
                            joinsBelow: joinsBelow,
                          )
                        : _message(
                            message,
                            joined,
                            byId,
                            showReceipt: message.id == latestOwn?.id,
                            joinsBelow: joinsBelow,
                          ),
                  ),
                ),
              ),
            ],
          ),
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
    return Column(
      children: [
        if (search != null)
          SuperTabFindBar(
            key: ValueKey('super-find-$chatId'),
            find: search,
            focus: _findFocus,
            onClose: _closeFind,
          ),
        if (!unread) _connectionLine(c),
        Expanded(
          child: c.loading
              ? const Center(child: CircularProgressIndicator())
              : unread && c.error != null
              ? _firstReadFailed(c.error!)
              : messages.isEmpty &&
                    outgoing.isEmpty &&
                    !c.accessRevoked &&
                    group != null &&
                    _offersLead(group)
              ? _leadWaiting(group)
              : messages.isEmpty &&
                    outgoing.isEmpty &&
                    !c.accessRevoked &&
                    group != null &&
                    _personalPaneCount(group) > 0
              ? _panesWaiting(group)
              : messages.isEmpty && outgoing.isEmpty
              ? switch (c.accessRevoked
                    ? 'Conversation unavailable.'
                    : group == null
                    ? 'Loading conversation…'
                    // A project's channel nobody has posted in says why: an empty page under the project's name read as broken
                    // (anh Dee, 2026-11-09).
                    : c.snapshot?.isProjectLead(group.id) == true &&
                          c.messagesRead(group.id)
                    ? superTabEmptyChannel
                    // Empty means empty (anh Dee's rule 7, task #4465): no words for a chat with nothing in it.
                    : null) {
                  final words? => SuperTabEmptyWords(words),
                  null => const SizedBox.expand(),
                }
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
                            child: NotificationListener<ScrollNotification>(
                              onNotification: (event) {
                                if (event.depth != 0) return false;
                                if (event is ScrollStartNotification &&
                                    event.dragDetails != null) {
                                  _scrollRequest++;
                                  _jumpingToEnd = false;
                                  _scroll[c.selectedId]?.holdEnd(null);
                                }
                                if (_jumpingToEnd) return false;
                                final id = c.selectedId;
                                final atEnd = event.metrics.extentAfter < 40;
                                _follow(id, atEnd);
                                // Moving up, or once the scroll ends.
                                if (event is ScrollEndNotification) {
                                  _readEarlierNearTop(id, event.metrics);
                                } else if (event is ScrollUpdateNotification &&
                                    (event.scrollDelta ?? 0) < 0) {
                                  _readEarlierNearTop(
                                    id,
                                    event.metrics,
                                    ahead: true,
                                  );
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
                                      key: ValueKey(
                                        'super-older-rows-${_restarts[c.selectedId] ?? 0}',
                                      ),
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
                                        key: ValueKey(
                                          'super-newer-rows-${_restarts[c.selectedId] ?? 0}',
                                        ),
                                        delegate: SliverChildBuilderDelegate(
                                          // Messages on their way end the list.
                                          (context, index) =>
                                              row(split + index),
                                          childCount: messages.length - split,
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
          _inColumn(
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
            ),
          )
        else if (c.operationNotice != null)
          _inColumn(
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Text(
                c.operationNotice!,
                key: const ValueKey('super-operation-notice'),
                style: DesktopChrome.control(),
              ),
            ),
          ),
        if (reply != null)
          _inColumn(
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
          ),
        ListenableBuilder(
          listenable: completing,
          builder: (context, _) {
            final choices = _completionChoices;
            if (choices.isEmpty) return const SizedBox.shrink();
            return _inColumn(
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
                child: SuperTabCompletionList(
                  listKey: const ValueKey('super-composer-completions'),
                  choices: choices,
                  index: _mentionIndex.value,
                  rowKeys: _completionKeys,
                ),
              ),
            );
          },
        ),
        // Swarm v4 (anh Dee 2026-11-08): only agents post in a project's channel and its tasks' chats. People talk to
        // their own agents.
        if (group != null && _agentsOnly(group))
          // It holds the chat's focus in the composer's place, so the chat's keys (find and unread) work.
          Focus(
            focusNode: _focus,
            child: GestureDetector(
              onTap: _focus.requestFocus,
              child: _inColumn(
                Container(
                  key: const ValueKey('super-agents-only'),
                  margin: SwarmLayout.agentsOnlyMargin,
                  height: 40,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: grid.AppSurface.recess,
                    borderRadius: BorderRadius.circular(SwarmLayout.cardRadius),
                  ),
                  child: Text(
                    'Only agents post here. To change what happens, talk to your agents.',
                    style: DesktopChrome.metadata(),
                  ),
                ),
              ),
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
            builder: (context, field) => _inColumn(
              Padding(
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
                          KeyedSubtree(
                            key: const ValueKey('super-message-composer-box'),
                            child: field!,
                          ),
                        ],
                      )
                    : field,
              ),
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
                // Desktop's pill is drawn around the text alone, with
                // the mic or send beside it (#4529); a phone's box holds
                // its whole row.
                key: _phone
                    ? const ValueKey('super-message-composer-surface')
                    : null,
                decoration: _phone
                    ? SwarmComposerPill.decoration
                    : const BoxDecoration(),
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
                                      : c.canWrite && !group.archived
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
                              ),
                            ),
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
                              final voice? when voice.activeIn(chatId, null) =>
                                SuperTabVoiceRow(
                                  key: const ValueKey('super-voice-row'),
                                  take: voice,
                                ),
                              _ => null,
                            },
                            send: ListenableBuilder(
                              listenable: Listenable.merge([_composer, _files]),
                              builder: (context, _) => fingerTarget(
                                enabled: _phone,
                                SwarmSendButton(
                                  tooltip: 'Send message',
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
                            padding: const EdgeInsets.fromLTRB(
                              grid.AppDesktop.composerSide,
                              grid.AppDesktop.controlGap,
                              grid.AppDesktop.composerSide,
                              grid.AppDesktop.controlGap,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        if (!(group?.archived ?? true))
          ListenableBuilder(
            listenable: _composer,
            builder: (context, _) {
              final pasted = pastedFolders();
              if (pasted.isEmpty) return const SizedBox.shrink();
              return _inColumn(
                Padding(
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
                        onPressed:
                            _zipping.contains(chatId) || !writable || busy
                            ? null
                            : () => unawaited(
                                _attachFoldersAsZip(chatId, pasted),
                              ),
                        child: Text(
                          _zipping.contains(chatId)
                              ? 'Zipping…'
                              : 'Attach as zip',
                        ),
                      ),
                    ],
                  ),
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
    _recordPlace();
    // Every pane here reads at the terminal's size, and is drawn again when it changes (anh Dee, 2026-11-10).
    return SwarmTextSize(
      notifier: terminalFontStore,
      child: SuperTabFiles(
        fresh: widget.controller.readFileLink,
        child: SuperTabImageStage(open: _openImages, child: _swarm(context)),
      ),
    );
  }

  Widget _swarm(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      grid.AppTheme.watch(context);
      final terminal = widget.terminal;
      final thread = _threadPanel();
      // Swarm v4: a project's tasks beside its channel, and a task opened from them in their place.
      final taskList =
          _taskListOpen && c.snapshot?.isProjectLead(c.selectedId) == true;
      final pullOpen = _pullOpen;
      final opened = _boardPulls
          ? pullOpen == null
                ? null
                : (
                    channel: pullOpen.channel,
                    repository: pullOpen.repository,
                    number: pullOpen.number,
                    pull: true,
                    back: null,
                  )
          : _issue;
      final issue = taskList && opened != null && opened.channel == c.selectedId
          ? KeyedSubtree(
              key: _issueKey,
              child: SwarmIssuePanel(
                key: ValueKey(
                  'swarm-issue-${opened.repository}-${opened.number}',
                ),
                controller: c,
                github: _github,
                repository: opened.repository,
                number: opened.number,
                pull: opened.pull,
                refreshEvery: kUnderTest ? null : const Duration(seconds: 30),
                // A task's pull request row opens the pull request's own chat in the task's place.
                onOpenPull: opened.pull
                    ? null
                    : (number) => setState(
                        () => _issue = (
                          channel: opened.channel,
                          repository: opened.repository,
                          number: number,
                          pull: true,
                          back: opened.number,
                        ),
                      ),
                onClose: () => setState(() {
                  if (_boardPulls) {
                    _pullOpen = null;
                  } else {
                    _issue = switch (opened.back) {
                      final back? => (
                        channel: opened.channel,
                        repository: opened.repository,
                        number: back,
                        pull: false,
                        back: null,
                      ),
                      null => null,
                    };
                  }
                }),
              ),
            )
          : null;
      final taskBoard = taskList
          ? SwarmTaskBoard(
              key: _taskBoardKey,
              controller: c,
              conversationId: c.selectedId,
              github: _github,
              pulls: _boardPulls,
              openNumber: _boardPulls ? null : _issue?.number,
              refreshEvery: kUnderTest ? null : const Duration(minutes: 1),
              onOpen: (repository, opened) => setState(() {
                _issue = (
                  channel: c.selectedId,
                  repository: repository,
                  number: opened.number,
                  pull: false,
                  back: null,
                );
              }),
              onOpenPull: (repository, number) => setState(
                () => _pullOpen = (
                  channel: c.selectedId,
                  repository: repository,
                  number: number,
                ),
              ),
              onClose: () => setState(_closeTaskList),
            )
          : null;
      final viewer = _imageViewer();
      final scale = MediaQuery.textScalerOf(context);
      final wide =
          constraints.maxWidth >= scale.scale(SuperTabPaneLayout.twoPanesFrom);
      final threadDrawer = thread != null && !wide;
      // A terminal on screen keeps its chat beside it, in the right pane, as
      // a thread sits; a thread takes that side, and a narrow window shows
      // one at a time (Huy, 11-04, #2792). A v4 terminal needs about 480 of
      // its own, so it sits beside from a little wider than the text panes do.
      // A Swarm with no projects shows the way to start in the chat's place, unless v4 keeps an agent's chat open there
      // (task #4219): that chat's panes and terminal open as in any other Swarm.
      final empty = c.snapshot?.projects.isEmpty == true && c.selected == null;
      final chatBeside =
          wide &&
          constraints.maxWidth >=
              scale.scale(SuperTabPaneLayout.terminalBesideFrom) &&
          thread == null &&
          terminal != null &&
          _terminalsVisible &&
          !_manageVisible &&
          !_notificationsVisible &&
          !empty;
      final narrow = constraints.maxWidth < scale.scale(720);
      final instructionsAgent = _instructionsOpen
          ? _chatAgent(c.selected)
          : null;
      // Kept by its key where the pane moves between the right pane and the chat's place, so what is typed in it stays.
      final instructions = instructionsAgent == null
          ? null
          : SwarmAgentInstructions(
              key: _instructionsKey,
              agent: instructionsAgent,
              link: _instructions,
              machineName: widget.machineName(instructionsAgent.machineId),
              onClose: () => setState(() => _instructionsOpen = false),
            );
      final infoAgent = _infoOpen ? _chatAgent(c.selected) : null;
      final browserAgent = _browserOpen ? _chatAgent(c.selected) : null;
      final browser = browserAgent == null || !_offersBrowser(browserAgent)
          ? null
          : BrowserPanel(
              // A new agent's panel is a new panel: the stream is that agent's.
              key: ValueKey(
                'browser-${browserAgent.machineId}/${browserAgent.harnessId}',
              ),
              app: widget.app!,
              machineId: browserAgent.machineId,
              agentId: browserAgent.harnessId,
              thisComputer:
                  widget.app!.stateOf(browserAgent.machineId)?.isLocalMachine ==
                  true,
              onClose: () => setState(() => _browserOpen = false),
            );
      final info = infoAgent == null
          ? null
          : SwarmAgentInfo(
              key: _infoKey,
              controller: c,
              agent: infoAgent,
              machineName: widget.machineName(infoAgent.machineId),
              github: _github,
              app: widget.app,
              refreshEvery: kUnderTest ? null : const Duration(minutes: 1),
              onClose: () => setState(() => _infoOpen = false),
            );
      // What a person opened beside the chat: where two panes do not fit, it takes the chat's place, under Chat, and comes
      // before a terminal there as it does in the right pane.
      final pane = issue ?? taskBoard ?? instructions ?? info ?? browser;
      final pagesIndex = _devicesVisible
          ? 1
          : _manageVisible
          ? 3
          : _notificationsVisible
          ? 2
          : pane != null && !wide
          ? 4
          : empty
          ? 0
          : _terminalsVisible && !chatBeside
          ? 1
          : 0;
      final chat = SuperTabImageGallery(
        images: () => _images(_shownMessages(c.selectedId)),
        child: _conversation(narrow),
      );
      final chatCovered = (narrow && _sidebarOpen) || threadDrawer;
      // A pane in the chat's place covers it as a drawer does, and keeps its own focus.
      final covered = chatCovered || pagesIndex == 4;
      if (_chatCovered && !covered) {
        // Both dismissing a drawer and widening the window reveal the cached
        // transcript without loading another message.
        _readVisibleTailAfterFrame();
      }
      _chatCovered = covered;
      final view = Focus(
        canRequestFocus: false,
        skipTraversal: true,
        onKeyEvent: _attentionKey,
        child: Stack(
          children: [
            // One surface under the left, middle and right panes, split only by the layout's hairlines (anh Dee's six
            // rules, task #4465): no pane shows its host's colour.
            Positioned.fill(
              child: ColoredBox(color: grid.AppPalette.swarmField),
            ),
            ExcludeFocus(
              excluding: chatCovered,
              child: SuperTabPaneLayout(
                storage: widget.paneStore ?? widget.app?.localStore,
                onLeave: _leaveResize,
                left: narrow ? null : _sidebar(),
                // An open thread takes the right side, as in Slack.
                right: !wide
                    ? null
                    : issue ??
                          thread ??
                          taskBoard ??
                          instructions ??
                          info ??
                          browser ??
                          (chatBeside ? terminal : null),
                rightDefault: thread == null && !chatBeside
                    ? SuperTabPaneLayout.rightWidth
                    : SuperTabPaneLayout.threadWidth,
                // Swarm v4: a task's thread or a terminal opens beside what you read, at equal width.
                rightHalf:
                    thread != null ||
                    chatBeside ||
                    _taskListOpen ||
                    instructionsAgent != null ||
                    infoAgent != null ||
                    browser != null,
                // Over the chat, beside an open thread, as in Slack.
                over: wide ? viewer : null,
                // A project's own chat keeps its header and tabs (Project options, Tasks): the full chat view.
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
                    // Where two panes do not fit, a pane in the chat's place leads back to it.
                    if (pagesIndex == 4)
                      SwarmBackToChat(onBack: _closePanesInPlace)
                    else if (pagesIndex == 1 && _terminalsVisible)
                      SwarmBackToChat(onBack: _closeTerminalInPlace),
                    // The chat draws the line itself, and a terminal's chat beside it answers for the terminal's own
                    // connection; every other surface in the middle gets it here.
                    if (pagesIndex != 0 &&
                        !_terminalsVisible &&
                        !(_readsFirst && c.snapshot == null))
                      _connectionLine(c),
                    Expanded(
                      child: SuperTabPages(
                        index: pagesIndex,
                        children: [
                          chat,
                          // Beside an agent's chat the terminal is in the right pane, and one widget is in one place.
                          chatBeside
                              ? const SizedBox.shrink()
                              : terminal ?? const SizedBox.shrink(),
                          switch (_pageShown) {
                            SwarmPage.leaderboard => SuperTabLeaderboardPage(
                              key: ObjectKey(_shipping),
                              controller: c,
                              reader: _shipping,
                              machineName: widget.machineName,
                            ),
                            null => const SizedBox.shrink(),
                          },
                          _manageVisible
                              ? SuperTabManagePage(
                                  controller: c,
                                  app: widget.app,
                                  tab: _manageTab,
                                  onAddAgent: widget.onAddAgent,
                                  onOpenAgent: (agent) {
                                    setState(() => _showManage = false);
                                    (widget.onChooseAgentTerminal ??
                                            widget.onOpenTerminal)
                                        .call(agent);
                                  },
                                )
                              : const SizedBox.shrink(),
                          // Beside the chat the pane is in the right pane, and one widget is in one place. It is built only while
                          // it shows, so a hidden board reads nothing from GitHub.
                          pagesIndex == 4 ? pane! : const SizedBox.shrink(),
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
                              color: grid.AppPalette.swarmSidebar,
                              elevation: 8,
                              // The same lit row as the left pane it stands in for.
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
    // The first chat on screen after launch: marked once the frame is out.
    if (speedMarks.awaitingFirstChat) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => speedMarks.firstChat(),
      );
    }
    return widget.child;
  }
}
