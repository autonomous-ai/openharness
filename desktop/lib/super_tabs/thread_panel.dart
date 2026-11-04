import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../state/harness_attachments.dart';
import '../widgets/desktop_chrome.dart';
import 'buddy_sessions.dart';
import 'composer_tags.dart';
import 'composer_toggle.dart';
import 'day_pill.dart';
import 'reply_box.dart';
import 'controller.dart';
import 'message_row.dart' show SuperTabMessageHighlight, SuperTabMessageRow;
import 'jump_to_latest.dart';
import 'model.dart';
import 'thread_scroll.dart';
import '../widgets/laid_out_list.dart';
import 'swarm_type.dart';
import 'voice_recorder.dart';

/// One thread beside the chat (Dee, 2026-10-29): its root, a "N replies"
/// divider, the replies, and a composer whose reply goes to the root.
class SuperTabThreadPanel extends StatefulWidget {
  const SuperTabThreadPanel({
    super.key,
    required this.controller,
    required this.root,
    required this.row,
    required this.outgoing,
    this.sessionActivity,
    this.machineName,
    this.onScroll,
    this.voiceRecorder,
  });

  final SuperTabController controller;
  final String root;

  /// Draws one of the thread's messages as the chat draws it.
  final Widget Function(SuperTabMessage message, bool grouped) row;

  /// Draws a reply on its way.
  final Widget Function(SuperTabOutgoing sent) outgoing;

  /// What a thread's own Buddy session is doing, as this computer reads it;
  /// without it, what the Swarm alone says.
  final SuperTabSessionActivity? sessionActivity;

  /// A machine's name, said beside an agent `@` offers.
  final String Function(String machineId)? machineName;

  /// Given the thread's list while the panel lives (null once it is gone),
  /// so a device scrolling this Swarm scrolls the thread, not the chat.
  final ValueChanged<ScrollController?>? onScroll;

  /// What the reply box's mic records with; without it, no mic shows.
  final SuperTabVoiceRecorder? voiceRecorder;

  @override
  State<SuperTabThreadPanel> createState() => _SuperTabThreadPanelState();
}

class _SuperTabThreadPanelState extends State<SuperTabThreadPanel> {
  late final _composer = TextEditingController(
    text: c.threadDraft(widget.root),
  );
  final _focus = FocusNode();
  // Opens at the newest reply and follows it until the reader scrolls up.
  final _scroll = SuperTabThreadScroll();
  bool _alsoSend = false;
  // The reply starts this thread's own Buddy session (reader's Buddy chat).
  bool _newSession = false;
  // Whether the list is scrolled away from its newest reply, the replies
  // there were when the thread opened or was last read to its end (set once
  // the thread's replies are known), and the latest replies and rows (replies
  // and those on their way): what came since is the control's count.
  bool _away = false, _atEnd = false, _baselined = false;
  int _repliesAtEnd = 0, _replies = 0;
  // The newest row (reply or one on its way), as built and as last measured:
  // earlier replies arriving above do not change it.
  String? _newest, _newestMeasured;
  // `@` in the reply box, as in the chat's (composer_tags.dart): the choice
  // selected, and the text before the caret where the list was dismissed.
  final _tagIndex = ValueNotifier(0);
  final _tagDismissed = ValueNotifier<String?>(null);
  final _tagRows = List.generate(superTabCompletionLimit, (_) => GlobalKey());
  late final _tagBackspace = SuperTabTagBackspace(
    () => c.threadMentions(_conversationId, widget.root).values,
  );

  SuperTabController get c => widget.controller;

  // The day pill's jump (Huy 11-04): the row it lands on, and the one lit.
  final _targetKey = GlobalKey();
  String? _target, _lit;
  Timer? _litTimer;
  int _jumps = 0;

  /// [row] with its message's time, for the day pill over the list. Keyed
  /// by the message, so the list keeps each row's place as replies arrive.
  Widget _dated(SuperTabMessage message, Widget row) => SuperTabDayMark(
    key: ValueKey('super-thread-day-${message.id}'),
    time: message.createdAt,
    child: KeyedSubtree(
      key: message.id == _target ? _targetKey : null,
      child: SuperTabMessageHighlight(on: message.id == _lit, child: row),
    ),
  );

