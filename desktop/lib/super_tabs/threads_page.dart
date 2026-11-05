import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'activity.dart';
import 'activity_rows.dart' show threadSubject;
import 'attention.dart';
import 'composer_toggle.dart';
import 'controller.dart';
import 'decisions_view.dart' show quietDecisionAction;
import 'identity.dart' show superTabPersonName;
import 'model.dart';
import 'page_rows.dart';
import 'private_project_lock.dart';
import 'reply_box.dart';
import 'thread_cards.dart';

/// Threads, Slack's Threads view (anh Dee, 11-05, task #2996): one scrolling
/// page of cards, the threads with new replies first and then the read ones,
/// each newest activity first, 50 read ones at a time. A card shows its
/// project and subject, who is in it, the root in full, the last two replies
/// and a reply box, so a thread is read and answered without leaving the page.
class SuperTabThreadsPage extends StatefulWidget {
  const SuperTabThreadsPage({
    super.key,
    required this.activity,
    required this.onOpenThread,
    required this.message,
    this.now = DateTime.now,
  });

  final SuperTabActivity activity;

  /// Opens the thread beside its chat: its conversation, its root.
  final void Function(String conversationId, String root) onOpenThread;

  /// Draws one of a thread's messages, as its chat draws it.
  final Widget Function(SuperTabMessage message) message;
  final DateTime Function() now;

  @override
  State<SuperTabThreadsPage> createState() => _SuperTabThreadsPageState();
}

class _SuperTabThreadsPageState extends State<SuperTabThreadsPage> {
  late SuperTabActivity _activity = widget.activity;
  late SuperTabThreadCards _cards = SuperTabThreadCards.of(
    _activity.controller,
  );

  @override
  void initState() {
    super.initState();
    _activity.opened();
  }

  @override
  void didUpdateWidget(SuperTabThreadsPage old) {
    super.didUpdateWidget(old);
    if (old.activity != widget.activity) {
      _activity.closed();
      _cards.clear();
      _activity = widget.activity..opened();
      _cards = SuperTabThreadCards.of(_activity.controller);
    }
  }

  @override
  void dispose() {
    _activity.closed();
    _cards.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([_activity, _activity.attention, _cards]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final a = _activity, attention = a.attention;
      final unread = a.threadRows, read = a.readThreadRows;
      _cards.retain([
        for (final t in [...unread, ...read]) t.key,
      ]);
      Widget card(SuperTabFollowedThread t) => _ThreadCard(
        key: ValueKey('super-thread-card:${t.key}'),
        thread: t,
        activity: a,
        cards: _cards,
        onOpenThread: widget.onOpenThread,
        message: widget.message,
      );
      return LaidOutListView(
        key: const ValueKey('super-threads-list'),
        padding: const EdgeInsets.only(bottom: grid.AppDesktop.groupGap),
        children: [
          if (attention.error case final error?)
            superTabPageError(error, () => unawaited(attention.load())),
          if (unread.isEmpty && read.isEmpty)
            superTabPageEmpty('No threads yet')
          else ...[
            for (final t in unread) card(t),
            for (final t in read) card(t),
            if (attention.canReadMore)
              SuperTabReadMore(
                key: const ValueKey('super-threads-more'),
                onShown: attention.readMore,
              ),
          ],
        ],
      );
    },
  );
}

/// How the Swarm shows a message's [author] now, as the chat does: a person
/// by the name they set, an agent by its shown name; else the name recorded
/// with the message, an email cut to its name.
String _authorName(SuperTabController c, Map<String, dynamic> author) {
  final id = author['id'] as String? ?? '';
  final recorded = author['name'] as String? ?? '';
  final snapshot = c.snapshot;
  if (author['kind'] == 'agent') {
    final fallback = author['displayName'] as String? ?? recorded;
    return snapshot?.agentName(id, fallback: fallback) ?? fallback;
  }
  return snapshot?.people.where((p) => p.id == id).firstOrNull?.shownName ??
      superTabPersonName(recorded);
}

/// `Larch, River and dee`.
String _joined(List<String> names) => switch (names) {
  [] => '',
  [final one] => one,
  _ => '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}',
};

/// One thread's card. Built only near the screen, so only those read.
class _ThreadCard extends StatefulWidget {
  const _ThreadCard({
    super.key,
    required this.thread,
    required this.activity,
    required this.cards,
    required this.onOpenThread,
    required this.message,
  });

  final SuperTabFollowedThread thread;
  final SuperTabActivity activity;
  final SuperTabThreadCards cards;
  final void Function(String conversationId, String root) onOpenThread;
  final Widget Function(SuperTabMessage message) message;

