import 'dart:async';

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
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/new_harness_attachments.dart';
import '../widgets/new_harness_paste.dart';
import '../state/app_state.dart';
import '../state/harness_attachments.dart';
import '../state/workspace_chrome.dart';
import 'chat_scroll.dart';
import 'leaderboard/reader.dart';
import 'jump_to_latest.dart';
import 'unread_line.dart';
import 'roster.dart';
import 'recording_notice.dart';
import 'identity.dart' show superTabPersonName;
import 'profile_actions.dart';
import 'pull_requests.dart';
import 'composer_newline.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'folder_zip.dart';
import 'model.dart';
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
import 'decisions_view.dart';
import 'route_row.dart';
import 'ship_row.dart';
import 'terminal_row.dart';
import 'thread_panel.dart';
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
    this.isThisComputer,
    this.terminal,
    this.onCloseTerminal,
    this.onOpenGroupTerminals,
    this.terminalsVisible = false,
    this.app,
    this.onNewProject,
    this.onChooseAgentTerminal,
    this.linkSwarms,
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
  final ValueChanged<SuperTabAgent>? onChooseAgentTerminal;

  /// How a message link reaches the account's other Swarms. Without it, and
  /// without an [app], a link into another Swarm is not followed.
  final SwarmLinkSwarms? linkSwarms;

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
  // Each list's dividing row: see [_splitAt].
  final _split = <String, SuperTabMessage>{};
  final _newerRows = UniqueKey();
  // The composer's completions are drawn by builders of their own, so typing
  // and choosing among them never rebuild the transcript.
  final _mentionIndex = ValueNotifier(0);
  late final _tagBackspace = _TagBackspace(
    () => c.mentions(c.selectedId).values,
  );
  final _dismissedMention = ValueNotifier<String?>(null);
  String? _completionPrefix;

  /// The folders whose paths were dropped into each chat's message: what
  /// Attach as zip offers while those paths are still in it.
  final _droppedFolders = <String, List<String>>{};

  /// The chats whose dropped folders are being zipped.
  final _zipping = <String>{};
  final _completionKeys = List.generate(6, (_) => GlobalKey());
  SuperTabController get c => widget.controller;

  /// The open project's week board, read once for the right pane's members
  /// and the left sidebar's Models, so both show one week.
  late SuperTabProjectBoard _board = SuperTabProjectBoard(c);

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

  /// Your own message reads You, in the row and in the quote of it. In your
  /// Buddy chat the PM's private lines read as lines to you, "River (PM) →
  /// you": the PM writes there but cannot read it (Lead, 10-29).
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
        ? '$name (PM) → you'
        : name;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _composer.addListener(_composerMoved);
    c.addListener(_changed);
    c.buddyChatOpener = _openBuddyChat;
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
      _board.dispose();
      _board = SuperTabProjectBoard(c);
      oldWidget.controller.removeListener(_changed);
      if (oldWidget.controller.buddyChatOpener == _openBuddyChat) {
        oldWidget.controller.buddyChatOpener = null;
      }
      c.addListener(_changed);
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
    final mark = c.readMark(id), shown = _shownMessages(id);
    if (_unread.startHistory(
      id,
      shown,
      mark,
      heldBack: c.heldBackTo(id, mark),
    )) {
      _loadBackToMark(id, mark);
    } else if (_unread.waitsForHistory(id)) {
      // The line is placed once the messages reach back to the mark.
    } else if (_unread.decide(id, shown, mark, own: c.isOwn)) {
      _revealUnreadLine(id);
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
  void _revealUnreadLine(String id) {
    final messageId = _unread.lineAt(id);
    if (messageId == null) return;
    _scrollRequest++;
    _jumpingToEnd = false;
    _follow(id, false);
    _target = messageId;
    _revealTarget(
      id,
      0,
      arrived: (row) {
        unawaited(
          Scrollable.ensureVisible(row, alignment: .15).then((_) {
            _checkUnreadLine();
          }),
        );
      },
    );
  }

  /// Shows the jump pill while the reader is scrolled away from the line, and
  /// Jump to latest while the list is away from its newest message.
  void _checkUnreadLine() {
    final scroll = _scroll[c.selectedId];
    var away = false;
    if (_unread.lineAt(c.selectedId) != null &&
        scroll != null &&
        scroll.hasClients) {
      final line = _unread.key.currentContext;
      final top = line == null ? null : _topInList(line);
      away = top == null || top < 0 || top > scroll.position.viewportDimension;
    }
    final id = c.selectedId;
    final awayFromEnd =
        scroll != null &&
        scroll.hasClients &&
        scroll.position.extentAfter >= 40;
    if ((away == _unread.away && awayFromEnd == _awayFromEnd.contains(id)) ||
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
      if (awayFromEnd) {
        _awayFromEnd.add(id);
      } else {
        _awayFromEnd.remove(id);
      }
    });
  }

  /// Esc: everything loaded in the open conversation is read, line and all.
  bool _readAll() {
    final id = c.selectedId, group = c.selected;
    if (group == null || (!c.unread(group) && _unread.lineAt(id) == null)) {
      return false;
    }
    setState(() {
      _unread.clear(id);
      _newAfter.remove(id);
    });
    c.markRead(id);
    return true;
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

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _board.dispose();
    c.removeListener(_changed);
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
        c.saving ||
        c.uploading ||
        c.hasPendingAction ||
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
        final bytes = await zipFolder(folder, limitBytes: files.limitBytes);
        bytes == null
            ? oversized.add(folderName(folder))
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
    final problem = files.addPasted([
      for (final MapEntry(key: folder, value: bytes) in zipped.entries)
        HarnessAttachment('${folderName(folder)}.zip', bytes),
    ], oversized: oversized);
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

  /// The box was edited: keep it as this chat's draft and drop the pick state.
  void _composerEdited(String text) {
    c.setDraft(c.selectedId, text);
    _mentionIndex.value = 0;
    _dismissedMention.value = null;
  }

  /// A line break at the cursor. The field only calls [_composerEdited] for
  /// edits that come from the platform, so this reports its own.
  void _insertNewline() {
    final value = withNewline(_composer.value);
    if (value == null) return;
    _composer.value = value;
    _composerEdited(value.text);
  }

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
    if (match == null || prefix == _dismissedMention.value) return null;
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
    board: _board,
    onAddAgent: widget.onAddAgent,
    onNewProject: widget.onNewProject,
    devicesSelected: _devicesVisible,
    notificationsSelected: _notificationsVisible,
    // On a Mac what needs the person is in the menu bar's Harness menu and on
    // the Dock's badge, so the sidebar keeps no Notifications row.
    onNotifications: superTabNoticesInMenuBar
        ? null
        : () {
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
    onOpenBuddyChat: (projectId) => unawaited(_openBuddyChat(projectId)),
  );

  /// Opens the reader's Buddy chat in [projectId] in front of Notifications,
  /// pull requests and a terminal, opening it on the server when they have
  /// none yet: the sidebar's way in and ⇧⌘K's
  /// ([SuperTabController.buddyChatOpener]).
  Future<bool> _openBuddyChat(String projectId) {
    setState(() {
      _showNotifications = false;
      _showPullRequests = false;
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
      _showPullRequests = false;
    });
    if (request.kind != 'mention') return;
    final mention = SuperTabMentions.of(c).waiting
        .where((m) => m.id == request.id)
        .firstOrNull;
    if (mention != null) unawaited(_openMention(mention));
  }

  bool get _notificationsVisible =>
      _showNotifications && !_devicesVisible && !c.accessRevoked;

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
      _showNotifications = false;
      _showPullRequests = false;
      _back = null;
      _target = shownBy;
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
  Future<void> _openMention(SuperTabMention mention) async {
    final id = mention.conversationId;
    if (c.snapshot?.conversation(id) == null) return;
    final message = await _findMessage(id, mention.messageId);
    if (!mounted) return;
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
      if (c.canWrite &&
          c.selected?.archived == false &&
          message.thread == null) {
        _replies[id] = message;
      }
      _target = message.id;
      // Stop following the end: the tagged message is what to see.
      _scrollRequest++;
      _jumpingToEnd = false;
      _follow(id, false);
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
      scroll.jumpTo(_estimate(scroll.position, index, entries.length));
      _revealTarget(id, attempt + 1, arrived: arrived);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// The messages [id]'s list shows, in order.
  /// A thread reply shows in its thread, and here only when also sent.
  List<SuperTabMessage> _shownMessages(String id) {
    final messages = c.messages(id);
    final answered = answeredPromptAlerts(
      messages,
      (agentId) => c.snapshot?.agent(agentId),
    );
    return messages
        .where((m) => _shown(m) && m.inMainStream && !answered.contains(m.id))
        .toList();
  }

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

  /// Whom a Buddy's proposal speaks for, by name; null for other messages.
  String? _proposalOwner(SuperTabMessage message) =>
      message.proposalOwnerId == null
      ? null
      : buddyPersonName(c, message.proposalOwnerId!);

  /// The reader's own chat with their Buddy.
  bool _isBuddyChat(SuperTabConversation group) =>
      c.buddyChat(group.projectId)?.id == group.id;

  /// The name of the reader's Buddy that [group] is the chat with, or
  /// "your Buddy" while it has none (removed, or starting). Null when [group]
  /// is no Buddy chat of the reader's.
  String? _buddyName(SuperTabConversation? group) {
    if (group == null || !_isBuddyChat(group)) return null;
    final agent = c.buddy(group.projectId);
    return agent == null
        ? 'your Buddy'
        : c.snapshot!.agentName(agent.id, fallback: agent.name);
  }

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
        : _buddyName(group) == null
        ? null
        : c.buddy(group.projectId) == null
        ? 'Your Buddy'
        : '${_buddyName(group)} · Your Buddy';
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
    if (_buddyName(group) case final buddy?) return 'Message $buddy';
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
        ] else if (_isBuddyChat(group)) ...[
          // A Buddy chat is the reader's own: the Buddy itself to remove.
          // Nothing to rename or archive, and no way to a Chat with PM (Ken,
          // 10-28).
          if (editable && c.buddy(group.projectId) != null)
            item(
              'Remove Buddy',
              () => unawaited(confirmRemoveBuddy(context, c, group.projectId)),
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
        tooltip: isProject
            ? 'Project options'
            : _isBuddyChat(group)
            ? 'Buddy options'
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

  Future<void> _react(
    SuperTabMessage message,
    SuperTabReactionEmoji emoji,
  ) async {
    final failure = await c.react(message, emoji);
    if (failure == null || !mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(failure)));
  }

  /// [sent], drawn as the reader's own message will be once the transcript
  /// holds it, with where it stands under it.
  Widget _outgoingRow(
    SuperTabOutgoing sent,
    List<SuperTabMessage> messages,
    Map<String, SuperTabMessage> byId,
  ) {
    final id = sent.conversationId;
    final person = c.snapshot?.people
        .where((p) => p.id == c.accountId)
        .firstOrNull;
    final message = SuperTabMessage.fromJson({
      'id': 'outgoing',
      'conversationId': id,
      'text': sent.text,
      'replyTo': sent.replyTo,
      'sequence': 0,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
      'author': {
        'kind': 'person',
        'id': c.accountId,
        'name': person?.email ?? '',
      },
    });
    final reply = byId[sent.replyTo];
    return KeyedSubtree(
      key: const ValueKey('super-outgoing'),
      child: SuperTabMessageRow(
        message: message,
        author: _shownAuthor(c, message),
        proposalOwner: _proposalOwner(message),
        person: person,
        grouped: SuperTabMessageRow.groupsWith(message, messages.lastOrNull),
        reply: reply,
        replyAuthor: reply == null ? null : _shownAuthor(c, reply),
        onReturnToComposer: _focus.requestFocus,
        readerId: c.accountId,
        receipts: [
          SuperTabOutgoingReceipt(
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
        ],
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

  Widget _message(
    SuperTabMessage message,
    bool grouped,
    Map<String, SuperTabMessage> byId, {
    bool showReceipt = false,
    bool inThread = false,
  }) {
    _index();
    if (message.terminalEvent || message.source['kind'] == 'overlap') {
      return SuperTabTerminalRow(
        key: ValueKey(
          '${inThread ? 'super-thread-message' : 'super-message'}-${message.id}',
        ),
        message: message,
      );
    }
    if (SuperTabShipRow.shows(message)) {
      return SuperTabShipRow(
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
      author: _shownAuthor(c, message),
      proposalOwner: _proposalOwner(message),
      // A person is named by their address's first part, as people say it.
      mentions: [
        for (final id in message.mentions)
          if (_people[id] case final person?) person.email.split('@').first,
      ],
      references: _references,
      onOpenGroup: (id) {
        setState(() => _showPullRequests = false);
        c.select(id);
        c.selectTerminal(id, null);
      },
      agent: agent,
      person: message.fromAgent ? null : _people[message.authorId],
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
      reactorName: (kind, id) => kind == 'agent'
          ? c.snapshot?.agentName(id) ?? 'Agent'
          : switch (_people[id]) {
              final person? => superTabPersonName(person.email),
              null => 'Someone',
            },
      onReact: c.canWrite && c.selected?.archived == false
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
    return SuperTabThreadPanel(
      controller: c,
      root: open.root,
      row: (message, grouped) =>
          _message(message, grouped, byId, inThread: true),
      outgoing: (sent) => _outgoingRow(sent, rows, byId),
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
    final messages = _shownMessages(id);
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

  /// The rows that join the one above them, without their name: runs of
  /// one author's short updates, three to a group. Groups are counted from
  /// the list's dividing row both ways, so a page read in above regroups
  /// none of the rows already shown.
  static Set<String> _joined(
    List<SuperTabMessage> messages,
    SuperTabMessage? split,
  ) {
    final at = split == null
        ? -1
        : messages.indexWhere((m) => superTabMessageOrder(m, split) >= 0);
    if (at <= 0) return SuperTabMessageRow.consecutiveUpdates(messages);
    final joined = SuperTabMessageRow.consecutiveUpdates(messages.sublist(at));
    // Above it, upward: each group, newest first, keeps the name on its
    // oldest row.
    var group = [at - 1];
    for (var i = at - 2; i >= -1; i--) {
      final newest = group.first;
      if (i >= 0 &&
          newest - i < 3 &&
          SuperTabMessageRow.groupsWith(messages[i + 1], messages[i]) &&
          SuperTabMessageRow.groupsWith(messages[newest], messages[i])) {
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
        .where(c.isOwn)
        .firstOrNull;
    final messages = _shownMessages(c.selectedId);
    final entries = superTabTranscriptEntries(messages);
    final byId = {for (final message in messages) message.id: message};
    final rowIndex = {
      for (final (index, entry) in entries.indexed)
        _rowKey(entry.message.id): index,
    };
    // A row stays the same row as pages arrive above it, state and all.
    int? rowOf(Key key) => key is ValueKey<String> ? rowIndex[key.value] : null;
    final split = _splitAt(c.selectedId, entries);
    final grouped = _joined(messages, _split[c.selectedId]);
    Widget row(int index) {
      final entry = entries[index];
      final message = entry.message;
      final agent = message.fromAgent
          ? c.snapshot?.agent(message.authorId)
          : null;
      final previous = index > 0 ? entries[index - 1].message : null;
      final time = message.createdAt;
      return Column(
        key: ValueKey(_rowKey(message.id)),
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
                child: entry.interruptions > 0
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
                        grouped.contains(message.id),
                        byId,
                        showReceipt: message.id == latestOwn?.id,
                      ),
              ),
            ),
          ),
        ],
      );
    }

    final newAfter = _newAfter[c.selectedId];
    final newCount = newAfter == null
        ? 0
        : messages.where((message) => message.sequence > newAfter).length;
    // More came than were read: the count is a floor.
    final moreNew = c.hasNewer(c.selectedId);
    // Scrolled away from the newest message, or newer pages wait unread.
    final awayFromEnd = _awayFromEnd.contains(c.selectedId) || moreNew;
    final reply = _replies[c.selectedId];
    final outgoing = c
        .outgoing(c.selectedId)
        .where((sent) => sent.inMainStream)
        .toList();
    // A failed message says so in its own row, with what can be done.
    final errorInRow = outgoing.any(
      (sent) => switch (sent.state) {
        SuperTabOutgoingState.sending => false,
        SuperTabOutgoingState.unconfirmed => c.hasPendingAction,
        SuperTabOutgoingState.refused => sent.error == c.operationError,
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
        if (group != null && _isBuddyChat(group))
          SuperTabBuddyBar(controller: c, chat: group, app: widget.app),
        // The reader's own Buddy chat shows what the PM asked them.
        if (group != null && _isBuddyChat(group))
          SuperTabDecisionsPanel(
            decisions: SuperTabDecisions.of(c),
            projectId: group.projectId,
          ),
        Expanded(
          child: c.loading
              ? const Center(child: CircularProgressIndicator())
              : unread && c.error != null
              ? _firstReadFailed(c.error!)
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
                          ? 'Discuss the plan with your product manager.'
                          : _buddyName(group) != null
                          ? "Only you and ${_buddyName(group)} read this chat. Say what you want to build; say 'send to the PM' when it's ready."
                          : 'Start the conversation.',
                      textAlign: TextAlign.center,
                      style: DesktopChrome.text(color: DesktopChrome.muted),
                    ),
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
                        _follow(id, atEnd);
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
                                            constraints.remainingCacheExtent >
                                            0,
                                      ),
                                    ),
                                  ),
                            ),
                            SliverList(
                              delegate: SliverChildBuilderDelegate(
                                (context, index) => row(split - 1 - index),
                                childCount: split,
                                findChildIndexCallback: (key) =>
                                    switch (rowOf(key)) {
                                      final i? when i < split => split - 1 - i,
                                      _ => null,
                                    },
                              ),
                            ),
                            SliverPadding(
                              key: _newerRows,
                              padding: EdgeInsets.only(
                                bottom: grid.AppDesktop.controlGap,
                              ),
                              sliver: SliverList(
                                delegate: SliverChildBuilderDelegate(
                                  // Messages on their way end the list.
                                  (context, index) =>
                                      index < entries.length - split
                                      ? row(split + index)
                                      : _outgoingRow(
                                          outgoing[index -
                                              (entries.length - split)],
                                          messages,
                                          byId,
                                        ),
                                  childCount:
                                      entries.length - split + outgoing.length,
                                  findChildIndexCallback: (key) =>
                                      switch (rowOf(key)) {
                                        final i? when i >= split => i - split,
                                        _ => null,
                                      },
                                ),
                              ),
                            ),
                          ],
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
                    if (_unread.away && _unread.lineAt(c.selectedId) != null)
                      Positioned(
                        top: grid.AppDesktop.controlGap,
                        left: grid.AppDesktop.panelPadding,
                        right: grid.AppDesktop.panelPadding,
                        child: Center(
                          child: SuperTabJumpToUnread(
                            onPressed: () => _revealUnreadLine(c.selectedId),
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
        if (c.composerError(c.selectedId) != null && !errorInRow)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    c.composerError(c.selectedId)!,
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
        ListenableBuilder(
          listenable: completing,
          builder: (context, _) {
            final choices = _completionChoices;
            if (choices.isEmpty) return const SizedBox.shrink();
            return Padding(
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
                              i ==
                              _mentionIndex.value.clamp(0, choices.length - 1),
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
            );
          },
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
          ListenableBuilder(
            // Keyed: the lines that come and go above it (a reply, mention
            // choices, an error) would otherwise take over this element and
            // remount the field. A remounted field keeps focus but loses its
            // text input connection, so typing, Backspace included, would go
            // nowhere.
            key: const ValueKey('super-message-composer-row'),
            listenable: _composer,
            builder: (context, field) => Padding(
              padding: EdgeInsets.fromLTRB(
                24,
                12,
                24,
                pastedFolders().isEmpty ? 16 : 6,
              ),
              child: field,
            ),
            child: Focus(
              onKeyEvent: (node, event) {
                final keys = HardwareKeyboard.instance;
                final composing = _composer.value.composing;
                final choices =
                    _focus.hasFocus &&
                        event is KeyDownEvent &&
                        !keys.isControlPressed &&
                        !keys.isMetaPressed &&
                        !keys.isAltPressed &&
                        !keys.isShiftPressed &&
                        !(composing.isValid && !composing.isCollapsed)
                    ? _completionChoices
                    : const <_ComposerChoice>[];
                if (choices.isNotEmpty) {
                  final key = event.logicalKey;
                  if (key == LogicalKeyboardKey.arrowDown ||
                      key == LogicalKeyboardKey.arrowUp) {
                    _moveCompletion(
                      (_mentionIndex.value +
                              (key == LogicalKeyboardKey.arrowDown ? 1 : -1)) %
                          choices.length,
                    );
                    return KeyEventResult.handled;
                  }
                  if (key == LogicalKeyboardKey.tab ||
                      key == LogicalKeyboardKey.enter) {
                    choices[_mentionIndex.value.clamp(0, choices.length - 1)]
                        .choose();
                    return KeyEventResult.handled;
                  }
                  if (key == LogicalKeyboardKey.escape) {
                    _dismissedMention.value = _composer.text.substring(
                      0,
                      _composer.selection.baseOffset,
                    );
                    return KeyEventResult.handled;
                  }
                }
                if (event is KeyDownEvent &&
                    event.logicalKey == LogicalKeyboardKey.escape &&
                    _readAll()) {
                  return KeyEventResult.handled;
                }
                final enterDown =
                    _focus.hasFocus &&
                    event is KeyDownEvent &&
                    event.logicalKey == LogicalKeyboardKey.enter &&
                    !(composing.isValid && !composing.isCollapsed);
                if (!enterDown) return KeyEventResult.ignored;
                if (keys.isControlPressed || keys.isMetaPressed) {
                  return KeyEventResult.ignored;
                }
                // Shift+Enter and Alt+Enter write the line themselves: the platform
                // gives Option+Return none, and a handled key never reaches it.
                if (keys.isShiftPressed || keys.isAltPressed) {
                  _insertNewline();
                  return KeyEventResult.handled;
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
                                      maxLength: kComposerMaxLength,
                                      inputFormatters: [_tagBackspace],
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
                                      onChanged: _composerEdited,
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

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      grid.AppTheme.watch(context);
      final terminal = widget.terminal;
      final narrow =
          constraints.maxWidth < MediaQuery.textScalerOf(context).scale(720);
      final showRoster =
          constraints.maxWidth >= MediaQuery.textScalerOf(context).scale(1080);
      final thread = _threadPanel();
      final threadDrawer = thread != null && !showRoster;
      final chatCovered =
          (narrow && _sidebarOpen) ||
          (!showRoster && _rosterOpen) ||
          threadDrawer;
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
              // An open thread takes the roster's side, as in Slack.
              right: !showRoster ? null : thread ?? roster,
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
          if (threadDrawer)
            Positioned.fill(
              child: BlockSemantics(
                child: GestureDetector(
                  onTap: c.closeThread,
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
                          ),
                          child: thread,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (!showRoster && _rosterOpen && !threadDrawer)
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

/// Backspace right after a tag takes the whole tag, as in Slack: deleting the
/// character before the caret, where one of [tags] ends, removes that tag.
/// The draft then no longer holds it, so its agent is no longer addressed.
class _TagBackspace extends TextInputFormatter {
  _TagBackspace(this.tags);

  final Iterable<String> Function() tags;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final caret = oldValue.selection;
    if (!caret.isValid ||
        !caret.isCollapsed ||
        caret.baseOffset == 0 ||
        (newValue.composing.isValid && !newValue.composing.isCollapsed)) {
      return newValue;
    }
    final end = caret.baseOffset;
    if (newValue.selection != TextSelection.collapsed(offset: end - 1) ||
        newValue.text != oldValue.text.replaceRange(end - 1, end, '')) {
      return newValue;
    }
    final before = oldValue.text.substring(0, end);
    final after = oldValue.text.substring(end);
    if (after.isNotEmpty && !after.startsWith(RegExp(r'[\s.,!?;:]'))) {
      return newValue;
    }
    for (final tag in tags()) {
      final start = end - tag.length;
      if (!before.endsWith(tag) ||
          (start > 0 && !before[start - 1].contains(RegExp(r'\s')))) {
        continue;
      }
      return TextEditingValue(
        text: oldValue.text.replaceRange(start, end, ''),
        selection: TextSelection.collapsed(offset: start),
      );
    }
    return newValue;
  }
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