  /// The day pill's choice, as in the chat: the first of the root and its
  /// replies on or after [from], lit; the root for the very beginning (null),
  /// the newest reply for a time after everything said. Earlier replies are
  /// read until one from before [from] is held, at most 50 pages.
  Future<void> _jumpToTime(DateTime? from) async {
    final jump = ++_jumps;
    bool before(SuperTabMessage m) =>
        from == null || (m.createdAt?.isBefore(from) ?? false);
    List<SuperTabMessage> held() => c.threadMessages(widget.root);
    void say(String text) =>
        ScaffoldMessenger.maybeOf(context)
            ?.showSnackBar(SnackBar(content: Text(text)));
    // They read on from the row they land on, not the newest.
    _scroll.holdPlace();
    // The root is always held, at the top: the very beginning reads nothing.
    for (var page = 0; from != null; page++) {
      final reached = held().any((m) => m.id != widget.root && before(m));
      if (reached || !c.hasEarlierReplies(widget.root)) break;
      if (page == 50) {
        say('That day is too far back to open.');
        return;
      }
      // A read that fails keeps its error and its place: nothing came.
      final loaded = held().length;
      await c.loadThread(earlier: true);
      if (!mounted || jump != _jumps) return;
      if (held().length == loaded) {
        say('Couldn’t load earlier replies.');
        return;
      }
    }
    final messages = held();
    final target = from == null
        ? messages.firstOrNull
        : messages.where((m) => !before(m)).firstOrNull ?? messages.lastOrNull;
    if (target == null) return;
    _litTimer?.cancel();
    setState(() => _target = _lit = target.id);
    _litTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _lit = null);
    });
    _reveal(jump, messages.indexOf(target) / messages.length, 0);
  }

  /// The list is lazy: jump near the target's place ([at], its share of the
  /// thread) until its row is built, then bring it into view.
  void _reveal(int jump, double at, int attempt) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || jump != _jumps || !_scroll.hasClients) return;
      if (_targetKey.currentContext case final row?) {
        unawaited(Scrollable.ensureVisible(row, alignment: .3));
        return;
      }
      if (attempt > 20) return;
      final position = _scroll.position;
      _scroll.jumpTo(
        position.minScrollExtent +
            at * (position.maxScrollExtent - position.minScrollExtent),
      );
      _reveal(jump, at, attempt + 1);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// The conversation this thread is in.
  String get _conversationId => c.openedThread?.conversationId ?? c.selectedId;

  @override
  void initState() {
    super.initState();
    _focus.requestFocus();
    _scroll.addListener(_measureAfterFrame);
    widget.onScroll?.call(_scroll);
  }

  @override
  void didUpdateWidget(SuperTabThreadPanel old) {
    super.didUpdateWidget(old);
    if (old.root != widget.root) {
      // Another thread opens at its newest reply, with nothing counted.
      _away = false;
      _atEnd = false;
      _baselined = false;
      _repliesAtEnd = 0;
      _newestMeasured = null;
      _scroll.followEnd();
      // Each thread keeps its own draft.
      _composer.text = c.threadDraft(widget.root);
      _alsoSend = false;
      _newSession = false;
      _tagIndex.value = 0;
      _tagDismissed.value = null;
    }
  }

  @override
  void dispose() {
    _litTimer?.cancel();
    widget.onScroll?.call(null);
    _scroll.dispose();
    _composer.dispose();
    _focus.dispose();
    _tagIndex.dispose();
    _tagDismissed.dispose();
    super.dispose();
  }

  void _measureAfterFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
  }

  /// A thread read to its end stays there as replies arrive; one read back
  /// shows Jump to latest, with the count of replies that came meanwhile.
  void _measure() {
    if (!mounted || !_scroll.hasClients) return;
    final position = _scroll.position;
    // Near the end (not quite at it, where the scroll follows by itself), a
    // new row still brings the reader down to it.
    if (_newest != _newestMeasured && _atEnd && position.extentAfter >= 40) {
      _scroll.followEnd();
    }
    _newestMeasured = _newest;
    final away = position.extentAfter >= 40;
    final atEnd = !away;
    // What the thread held when it opened is not new; nor is what the reader
    // has read to its end.
    final repliesAtEnd = atEnd ? _replies : _repliesAtEnd;
    if (away == _away && atEnd == _atEnd && repliesAtEnd == _repliesAtEnd) {
      return;
    }
    setState(() {
      _away = away;
      _atEnd = atEnd;
      _repliesAtEnd = repliesAtEnd;
    });
  }

  /// Scrolls to the newest reply and follows it again; the scroll settles on
  /// the real end as the rows there are laid out.
  void _jumpToLatest() {
    _scroll.followEnd();
    _measureAfterFrame();
  }

  /// Where "Also send" also puts the reply, always in full (Scholes, 11-03:
  /// "Also to chat" did not say where): the project chat as its sidebar row
  /// names it, else the main chat. "Send", as the phone and Slack say it
  /// (Huy and Scholes, 11-04).
  String get _alsoSendLabel {
    final group = c.selected, snapshot = c.snapshot;
    String? channel;
    if (group != null && snapshot != null && snapshot.isProjectLead(group.id)) {
      channel = snapshot.projectFor(group.id)?.name;
    }
    return channel == null
        ? 'Also send to the main chat'
        : 'Also send to #$channel';
  }

  String get _alsoSendHint => '$_alsoSendLabel as well as this thread';

  // An older Buddy chat is kept to read: no thread reply there either (security review 1 of #2437).
  bool get _writable =>
      c.canWrite &&
      c.selected?.archived == false &&
      !c.hasPendingAction &&
      !c.isEarlierBuddyChat(c.selected);

  /// The thread's last session ended: a reply here must start a new one.
  bool get _sessionLocked =>
      c.offersThreadSessions(widget.root) &&
      c.threadSessionEnded(widget.root) != null;

  /// Whether the composer offers New session: the reader's own Buddy chat,
  /// with their Buddy running, in a thread no session answers now.
  bool get _offersSession =>
      c.offersThreadSessions(widget.root) &&
      c.threadSession(widget.root) == null;

  /// Whether this reply starts a session.
  bool get _startsSession =>
      _offersSession &&
      (_sessionLocked || (_newSession && c.threadSessionBlocked == null));

  /// A session's thread stays in the thread: Also send is not offered there,
  /// nor for a reply that starts one.
  bool get _offersAlsoSend => !_startsSession && _alsoSendPossible;

  /// Whether this thread offers Also send whenever New session is off: its
  /// place is laid out for it, so turning New session on never moves the box.
  bool get _alsoSendPossible => c.threadSession(widget.root) == null;

  /// The files waiting to go with this thread's next reply.
  HarnessAttachments get _files =>
      c.threadAttachments(c.selectedId, widget.root);

  /// Whether files are going up or a message is on its way, when the box takes
  /// no more.
  bool get _busy => c.uploading || c.saving;

  /// The box was edited: keep it as this thread's draft.
  void _edited(String text) {
    c.setThreadDraft(widget.root, text);
    _tagIndex.value = 0;
    _tagDismissed.value = null;
    setState(() {});
  }

  /// The `@` tag typed at the caret.
  ({int start, int end, String query})? get _tagAt => superTabTagAtCaret(
    _composer.value,
    dismissed: _tagDismissed.value,
    tags: c.threadMentions(_conversationId, widget.root).values,
  );

  /// Who `@` offers in this reply: whom the chat's box offers, except agents
  /// where the thread's own Buddy session alone hears the reply.
  List<SuperTabComposerChoice> get _tagChoices {
    final group = c.selected;
    if (!_writable || group == null) return const [];
    final at = _tagAt;
    if (at == null) return const [];
    return superTabTagChoices(
      c,
      group,
      at.query,
      machineName: widget.machineName ?? (_) => '',
      choose: _chooseTag,
      agents: !_startsSession && c.threadSession(widget.root) == null,
    );
  }

  void _chooseTag(String id, String name) {
    final at = _tagAt;
    if (at == null) return;
    final token = '@$name';
    final value = superTabInsertTag(_composer.value, at, token);
    c.setThreadDraft(widget.root, value.text);
    c.threadMention(id, token);
    _composer.value = value;
    _tagIndex.value = 0;
    _focus.requestFocus();
    setState(() {});
  }

  /// @ Tag: `@` at the caret, reported as an edit so the tag list opens.
  void _promptTag() {
    _composer.value = superTabTagPrompt(_composer.value);
    _edited(_composer.text);
    _focus.requestFocus();
  }

  void _moveTag(int index) {
    _tagIndex.value = index;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final row = _tagRows[index].currentContext;
      if (mounted && row != null) Scrollable.ensureVisible(row, alignment: .5);
    });
  }

  Future<void> _send() async {
    if (!_writable ||
        _busy ||
        (_composer.text.trim().isEmpty && _files.isEmpty)) {
      return;
    }
    final root = widget.root;
    c.setThreadDraft(root, _composer.text);
    await c.sendThreadReply(
      alsoSend: _offersAlsoSend && _alsoSend,
      newSession: _startsSession,
      // The reply is on its way (its files have gone up): the box is free for
      // the next one, unless another thread is shown by now.
      onSending: () {
        if (!mounted || widget.root != root) return;
        if (c.threadDraft(root).isEmpty) {
          _composer.clear();
          setState(() {
            _alsoSend = false;
            _newSession = false;
          });
        }
      },
    );
    // Refused for New session, the reply's text is back as this thread's
    // draft: it shows in the box, ready to send without it, unless another
    // thread is shown or something was typed meanwhile.
    if (!mounted || widget.root != root || _composer.text.isNotEmpty) return;
    final restored = c.threadDraft(root);
    if (restored.isEmpty) return;
    _composer.value = TextEditingValue(
      text: restored,
      selection: TextSelection.collapsed(offset: restored.length),
    );
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final messages = c.threadMessages(widget.root);
    final root = messages.where((m) => m.id == widget.root).firstOrNull;
    final replies = messages.where((m) => m.id != widget.root).toList();
    final pending = c
        .outgoing(c.selectedId)
        .where((sent) => sent.thread == widget.root)
        .toList();
    final count =
        c.thread(c.selectedId, widget.root)?.replies ?? replies.length;
    _replies = count > replies.length ? count : replies.length;
    _newest = '${replies.lastOrNull?.id}/${pending.length}';
    if (!_baselined &&
        (c.thread(c.selectedId, widget.root) != null || replies.isNotEmpty)) {
      _baselined = true;
      _repliesAtEnd = _replies;
    }
    _measureAfterFrame();
    return Material(
      key: const ValueKey('super-thread-panel'),
      color: DesktopChrome.surface,
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.escape): c.closeThread,
        },
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              // As high as the chat's header, so their rules meet.
              constraints: const BoxConstraints(minHeight: 51),
              alignment: Alignment.center,
              padding: const EdgeInsets.fromLTRB(
                SuperTabMessageRow.horizontalInset,
                0,
                grid.AppDesktop.controlGap,
                0,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text('Thread', style: SwarmType.name(context)),
                    ),
                  ),
                  AppIconButton(
                    key: const ValueKey('super-thread-close'),
                    icon: AppIcons.close,
                    tooltip: 'Close thread',
                    onPressed: c.closeThread,
                  ),
                ],
              ),
            ),
            Divider(height: 1, thickness: 1, color: DesktopChrome.rim),
            SuperTabThreadSessionLine(
              key: ValueKey('super-thread-session-${widget.root}'),
              controller: c,
              root: widget.root,
              activityOf:
                  widget.sessionActivity ??
                  (session) => superTabSessionActivity(c, null, session),
            ),
            Expanded(
              child: Stack(
                children: [
                  SuperTabStickyDay(
                    pillKey: const ValueKey('super-thread-day-pill'),
                    onJump: (from) => unawaited(_jumpToTime(from)),
                    // As in the chat, a message's text can be selected and
                    // copied.
                    child: SelectionArea(
                      child: LaidOutListView(
                        controller: _scroll,
                        padding: const EdgeInsets.symmetric(
                          vertical: grid.AppDesktop.controlGap,
                        ),
                        children: [
                          if (root != null)
                            _dated(root, widget.row(root, false)),
                          if (count > 0)
                            Padding(
                              key: const ValueKey('super-thread-divider'),
                              padding: const EdgeInsets.symmetric(
                                horizontal: grid.AppDesktop.groupGap,
                                vertical: grid.AppDesktop.controlGap,
                              ),
                              child: Row(
                                children: [
                                  Text(
                                    count == 1 ? '1 reply' : '$count replies',
                                    style: DesktopChrome.metadata(),
                                  ),
                                  const SizedBox(
                                    width: grid.AppDesktop.controlGap,
                                  ),
                                  Expanded(
                                    child: Divider(
                                      height: 1,
                                      thickness: 1,
                                      color: DesktopChrome.rim,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          if (c.hasEarlierReplies(widget.root))
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: grid.AppDesktop.controlGap,
                                ),
                                child: TextButton(
                                  key: const ValueKey('super-thread-earlier'),
                                  onPressed: c.readingEarlierReplies
                                      ? null
                                      : () {
                                          // They read on from where they are.
                                          _scroll.holdPlace();
                                          unawaited(
                                            c.loadThread(earlier: true),
                                          );
                                        },
                                  child: Text(
                                    c.readingEarlierReplies
                                        ? 'Loading earlier replies…'
                                        : 'Show earlier replies',
                                  ),
                                ),
                              ),
                            ),
                          for (final (index, reply) in replies.indexed)
                            _dated(
                              reply,
                              widget.row(
                                reply,
                                index > 0 &&
                                    SuperTabMessageRow.groupsWith(
                                      reply,
                                      replies[index - 1],
                                      inThread: true,
                                    ),
                              ),
                            ),
                          for (final sent in pending) widget.outgoing(sent),
                        ],
                      ),
                    ),
                  ),
                  if (_away)
                    Positioned(
                      bottom: grid.AppDesktop.controlGap,
                      left: grid.AppDesktop.controlGap,
                      right: grid.AppDesktop.controlGap,
                      child: Center(
                        child: SuperTabJumpToLatest(
                          onPressed: _jumpToLatest,
                          count: _replies - _repliesAtEnd,
                          noun: 'reply',
                          plural: 'replies',
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                0,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
              ),
              child: // The Tab order holds wherever Also send sits (reply_box.dart
                  // fieldOrder).
                  FocusTraversalGroup(
                    policy: OrderedTraversalPolicy(),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        ListenableBuilder(
                          listenable: Listenable.merge([
                            _composer,
                            _tagIndex,
                            _tagDismissed,
                          ]),
                          builder: (context, _) {
                            final choices = _tagChoices;
                            if (choices.isEmpty) return const SizedBox.shrink();
                            return Padding(
                              padding: const EdgeInsets.only(
                                bottom: grid.AppDesktop.controlGap,
                              ),
                              child: SuperTabCompletionList(
                                listKey: const ValueKey(
                                  'super-thread-completions',
                                ),
                                choices: choices,
                                index: _tagIndex.value,
                                rowKeys: _tagRows,
                              ),
                            );
                          },
                        ),
                        FocusTraversalOrder(
                          order: SuperTabReplyBox.fieldOrder,
                          child: _composerBox(),
                        ),
                        ?_underBox(),
                      ],
                    ),
                  ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _composerBox() => SuperTabReplyBox(
    controller: c,
    text: _composer,
    focus: _focus,
    files: _files,
    enabled:
        c.canWrite &&
        c.selected?.archived == false &&
        !c.isEarlierBuddyChat(c.selected),
    writable: _writable,
    busy: _busy,
    error: c.threadComposerError(c.selectedId, widget.root),
    hint: c.isEarlierBuddyChat(c.selected)
        ? 'This is an earlier chat, kept to read.'
        : 'Reply',
    onEdited: _edited,
    onSend: () => unawaited(_send()),
    options: _choices(_writable),
    onTag: _promptTag,
    onMic: switch (widget.voiceRecorder) {
      final recorder? => () => unawaited(
        recorder.start(conversationId: _conversationId, root: widget.root),
      ),
      null => null,
    },
    // `@` in the reply: the open completion list takes its keys first.
    onKey: (event) {
      final composing = _composer.value.composing;
      return _focus.hasFocus && !(composing.isValid && !composing.isCollapsed)
          ? superTabCompletionKey(
              event,
              choices: () => _tagChoices,
              index: _tagIndex.value,
              move: _moveTag,
              dismiss: () => _tagDismissed.value = _composer.text.substring(
                0,
                _composer.selection.baseOffset,
              ),
            )
          : null;
    },
    inputFormatters: [_tagBackspace],
  );

  /// What sits under the box: Also send, a small checkbox on its own line as
  /// in Slack (Huy and Scholes, 11-04), and the muted note while the reply
  /// starts a session. They never show together, so they share one place;
  /// each keeps its place while hidden, so the box never moves as New session
  /// is toggled.
  Widget? _underBox() {
    final note = _offersSession
        ? Padding(
            padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
            child: Visibility(
              visible: _startsSession,
              maintainSize: true,
              maintainAnimation: true,
              maintainState: true,
              child: Text(
                'Your reply starts a new Buddy session',
                key: const ValueKey('super-thread-session-note'),
                style: DesktopChrome.metadata(color: DesktopChrome.muted),
              ),
            ),
          )
        : null;
    if (!_alsoSendPossible) return note;
    // Its square under the row's first button: the box's inset.
    final line = Visibility(
      visible: _offersAlsoSend,
      maintainSize: true,
      maintainAnimation: true,
      maintainState: true,
      child: Padding(
        key: const ValueKey('super-thread-also-line'),
        padding: const EdgeInsets.only(
          top: grid.AppDesktop.controlGap,
          left: grid.AppDesktop.groupGap,
        ),
        child: Align(
          alignment: Alignment.centerLeft,
          child: _alsoSendChoice(_writable),
        ),
      ),
    );
    return note == null ? line : Stack(children: [line, note]);
  }

  /// The row's options, between @ Tag and the mic: New session, ending in "…"
  /// in a pane narrower than the app allows.
  Widget? _choices(bool writable) => _offersSession
      ? Align(
          alignment: Alignment.centerLeft,
          child: FocusTraversalOrder(
            order: const NumericFocusOrder(SuperTabReplyBox.optionsOrder),
            child: _sessionChoice(writable),
          ),
        )
      : null;

  /// Also send, on its own line under the box: after send in the Tab order.
  Widget _alsoSendChoice(bool writable) => FocusTraversalOrder(
    order: SuperTabReplyBox.underOrder,
    child: SuperTabComposerToggle(
      key: const ValueKey('super-thread-also-send'),
      on: _alsoSend,
      label: _alsoSendLabel,
      hint: _alsoSendHint,
      onChanged: writable ? (on) => setState(() => _alsoSend = on) : null,
    ),
  );

  static const _sessionLabel = 'New session';

  /// New session, left of Also send: on and locked once the thread's session
  /// ended; greyed while it can't start, its hover saying why.
  Widget _sessionChoice(bool writable) {
    final locked = _sessionLocked;
    // What the server would refuse is said before sending: paused, no Buddy,
    // an older host.
    final blocked = c.threadSessionBlocked;
    return SuperTabComposerToggle(
      key: const ValueKey('super-thread-new-session'),
      on: locked || (_newSession && blocked == null),
      label: _sessionLabel,
      hint:
          blocked ??
          (locked
              ? 'This thread\'s session ended. Your reply starts a new one.'
              : 'Starts a separate Buddy session for this thread'),
      onChanged: writable && !locked && blocked == null
          ? (on) => setState(() => _newSession = on)
          : null,
    );
  }
}
