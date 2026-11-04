import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/swarm_tokens_set_b.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_attach.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_conversation_page.dart';
import 'swarm_message_row.dart';
import 'swarm_outbox.dart';
import 'swarm_paste.dart';
import 'swarm_session.dart';
import 'swarm_session_widgets.dart';
import 'swarm_thread.dart';
import 'swarm_voice.dart';

/// Draws one of a thread's messages as its chat draws them; a tap on it
/// opens or closes its actions ([acting]).
typedef SwarmThreadRow = Widget Function(
  SwarmThread thread,
  SuperTabMessage message, {
  required bool grouped,
  required bool acting,
  required bool lit,
  required bool followed,
  required VoidCallback onTap,
});

/// Draws the person's reply on its way: "Sending…", then "Not sent · Retry"
typedef SwarmThreadPending = Widget Function(
  SwarmThread thread,
  SwarmPost post,
);

/// One thread of a chat, full screen as Slack Mobile opens one: its root at
/// the top, "N replies", its replies, and a reply box at the foot with Also
/// send and the chat's + for files (the desktop's thread panel, Tony's
/// mockup of 10-29).
///
/// Its rows are drawn by the chat that opened it ([row], [pending]), so a
/// message looks the same in both. While it is up its Swarm is watched, so
/// replies arrive as they do in the chat.
class SwarmThreadPage extends StatefulWidget {
  const SwarmThreadPage({
    super.key,
    required this.swarmId,
    required this.chat,
    required this.root,
    required this.title,
    required this.row,
    required this.pending,
    this.focus,
  });

  final String swarmId;
  final SwarmConversation chat;

  /// The id of the message the thread hangs from.
  final String root;

  /// The chat's name, under "Thread".
  final String? title;
  final SwarmThreadRow row;
  final SwarmThreadPending pending;

  /// Where the thread lands once it is read; none shows it from its top.
  final SwarmThreadFocus? focus;

  @override
  State<SwarmThreadPage> createState() => _SwarmThreadPageState();
}

class _SwarmThreadPageState extends State<SwarmThreadPage> {
  late final SwarmThread _thread = SwarmThread(widget.chat, widget.root);
  late final _text = TextEditingController(text: _thread.draft);
  final _focus = FocusNode(debugLabel: 'Swarm thread reply');
  final _scroll = ScrollController();

  /// The latest reply is more than a screen below, where Jump to latest is
  /// offered.
  final _farBack = ValueNotifier<bool>(false);

  /// The message whose actions are open (Copy), by a tap on it.
  String? _acting;

  /// The row of [_acting], to bring its actions into view.
  final _actingKey = GlobalKey();

