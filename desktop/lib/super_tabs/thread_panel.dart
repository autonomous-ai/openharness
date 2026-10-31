import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../state/harness_attachments.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/new_harness_attachments.dart';
import '../widgets/new_harness_paste.dart';
import 'buddy_sessions.dart';
import 'composer_files.dart';
import 'composer_newline.dart';
import 'composer_toggle.dart';
import 'controller.dart';
import 'jump_to_latest.dart';
import 'model.dart';

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

  @override
  State<SuperTabThreadPanel> createState() => _SuperTabThreadPanelState();
}

class _SuperTabThreadPanelState extends State<SuperTabThreadPanel> {
  late final _composer = TextEditingController(
    text: c.threadDraft(widget.root),
  );
  final _focus = FocusNode();
  final _scroll = ScrollController();
  bool _alsoSend = false;
  // The reply starts this thread's own Buddy session (reader's Buddy chat).
  bool _newSession = false;
  // Whether the list is scrolled away from its newest reply, the replies
  // there were when the thread opened or was last read to its end (set once
  // the thread's replies are known), and the latest replies and rows (replies
  // and those on their way): what came since is the control's count.
  bool _away = false, _atEnd = false, _baselined = false;
  int _repliesAtEnd = 0, _replies = 0, _rows = 0, _rowsMeasured = 0;
  // Each jump to the end supersedes the one before it.
  int _jumpRequest = 0;