  @override
  State<_ThreadCard> createState() => _ThreadCardState();
}

class _ThreadCardState extends State<_ThreadCard> {
  late final _text = TextEditingController(text: c.threadDraft(t.rootId));
  final _focus = FocusNode();
  bool _alsoSend = false;

  /// A load asked for after this frame, so a build asks once.
  bool _asked = false;

  /// This visit marked the thread read already.
  bool _marked = false;

  SuperTabController get c => widget.activity.controller;
  SuperTabFollowedThread get t => widget.thread;
  SuperTabAttention get attention => widget.activity.attention;
  String get _key => t.key;

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Reads the card when it was never read or its newest reply moved; a
  /// failed one waits for Retry.
  void _loadWhenStale(SuperTabThreadCard? card) {
    if (_asked || card?.loading == true || card?.error != null) return;
    if (!widget.cards.stale(t)) return;
    _asked = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _asked = false;
      if (mounted) unawaited(widget.cards.load(t));
    });
  }

  /// A card shown with its messages marks its thread read once, through its
  /// newest reply; it stays new, with its New line, until the page is left.
  void _markReadWhenShown(SuperTabThreadCard card) {
    if (_marked || card.loading || card.error != null) return;
    if (!attention.isNew(t) || t.unreadReplies <= 0) return;
    _marked = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        c.markThreadRead(t.conversationId, t.rootId, t.lastReplySequence);
      }
    });
  }

  /// The root the followed list carries, cut by the server: what a card
  /// shows when the thread itself can no longer be read.
  SuperTabMessage get _listedRoot => SuperTabMessage.fromJson({
    ...t.root,
    'id': t.rootId,
    'conversationId': t.conversationId,
    'thread': t.rootId,
    'sequence': (t.root['sequence'] as num?) ?? 0,
    'attachments': const [],
  });

  SuperTabConversation? get _group =>
      c.snapshot?.conversation(t.conversationId);

  bool get _enabled =>
      c.canWrite && _group?.archived == false && !c.isEarlierBuddyChat(_group);

  bool get _writable => _enabled && !c.hasPendingAction;

  /// A session's thread stays in the thread: no Also send there.
  bool get _alsoOffered => c.threadSession(t.rootId) == null;

  /// The project chat as its sidebar row names it, else the main chat, as the
  /// thread pane says it.
  String get _alsoLabel {
    final snapshot = c.snapshot;
    final channel = snapshot != null && snapshot.isProjectLead(t.conversationId)
        ? snapshot.projectFor(t.conversationId)?.name
        : null;
    return channel == null
        ? 'Also send to the main chat'
        : 'Also send to #$channel';
  }

  Future<void> _send() async {
    final files = c.threadAttachments(t.conversationId, t.rootId);
    if (!_writable ||
        c.uploading ||
        c.saving ||
        (_text.text.trim().isEmpty && files.isEmpty)) {
      return;
    }
    final root = t.rootId;
    c.setThreadDraft(root, _text.text, conversationId: t.conversationId);
    await c.sendThreadReply(
      to: (conversationId: t.conversationId, root: root),
      alsoSend: _alsoOffered && _alsoSend,
      onSending: () {
        if (!mounted || c.threadDraft(root).isNotEmpty) return;
        _text.clear();
        setState(() => _alsoSend = false);
      },
    );
  }

  Widget _title() {
    final project = c.snapshot?.projectFor(t.conversationId);
    final subject = threadSubject(t.rootText);
    final style = DesktopChrome.control().copyWith(
      fontWeight: grid.AppFont.semibold,
    );
    final title = project == null
        ? Text(
            subject,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          )
        : project.isPrivate
        ? Text.rich(
            TextSpan(
              children: [
                WidgetSpan(
                  alignment: PlaceholderAlignment.middle,
                  child: PrivateProjectLock(size: 12, color: style.color),
                ),
                TextSpan(text: ' ${project.name} · $subject'),
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          )
        : Text(
            '# ${project.name} · $subject',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          );
    return Row(
      children: [
        Flexible(
          child: InkWell(
            key: ValueKey('super-thread-card-title:$_key'),
            onTap: () => widget.onOpenThread(t.conversationId, t.rootId),
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            child: title,
          ),
        ),
        const Spacer(),
        if (attention.followSupported)
          quietDecisionAction(
            key: ValueKey('super-thread-card-unfollow:$_key'),
            label: 'Unfollow',
            onPressed: attention.following.contains(_key)
                ? null
                : () => unawaited(attention.setFollow(t, false)),
          ),
      ],
    );
  }

  /// The rule above the first unread reply, the word New on it.
  Widget _newLine() {
    final rule = Expanded(
      child: Divider(height: 1, thickness: 1, color: DesktopChrome.accent),
    );
    return Padding(
      key: ValueKey('super-thread-card-new:$_key'),
      padding: const EdgeInsets.symmetric(vertical: grid.AppDesktop.controlGap),
      child: Row(
        children: [
          rule,
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.controlGap,
            ),
            child: Text(
              'New',
              style: DesktopChrome.metadata(color: DesktopChrome.accent)
                  .copyWith(fontWeight: grid.AppFont.semibold),
            ),
          ),
          rule,
        ],
      ),
    );
  }

  List<Widget> _messages(SuperTabThreadCard? card) {
    if (card == null || (card.loading && card.root == null)) {
      return [
        SkeletonList(
          key: ValueKey('super-thread-card-loading:$_key'),
          rows: 1,
          itemBuilder: (context, _) => const SkeletonListTile(
            leading: 32,
            leadingRadius: 8,
            padding: EdgeInsets.all(grid.AppDesktop.controlGap),
          ),
        ),
      ];
    }
    final shown = card.replies.length > 2
        ? card.replies.sublist(card.replies.length - 2)
        : card.replies;
    final hidden = card.count - shown.length;
    final fresh = attention.isNew(t)
        ? attention.newCount(t).clamp(0, shown.length)
        : 0;
    return [
      widget.message(card.root ?? _listedRoot),
      if (card.error case final error?)
        Row(
          children: [
            Expanded(child: Text(error, style: DesktopChrome.control())),
            TextButton(
              key: ValueKey('super-thread-card-retry:$_key'),
              onPressed: card.loading
                  ? null
                  : () => unawaited(widget.cards.load(t)),
              child: const Text('Retry'),
            ),
          ],
        ),
      if (hidden > 0)
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            key: ValueKey('super-thread-card-more:$_key'),
            onPressed: () => widget.onOpenThread(t.conversationId, t.rootId),
            child: Text(
              hidden == 1 ? 'Show 1 more reply' : 'Show $hidden more replies',
            ),
          ),
        ),
      for (final (index, reply) in shown.indexed) ...[
        if (fresh > 0 && index == shown.length - fresh) _newLine(),
        widget.message(reply),
      ],
    ];
  }

  Widget _replyBox() => SuperTabReplyBox(
    controller: c,
    text: _text,
    focus: _focus,
    files: c.threadAttachments(t.conversationId, t.rootId),
    enabled: _enabled,
    writable: _writable,
    busy: c.uploading || c.saving,
    error: c.threadComposerError(t.conversationId, t.rootId),
    hint: 'Reply…',
    onEdited: (text) {
      c.setThreadDraft(t.rootId, text, conversationId: t.conversationId);
      setState(() {});
    },
    onSend: () => unawaited(_send()),
    surfaceKey: ValueKey('super-thread-card-surface:$_key'),
    fieldKey: ValueKey('super-thread-card-field:$_key'),
    sendKey: ValueKey('super-thread-card-send:$_key'),
    tagKey: ValueKey('super-thread-card-tag:$_key'),
    micKey: ValueKey('super-thread-card-mic:$_key'),
  );

  @override
  Widget build(BuildContext context) {
    final card = widget.cards.card(t);
    _loadWhenStale(card);
    if (card != null) _markReadWhenShown(card);
    final people = [
      for (final author in card?.people ?? const <Map<String, dynamic>>[])
        _authorName(c, author),
    ].where((name) => name.isNotEmpty).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        grid.AppDesktop.groupGap,
        grid.AppDesktop.groupGap,
        grid.AppDesktop.groupGap,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _title(),
          if (people.isNotEmpty)
            Text(
              _joined(people),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(),
            ),
          const SizedBox(height: grid.AppDesktop.controlGap),
          DecoratedBox(
            decoration: BoxDecoration(
              border: Border.all(color: DesktopChrome.rim),
              borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            ),
            child: Padding(
              padding: const EdgeInsets.all(grid.AppDesktop.controlGap),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ..._messages(card),
                  const SizedBox(height: grid.AppDesktop.controlGap),
                  _replyBox(),
                  if (_alsoOffered)
                    Padding(
                      padding: const EdgeInsets.only(
                        top: grid.AppDesktop.controlGap,
                      ),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: SuperTabComposerToggle(
                          key: ValueKey('super-thread-card-also:$_key'),
                          on: _alsoSend,
                          label: _alsoLabel,
                          hint: '$_alsoLabel as well as this thread',
                          onChanged: _writable
                              ? (on) => setState(() => _alsoSend = on)
                              : null,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