  /// Opens [id]'s actions, or closes them on a second tap. Opened under the
  /// last reply of a thread read to its foot they would be drawn under the
  /// box, so the row is scrolled just enough to show them (the chat, newest
  /// at its foot, grows upward and never hides them).
  void _toggleActions(String id) {
    setState(() => _acting = _acting == id ? null : id);
    if (_acting == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final row = _actingKey.currentContext;
      if (!mounted || _acting != id || row == null) return;
      unawaited(
        Scrollable.ensureVisible(
          row,
          alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
          duration: const Duration(milliseconds: 150),
        ),
      );
    });
  }

  /// The thread's read mark as it was when the page opened, before showing
  /// the thread moves it: the first unread reply is the first after it.
  late final int _readThrough = widget.focus?.after ?? _markAtOpen();

  int _markAtOpen() {
    final chat = widget.chat, reader = chat.reader;
    return reader.readMarks?.threadThrough(chat.id, widget.root) ??
        reader.snapshot?.threadMarks[chat.id]?[widget.root] ??
        0;
  }

  /// The message the thread landed on, lit for a moment and keyed to be
  /// brought into view.
  String? _target, _lit;
  Timer? _litTimer;
  final _targetKey = GlobalKey();
  bool _landing = false;

  /// Reply options under the card is open: folded each time the page opens.
  bool _optionsOpen = false;

  /// Once the thread is read: finds the focus (reading earlier replies back
  /// to it, a bounded number of pages), scrolls to it and lights it for
  /// 2 seconds, as the chat does for a quoted message.
  void _land() {
    final focus = widget.focus;
    if (focus == null || _landing || _thread.state != SwarmChatState.loaded) {
      return;
    }
    _landing = true;
    unawaited(_findFocus(focus));
  }

  Future<void> _findFocus(SwarmThreadFocus focus) async {
    // The read that brought the thread is still finishing: its listeners run
    // before it lets another one start.
    await Future<void>.delayed(Duration.zero);
    final id = focus.messageId;
    String? target;
    if (id != null) {
      var pages = 0;
      bool found() => _thread.messages.any((m) => m.id == id);
      while (mounted &&
          !found() &&
          _thread.hasEarlier &&
          _thread.error == null &&
          pages++ < SwarmThreadFocus.maxEarlierPages) {
        await _thread.loadEarlier();
      }
      if (found()) target = id;
    } else {
      final replies = _thread.replies;
      target = replies.where((m) => m.sequence > _readThrough).firstOrNull?.id;
      target ??= replies.lastOrNull?.id;
    }
    if (!mounted || target == null) return;
    setState(() {
      _target = target;
      _lit = target;
    });
    _litTimer?.cancel();
    _litTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _lit = null);
    });
    _reveal(target, 0);
  }

  /// The list builds only the rows near what is shown: it jumps near the
  /// target by its place in the list until its row is built, then brings it
  /// to the middle (as the chat's `_reveal` does).
  void _reveal(String id, int attempt) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _target != id) return;
      if (_targetKey.currentContext case final row?) {
        unawaited(
          Scrollable.ensureVisible(
            row,
            alignment: 0.5,
            duration: const Duration(milliseconds: 250),
          ),
        );
        return;
      }
      final index = _thread.messages.indexWhere((m) => m.id == id);
      if (!_scroll.hasClients || index < 0 || attempt > 20) return;
      final count = _thread.messages.length;
      _scroll.position.jumpTo(
        (_scroll.position.maxScrollExtent * index / count).clamp(
          0,
          _scroll.position.maxScrollExtent,
        ),
      );
      _reveal(id, attempt + 1);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// What the last pick left out, or why it could not pick, under the box.
  final _attachNote = ValueNotifier<String?>(null);
  bool _picking = false;

  SwarmSession? _session;
  bool _watching = false;

  /// Not covered by a screen pushed over this one.
  bool _visible = true;

  /// The reply box's mic, while the shell can hear one ([SwarmScope.voiceOf]):
  /// the main chat's, a take sent as a reply.
  SwarmVoice? _voice;

  @override
  void initState() {
    super.initState();
    _text.addListener(_typed);
    _thread.composer.addListener(_drafted);
    _thread.addListener(_seen);
    _thread.addListener(_guardVoice);
    _thread.addListener(_land);
    // Before the thread shows, so showing it does not move the mark first.
    _readThrough;
    unawaited(_thread.load());
  }

  /// A thread the person can no longer reply in hears nothing: a take under
  /// way goes, nothing of it written or sent.
  void _guardVoice() {
    if (!_mayReply) _voice?.hide();
  }

  /// The person may still reply here.
  bool get _mayReply => _thread.state != SwarmChatState.lost && _thread.canPost;

  /// While on screen, what the thread shows is read ([SwarmThread.markRead]).
  void _seen() {
    if (_watching) _thread.markRead();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    // Off while a screen pushed over this one covers it.
    _visible = TickerMode.valuesOf(context).enabled;
    final watch = session != null && _visible;
    if (_voice == null) {
      if (SwarmScope.voiceOf(context) case final create?) {
        _voice = SwarmVoice(
          create: create,
          dictation: SwarmScope.dictationOf(context),
          draft: () => _thread.draft,
          write: (text) {
            if (_mayReply) _thread.draft = text;
          },
          post: () {
            if (mounted && _mayReply && _thread.canSend) unawaited(_send());
          },
        );
      }
    }
    // A covered thread hears nothing, nor one signed out of: its take goes
    // with it. Another account loses the thread's read ([_guardVoice]).
    if (!watch) _voice?.hide();
    _guardVoice();
    if (session != _session || watch != _watching) {
      if (_watching) _session?.unwatch(widget.swarmId);
      _session = session;
      _watching = watch;
      if (watch) session.watch(widget.swarmId);
    }
    _seen();
  }

  @override
  void dispose() {
    if (_watching) _session?.unwatch(widget.swarmId);
    _thread.composer.removeListener(_drafted);
    _thread.removeListener(_seen);
    _thread.removeListener(_guardVoice);
    _thread.removeListener(_land);
    _litTimer?.cancel();
    _voice?.dispose();
    _thread.dispose();
    _attachNote.dispose();
    _farBack.dispose();
    _text.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// What the person typed, into the draft.
  void _typed() {
    if (_thread.draft != _text.text) _thread.draft = _text.text;
  }

  /// The draft changed under the field — a reply sent, or refused and put
  /// back.
  void _drafted() {
    final draft = _thread.draft;
    if (draft == _text.text) return;
    _text.value = TextEditingValue(
      text: draft,
      selection: TextSelection.collapsed(offset: draft.length),
    );
  }

  /// The box's + ([attachSwarmFiles]), its files into the thread's.
  Future<void> _pickFiles() async {
    if (_picking) return;
    _picking = true;
    try {
      await attachSwarmFiles(
        context,
        _thread.files,
        // Nothing goes into a thread the person can no longer reply in.
        stillWanted: () =>
            mounted && _thread.state != SwarmChatState.lost && _thread.canPost,
        note: (note) => _attachNote.value = note,
      );
    } finally {
      _picking = false;
    }
  }

  /// A picture pasted into the box ([pasteSwarmImage]), into the thread's
  /// files, as the + puts a photo there.
  Future<void> _pasteImage(SwarmPastedImage image) => pasteSwarmImage(
    _thread.files,
    image,
    // Nothing goes into a thread the person can no longer reply in.
    stillWanted: () =>
        mounted && _thread.state != SwarmChatState.lost && _thread.canPost,
    note: (note) => _attachNote.value = note,
  );

  /// Whether the foot is more than a screen below ([_farBack]), on every
  /// scroll and whenever the thread's length changes.
  bool _measured(Notification n) {
    final ScrollMetrics? m = switch (n) {
      ScrollMetricsNotification() => n.metrics,
      ScrollUpdateNotification() => n.metrics,
      _ => null,
    };
    if (m != null) {
      _farBack.value = m.maxScrollExtent - m.pixels > m.viewportDimension;
    }
    return false;
  }

  /// Back down to the latest reply.
  void _toFoot() {
    if (!_scroll.hasClients) return;
    unawaited(
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      ),
    );
  }

  /// Sends the reply, at the foot of the thread where it shows. Once the
  /// backend took it the keyboard goes down, unless the next is being typed.
  Future<void> _send() async {
    _attachNote.value = null;
    if (_scroll.hasClients) {
      unawaited(
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        ),
      );
    }
    final sent = await _thread.send();
    if (sent && mounted && _thread.draft.isEmpty) _focus.unfocus();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(context, tty),
            ListenableBuilder(
              listenable: _thread,
              builder: (context, _) => SwarmThreadSessionLine(thread: _thread),
            ),
            // The box takes what it needs, up to all of the room under the
            // header, as the chat's composer does: on a short phone with the
            // keyboard up and the @ list open, the list and then the field
            // give up room before anything overflows.
            Expanded(
              child: LayoutBuilder(
                builder: (context, below) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: Stack(
                        children: [
                          Positioned.fill(
                            child: NotificationListener<Notification>(
                              onNotification: _measured,
                              child: ListenableBuilder(
                                // Message links resolve against the inbox's
                                // current reader, which can change
                                // independently of this thread's older
                                // conversation reader.
                                listenable: Listenable.merge([
                                  _thread,
                                  if (_session case final session?)
                                    session.inbox,
                                ]),
                                builder: (context, _) => _body(tty),
                              ),
                            ),
                          ),
                          Positioned(
                            left: 0,
                            right: 0,
                            bottom: 8,
                            child: ListenableBuilder(
                              listenable: Listenable.merge([_thread, _farBack]),
                              builder: (context, _) =>
                                  _farBack.value &&
                                      _thread.state == SwarmChatState.loaded
                                  ? Center(
                                      child: SwarmNewPill(
                                        count: 0,
                                        onTap: _toFoot,
                                      ),
                                    )
                                  : const SizedBox.shrink(),
                            ),
                          ),
                        ],
                      ),
                    ),
                    ConstrainedBox(
                      constraints: BoxConstraints(maxHeight: below.maxHeight),
                      child: ListenableBuilder(
                        listenable: Listenable.merge([
                          _thread,
                          _thread.composer,
                          _voice,
                        ]),
                        builder: (context, _) => _foot(tty),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _header(BuildContext context, Tty tty) => Padding(
    key: const ValueKey('swarm-thread-header'),
    padding: const EdgeInsets.fromLTRB(0, AppSpace.xs, AppSpace.s, AppSpace.xs),
    child: Row(
      children: [
        TtyBackButton(onPressed: () => Navigator.of(context).maybePop()),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text(
                  'Thread',
                  key: const ValueKey('swarm-title'),
                  style: tty.style(
                    size: TtySize.title,
                    weight: FontWeight.w600,
                  ),
                ),
              ),
              // Not named once the chat is no longer open to the person.
              ListenableBuilder(
                listenable: _thread,
                builder: (context, _) => switch (widget.title) {
                  final title? when _thread.state != SwarmChatState.lost =>
                    Text(
                      title,
                      key: const ValueKey('swarm-thread-chat-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: swarmChatText(13, color: AppPalette.textSecondary),
                    ),
                  _ => const SizedBox.shrink(),
                },
              ),
            ],
          ),
        ),
      ],
    ),
  );

  /// Until the thread is read, skeleton bubbles; what it could not read, with
  /// Try again; "not open" once the backend refused the chat; then the root,
  /// "N replies", the replies and a reply on its way.
  Widget _body(Tty tty) {
    final t = _thread;
    if (t.state == SwarmChatState.lost) {
      return _said('This chat is not open to you.');
    }
    final messages = t.messages;
    final root = t.rootMessage;
    if (t.state != SwarmChatState.loaded && root == null) {
      if (t.readError case final error?) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _said(error, key: const ValueKey('swarm-thread-error')),
            _Link(
              key: const ValueKey('swarm-thread-retry'),
              label: 'Try again',
              onTap: () => unawaited(t.load()),
            ),
          ],
        );
      }
      return const SwarmChatSkeleton();
    }
    if (messages.isEmpty) {
      return _said('The original message is no longer in this chat.');
    }
    final replies = t.replies;
    final count = t.count;
    final pending = t.outgoing;
    Widget row(SuperTabMessage m, {required bool grouped}) {
      final built = widget.row(
        t,
        m,
        grouped: grouped,
        acting: _acting == m.id,
        lit: _lit == m.id,
        followed: _target == m.id,
        onTap: () => _toggleActions(m.id),
      );
      if (_acting == m.id) return KeyedSubtree(key: _actingKey, child: built);
      return _target == m.id
          ? KeyedSubtree(key: _targetKey, child: built)
          : built;
    }

    return ListView(
      key: const ValueKey('swarm-thread-messages'),
      controller: _scroll,
      // As the chat: a finger's scroll puts the keyboard away, the draft
      // stays; a reply arriving or a jump moving the list leaves it up.
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      // The chat's own inset, so a message sits where it does there.
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.m,
        vertical: AppSpace.s,
      ),
      children: [
        if (root != null) row(root, grouped: false),
        if (count > 0)
          Padding(
            key: const ValueKey('swarm-thread-divider'),
            // In line with the avatars.
            padding: const EdgeInsets.all(AppSpace.s),
            child: Row(
              children: [
                Text(
                  count == 1 ? '1 reply' : '$count replies',
                  style: swarmChatText(13, color: AppPalette.textSecondary),
                ),
                const SizedBox(width: AppSpace.s),
                Expanded(child: Divider(height: 1, color: swarmChatHair(tty))),
              ],
            ),
          ),
        // What the chat has of it shows, and the rest is read again on a tap.
        if (t.readError case final error?) ...[
          _said(error, key: const ValueKey('swarm-thread-error')),
          Align(
            alignment: Alignment.centerLeft,
            child: _Link(
              key: const ValueKey('swarm-thread-retry'),
              label: 'Try again',
              onTap: () => unawaited(t.load()),
            ),
          ),
        ],
        if (t.hasEarlier)
          Align(
            alignment: Alignment.centerLeft,
            child: t.readingEarlier
                ? Padding(
                    key: const ValueKey('swarm-thread-earlier-loading'),
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpace.s,
                      vertical: AppSpace.m,
                    ),
                    child: Text(
                      'Loading earlier replies…',
                      style: swarmChatText(15, color: AppPalette.textSecondary),
                    ),
                  )
                : _Link(
                    key: const ValueKey('swarm-thread-earlier'),
                    label: 'Show earlier replies',
                    onTap: () => unawaited(t.loadEarlier()),
                  ),
          ),
        for (final (index, reply) in replies.indexed)
          row(
            reply,
            grouped:
                index > 0 &&
                replies[index - 1].authorId == reply.authorId &&
                replies[index - 1].fromAgent == reply.fromAgent,
          ),
        for (final post in pending) widget.pending(t, post),
      ],
    );
  }

  /// What could not be done, then the reply box — or why there is none.
  Widget _foot(Tty tty) {
    final t = _thread;
    if (t.state == SwarmChatState.lost) return const SizedBox.shrink();
    final group = t.chat.conversation;
    final error = t.error;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The first read's failure is said in the body, with Try again.
        if (error != null &&
            error != t.readError &&
            (t.rootMessage != null || t.outgoing.isNotEmpty))
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.screenInset,
              AppSpace.s,
              AppSpace.screenInset,
              0,
            ),
            child: Text(
              error,
              key: const ValueKey('swarm-thread-post-error'),
              style: swarmChatText(13.5, color: tty.red),
            ),
          ),
        if (t.canPost)
          Flexible(child: _box(t, tty))
        else if (group != null)
          Padding(
            padding: const EdgeInsets.all(AppSpace.l),
            child: Text(
              group.archived
                  ? 'This chat is archived.'
                  : 'You can read this chat, not post in it.',
              key: const ValueKey('swarm-thread-read-only'),
              style: swarmChatText(13.5, color: AppPalette.textSecondary),
            ),
          ),
      ],
    );
  }

  /// The reply box: the @ picker while a name is typed, notes, then the card
  /// ([SwarmComposerCard]) — the files going with the reply, a field that
  /// grows with what is typed and its X, then +, @, the mic and a round
  /// Send (the desktop's thread composer, with the main chat's mic and @)
  /// — and under the card Reply options, folded until tapped: New session
  /// and Also send, the desktop's two choices, both off to begin with
  /// ([_options]). While a take is under way the toolbar is the voice row
  /// ([SwarmVoiceRow]): the picker is hidden, and Reply options stays as it
  /// is but takes no taps, its ticks kept for the row's Send or the one
  /// after the take.
  Widget _box(SwarmThread t, Tty tty) {
    // A reply on its way never holds the box: the next is typed meanwhile.
    final canSend = t.canSend;
    final canAttach = !t.uploading && t.files.room > 0;
    final voice = _voice;
    final talking = voice?.face != null;
    final snapshot = t.reader.snapshot;
    final query = t.mentionQuery;
    final taggable =
        snapshot != null &&
        (t.mentionablePeople.isNotEmpty || t.mentionable.isNotEmpty);
    return Padding(
      key: const ValueKey('swarm-thread-box'),
      padding: SwarmComposer.padding,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The chat's picker: short of room, it scrolls in what is left.
          if (query != null && snapshot != null && !talking)
            Flexible(
              child: SwarmMentionPicker(
                people: t.mentionablePeople,
                agents: t.mentionable,
                snapshot: snapshot,
                query: query,
                onPick: (id) {
                  t.completeMention(id);
                  _focus.requestFocus();
                },
              ),
            ),
          ValueListenableBuilder(
            valueListenable: _attachNote,
            builder: (context, note, _) => note == null
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpace.xs,
                      0,
                      AppSpace.xs,
                      AppSpace.s,
                    ),
                    child: Text(
                      note,
                      key: const ValueKey('swarm-thread-attach-note'),
                      style: AppType.caption(color: tty.yellow),
                    ),
                  ),
          ),
          if (_voice?.notice case final notice?)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.xs,
                0,
                AppSpace.xs,
                AppSpace.s,
              ),
              child: Text(
                notice,
                key: const ValueKey('swarm-thread-voice-note'),
                style: AppType.caption(color: tty.yellow),
              ),
            ),
          // Quiet: nothing went wrong, the words stay in the box.
          if (_voice?.stopped case final stopped?)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.xs,
                0,
                AppSpace.xs,
                AppSpace.s,
              ),
              child: Text(
                stopped,
                key: const ValueKey('swarm-thread-voice-stopped'),
                style: AppType.caption(color: AppPalette.textSecondary),
              ),
            ),
          SwarmComposerCard(
            focus: _focus,
            chips: t.files.files.isEmpty ? null : SwarmOutgoingChips(box: t),
            field: SwarmMessageField(
              controller: _text,
              focus: _focus,
              hint: 'Reply',
              fieldKey: const ValueKey('swarm-thread-field'),
              clearKey: const ValueKey('swarm-thread-clear'),
              clearable: !talking,
              imagePaste: swarmSendsFiles
                  ? SwarmImagePaste(
                      enabled: canAttach,
                      onImage: (image) => unawaited(_pasteImage(image)),
                    )
                  : null,
            ),
            toolbar: talking
                ? SwarmVoiceRow(voice: voice!)
                : Row(
                    children: [
                      if (swarmSendsFiles)
                        SwarmAttachButton(
                          key: const ValueKey('swarm-thread-attach'),
                          onTap: canAttach
                              ? () => unawaited(_pickFiles())
                              : null,
                        ),
                      if (taggable)
                        SwarmTagButton(
                          open: query != null,
                          onTap: () {
                            t.toggleMention();
                            _focus.requestFocus();
                          },
                        ),
                      const Spacer(),
                      // The main chat's mic, beside Send as there.
                      if (voice != null) SwarmVoiceMic(voice: voice),
                      SwarmRoundButton(
                        key: const ValueKey('swarm-thread-send'),
                        label: 'Send reply',
                        face: 36,
                        fill: canSend ? AppPalette.accent : ttyRaised(tty),
                        onTap: canSend ? () => unawaited(_send()) : null,
                        child: Icon(
                          LucideIcons.arrowUp,
                          size: 20,
                          color: canSend ? AppInk.onFill : AppPalette.textFaint,
                        ),
                      ),
                    ],
                  ),
          ),
          // None in a session's thread: its replies stay in the thread.
          if (t.session == null)
            ..._options(t, talking: talking, picking: query != null),
        ],
      ),
    );
  }

  /// Reply options under the card: a line that says what is on while it is
  /// folded, and opens to New session (in the person's own Buddy chat) and
  /// Also send. A reply that starts a session never also goes to the chat:
  /// Also send then keeps its place, so the box does not jump. Short of
  /// room, the open choices scroll in what is left rather than overflow.
  /// While the @ picker is up they step aside for it, the line saying what
  /// is on and taking no taps, and come back after the pick.
  List<Widget> _options(
    SwarmThread t, {
    required bool talking,
    required bool picking,
  }) {
    final on = [
      if (t.offersSessions && t.newSession) 'New session',
      if (t.offersAlsoSend && t.alsoSend) t.alsoSendLabel,
    ];
    final open = _optionsOpen && !picking;
    return [
      IgnorePointer(
        ignoring: talking || picking,
        child: _ReplyOptionsToggle(
          open: open,
          on: on,
          onTap: () => setState(() => _optionsOpen = !open),
        ),
      ),
      if (open)
        Flexible(
          child: IgnorePointer(
            ignoring: talking,
            child: SingleChildScrollView(
              key: const ValueKey('swarm-thread-options-choices'),
              // Never the page's: a tap on the status bar scrolls the thread.
              primary: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (t.offersSessions) SwarmNewSessionCheck(thread: t),
                  t.offersAlsoSend
                      ? _AlsoSend(
                          label: t.alsoSendLabel,
                          value: t.alsoSend,
                          onChanged: (on) => t.alsoSend = on,
                        )
                      : const SizedBox(height: _AlsoSend.height),
                ],
              ),
            ),
          ),
        ),
    ];
  }

  Widget _said(String text, {Key? key}) => Padding(
    key: key,
    padding: const EdgeInsets.all(AppSpace.xl),
    child: Center(
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: swarmChatText(15, color: AppPalette.textSecondary),
      ),
    ),
  );
}