  SuperTabController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    _focus.requestFocus();
    _scroll.addListener(_measureAfterFrame);
  }

  @override
  void didUpdateWidget(SuperTabThreadPanel old) {
    super.didUpdateWidget(old);
    if (old.root != widget.root) {
      // Another thread starts from its top, with nothing counted.
      _away = false;
      _atEnd = false;
      _baselined = false;
      _repliesAtEnd = 0;
      _rowsMeasured = 0;
      _jumpRequest++;
      if (_scroll.hasClients) _scroll.jumpTo(0);
      // Each thread keeps its own draft.
      _composer.text = c.threadDraft(widget.root);
      _alsoSend = false;
      _newSession = false;
    }
  }

  @override
  void dispose() {
    _jumpRequest++;
    _scroll.dispose();
    _composer.dispose();
    _focus.dispose();
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
    if (_rows > _rowsMeasured && _atEnd && position.extentAfter >= 40) {
      _rowsMeasured = _rows;
      position.jumpTo(position.maxScrollExtent);
    }
    _rowsMeasured = _rows;
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

  /// Scrolls to the newest reply. A lazy list refines its extent as rows near
  /// the end are laid out, so one jump can stop above the last reply: jump
  /// again, a bounded number of times, until nothing is left below.
  void _jumpToLatest() {
    final request = ++_jumpRequest;
    void advance(int attempt) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || request != _jumpRequest || !_scroll.hasClients) return;
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || request != _jumpRequest || !_scroll.hasClients) {
            return;
          }
          if (_scroll.position.extentAfter > 1 && attempt < 12) {
            advance(attempt + 1);
          } else {
            _measure();
          }
        });
        WidgetsBinding.instance.scheduleFrame();
      });
      WidgetsBinding.instance.scheduleFrame();
    }

    advance(0);
  }

  /// Where "Also send" also puts the reply, as the chat is named: its hover
  /// says so, the chip itself stays short enough for the send row.
  String get _alsoSendHint {
    final group = c.selected;
    if (group != null && c.snapshot?.isProjectLead(group.id) == true) {
      return 'Also send to the project chat';
    }
    return group?.number != null
        ? 'Also send to the workgroup'
        : 'Also send to the chat';
  }

  bool get _writable =>
      c.canWrite && c.selected?.archived == false && !c.hasPendingAction;

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
      (_sessionLocked ||
          (_newSession &&
              !c.buddySessionsFull &&
              c.threadSessionBlocked == null));

  /// A session's thread stays in the thread: Also send is not offered there,
  /// nor for a reply that starts one.
  bool get _offersAlsoSend =>
      !_startsSession && c.threadSession(widget.root) == null;

  /// The files waiting to go with this thread's next reply.
  HarnessAttachments get _files =>
      c.threadAttachments(c.selectedId, widget.root);

  /// Whether files are going up or a message is on its way, when the box takes
  /// no more.
  bool get _busy => c.uploading || c.saving;

  /// The box was edited: keep it as this thread's draft.
  void _edited(String text) {
    c.setThreadDraft(widget.root, text);
    setState(() {});
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
    _rows = replies.length + pending.length;
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
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
                grid.AppDesktop.controlGap,
                grid.AppDesktop.controlGap,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text('Thread', style: DesktopChrome.heading()),
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
                  // As in the chat, a message's text can be selected and copied.
                  SelectionArea(
                    child: ListView(
                      controller: _scroll,
                      padding: const EdgeInsets.symmetric(
                        vertical: grid.AppDesktop.controlGap,
                      ),
                      children: [
                        if (root != null) widget.row(root, false),
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
                                    : () => unawaited(
                                        c.loadThread(earlier: true),
                                      ),
                                child: Text(
                                  c.readingEarlierReplies
                                      ? 'Loading earlier replies…'
                                      : 'Show earlier replies',
                                ),
                              ),
                            ),
                          ),
                        for (final (index, reply) in replies.indexed)
                          widget.row(
                            reply,
                            index > 0 &&
                                replies[index - 1].authorId == reply.authorId &&
                                replies[index - 1].fromAgent == reply.fromAgent,
                          ),
                        for (final sent in pending) widget.outgoing(sent),
                      ],
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
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _composerBox(),
                  if (_startsSession)
                    Padding(
                      padding: const EdgeInsets.only(
                        top: grid.AppDesktop.controlGap,
                      ),
                      child: Text(
                        'Your reply starts a new Buddy session',
                        key: const ValueKey('super-thread-session-note'),
                        style: DesktopChrome.metadata(
                          color: DesktopChrome.muted,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _composerBox() {
    final writable = _writable;
    final files = _files;
    final busy = _busy;
    final error = c.threadComposerError(c.selectedId, widget.root);
    return NewHarnessDropZone(
      attachments: files,
      enabled: writable && !busy,
      // A folder has no bytes to attach, and its path means nothing to a
      // reader on another computer: say so, as the chat does for a browser.
      onFolders: kIsWeb
          ? null
          : (_) => reportAttachProblem(
              context,
              'A folder can\'t be attached to a reply. Drop its files instead.',
            ),
      child: DecoratedBox(
        key: const ValueKey('super-thread-composer-surface'),
        decoration: BoxDecoration(
          color: DesktopChrome.field,
          borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
          border: Border.all(color: DesktopChrome.rim),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            grid.AppDesktop.groupGap,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.controlGap,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SuperTabComposerChips(controller: c, files: files),
              Focus(
                onKeyEvent: (_, event) {
                  switch (composerEnter(
                    event,
                    focused: _focus.hasFocus,
                    value: _composer.value,
                  )) {
                    case ComposerEnter.ignore:
                      return KeyEventResult.ignored;
                    case ComposerEnter.newline:
                      insertComposerNewline(_composer, _edited);
                      return KeyEventResult.handled;
                    case ComposerEnter.send:
                      unawaited(_send());
                      return KeyEventResult.handled;
                  }
                },
                child: NewHarnessPasteTarget(
                  attachments: files,
                  enabled: writable && !busy,
                  focusNode: _focus,
                  child: TextField(
                    key: const ValueKey('super-thread-composer'),
                    controller: _composer,
                    focusNode: _focus,
                    enabled: c.canWrite && c.selected?.archived == false,
                    minLines: 1,
                    maxLines: 6,
                    maxLength: kComposerMaxLength,
                    keyboardType: TextInputType.multiline,
                    style: DesktopChrome.text(),
                    decoration: InputDecoration(
                      isCollapsed: true,
                      constraints: const BoxConstraints(),
                      hintText: 'Reply',
                      hintStyle: DesktopChrome.text(color: DesktopChrome.muted),
                      contentPadding: EdgeInsets.zero,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      disabledBorder: InputBorder.none,
                      filled: false,
                      counterText: '',
                    ),
                    onChanged: _edited,
                  ),
                ),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: Text(
                    error,
                    key: const ValueKey('super-thread-error'),
                    style: DesktopChrome.control(),
                  ),
                ),
              const SizedBox(height: grid.AppDesktop.controlGap),
              Row(
                children: [
                  Expanded(
                    child: Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 4,
                      runSpacing: 4,
                      children: [
                        if (_offersSession) _sessionChoice(writable),
                        if (_offersAlsoSend)
                          SuperTabComposerToggle(
                            key: const ValueKey('super-thread-also-send'),
                            on: _alsoSend,
                            label: 'Also send',
                            hint: _alsoSendHint,
                            onChanged: writable
                                ? (on) => setState(() => _alsoSend = on)
                                : null,
                          ),
                      ],
                    ),
                  ),
                  NewHarnessAttachButton(
                    attachments: files,
                    enabled: writable && !busy,
                  ),
                  ListenableBuilder(
                    listenable: files,
                    builder: (context, _) => AppIconButton(
                      key: const ValueKey('super-thread-send'),
                      icon: AppIcons.arrowUp,
                      tooltip: 'Send reply',
                      color: DesktopChrome.accent,
                      onPressed:
                          writable &&
                              !busy &&
                              (_composer.text.trim().isNotEmpty ||
                                  !files.isEmpty)
                          ? () => unawaited(_send())
                          : null,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// New session, left of Also send: on and locked once the thread's session
  /// ended; greyed while it can't start, its hover saying why.
  Widget _sessionChoice(bool writable) {
    final locked = _sessionLocked;
    // What the server would refuse is said before sending: a block (paused,
    // no Buddy, an older host) before the limit.
    final blocked = c.threadSessionBlocked;
    final full = !locked && blocked == null && c.buddySessionsFull;
    return SuperTabComposerToggle(
      key: const ValueKey('super-thread-new-session'),
      on: locked || (_newSession && !full && blocked == null),
      label: 'New session',
      hint:
          blocked ??
          (locked
              ? 'This thread\'s session ended. Your reply starts a new one.'
              : full
              ? '${SuperTabController.maxBuddySessions} sessions running. End one to start another.'
              : 'Starts a separate Buddy session for this thread'),
      onChanged: writable && !locked && !full && blocked == null
          ? (on) => setState(() => _newSession = on)
          : null,
    );
  }
}