/// Reply options' line: its name and a chevron, and while folded what is
/// on, so a ticked choice is never out of sight. The whole line is a
/// thumb's target.
class _ReplyOptionsToggle extends StatelessWidget {
  const _ReplyOptionsToggle({
    required this.open,
    required this.on,
    required this.onTap,
  });

  final bool open;

  /// The labels of the choices that are on.
  final List<String> on;
  final VoidCallback onTap;

  static const _name = 'Reply options';

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final said = open || on.isEmpty ? _name : '$_name · ${on.join(' · ')}';
    return Semantics(
      key: const ValueKey('swarm-thread-options'),
      button: true,
      expanded: open,
      label: _name,
      value: on.isEmpty ? null : on.join(', '),
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: _AlsoSend.height),
          child: Padding(
            // Its words start where the checkboxes' squares do.
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
            child: Row(
              children: [
                Flexible(
                  child: Text(
                    said,
                    key: const ValueKey('swarm-thread-options-label'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: swarmChatText(14, color: AppPalette.textSecondary),
                  ),
                ),
                const SizedBox(width: AppSpace.xs),
                Icon(
                  open ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                  size: 16,
                  color: AppPalette.textSecondary,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Also send, ticked or not: the reply goes to the chat's main stream too.
/// The whole line is a thumb's target, and its label is never cut short:
/// large text wraps it instead.
class _AlsoSend extends StatelessWidget {
  const _AlsoSend({
    required this.label,
    required this.value,
    required this.onChanged,
  });

  /// The line's height at normal text size, kept while it is hidden.
  static const double height = 44;

  final String label;
  final bool value;

  /// Null while a reply is on its way.
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final enabled = onChanged != null;
    return Semantics(
      key: const ValueKey('swarm-thread-also-send'),
      checked: value,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? () => onChanged!(!value) : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: height),
          child: Row(
            children: [
              // The theme's checkbox, as the desktop's thread composer has.
              Checkbox(
                value: value,
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                onChanged: enabled ? (on) => onChanged!(on ?? false) : null,
              ),
              const SizedBox(width: AppSpace.s),
              Flexible(
                child: Text(
                  label,
                  key: const ValueKey('swarm-thread-also-send-label'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: swarmChatText(
                    14,
                    color: enabled
                        ? AppPalette.textPrimary
                        : AppPalette.textFaint,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A link in the accent: Show earlier replies, Try again.
class _Link extends StatelessWidget {
  const _Link({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => TtyTap(
    semanticsLabel: label,
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.s,
        vertical: AppSpace.m,
      ),
      child: Text(
        label,
        style: swarmChatText(15, color: AppPalette.accentOnSurface),
      ),
    ),
  );
}
