import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'attention.dart';
import 'composer_tags.dart';
import '../shared/theme/app_icons.dart';
import 'controller.dart';
import 'identity.dart';
import 'message_more_menu.dart';
import 'machine_status.dart' show superTabAgo;
import 'model.dart';
import 'reply_box.dart';
import 'section_heading.dart';
import 'workgroup_name.dart';

/// How many threads with new replies read their replies when the view opens;
/// the rest show their root and count until opened.
const kThreadsShowingReplies = 10;

/// Slack's Threads view: every thread the reader follows (started, replied
/// in, tagged in, or followed by hand), those with new replies first and in
/// bold with the new replies under the root and a reply box, the rest after.
/// Showing a thread's new replies marks it read, on every device; it stays
/// new until the view is left.
class SuperTabThreadsView extends StatefulWidget {
  const SuperTabThreadsView({
    super.key,
    required this.attention,
    required this.onOpen,
    this.now = DateTime.now,
    this.machineName,
  });

  final SuperTabAttention attention;

  /// Names an agent's machine in the @ list, as the thread pane does.
  final String Function(String machineId)? machineName;

  /// Opens [rootId]'s thread in its chat [conversationId].
  final void Function(String conversationId, String rootId) onOpen;
  final DateTime Function() now;

  @override
  State<SuperTabThreadsView> createState() => _SuperTabThreadsViewState();
}

class _SuperTabThreadsViewState extends State<SuperTabThreadsView> {
  late SuperTabAttention _attention;

  @override
  void initState() {
    super.initState();
    _attention = widget.attention..opened();
  }

  @override
  void didUpdateWidget(SuperTabThreadsView old) {
    super.didUpdateWidget(old);
    if (old.attention != widget.attention) {
      old.attention.closed();
      _attention = widget.attention..opened();
    }
  }

  @override
  void dispose() {
    _attention.closed();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _attention,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final a = _attention;
      final shown = a.shown;
      final fresh = shown.where(a.isNew).toList();
      final rest = shown.where((t) => !a.isNew(t)).toList();
      // Opening reads what it shows: the first threads with new replies.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        for (final thread in fresh.take(kThreadsShowingReplies)) {
          unawaited(a.showReplies(thread));
        }
      });
      return ListView(
        key: const ValueKey('super-threads-view'),
        padding: const EdgeInsets.only(bottom: grid.AppDesktop.groupGap),
        children: [
          if (a.error case final error?)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
                grid.AppDesktop.groupGap,
                0,
              ),
              child: Row(
                children: [
                  Expanded(child: Text(error, style: DesktopChrome.control())),
                  TextButton(
                    onPressed: () => unawaited(a.load()),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          if (!a.loaded && a.error == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
              ),
              child: Text('Loading threads…', style: DesktopChrome.metadata()),
            )
          else if (a.loaded && shown.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
              ),
              child: Text(
                'No threads yet. Threads you start, reply in or are '
                'tagged in show here.',
                style: DesktopChrome.metadata(),
              ),
            ),
          if (fresh.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
              ),
              child: SuperTabSectionHeading('New replies', endInset: 0),
            ),
            for (final thread in fresh)
              _ThreadCard(
                key: ValueKey('super-thread-${thread.key}'),
                attention: a,
                thread: thread,
                onOpen: widget.onOpen,
                now: widget.now,
                machineName: widget.machineName,
              ),
          ],
          if (rest.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
              ),
              child: SuperTabSectionHeading('Earlier', endInset: 0),
            ),
            for (final thread in rest)
              _ThreadCard(
                key: ValueKey('super-thread-${thread.key}'),
                attention: a,
                thread: thread,
                onOpen: widget.onOpen,
                now: widget.now,
                machineName: widget.machineName,
              ),
          ],
          if (a.more)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
                grid.AppDesktop.groupGap,
                grid.AppDesktop.controlGap,
              ),
              child: Text(
                'Older threads are not listed.',
                style: DesktopChrome.metadata(),
              ),
            ),
        ],
      );
    },
  );
}

/// One followed thread in the list: where it is, its root, its new replies
/// and a reply box while it is new, else its reply count. Follow or Unfollow
/// waits behind a quiet ⋯ that shows on hover or focus, as in Slack.
class _ThreadCard extends StatefulWidget {
  const _ThreadCard({
    super.key,
    required this.attention,
    required this.thread,
    required this.onOpen,
    required this.now,
    this.machineName,
  });

  final SuperTabAttention attention;
  final SuperTabFollowedThread thread;
  final String Function(String machineId)? machineName;
  final void Function(String conversationId, String rootId) onOpen;
  final DateTime Function() now;

  @override
  State<_ThreadCard> createState() => _ThreadCardState();
}

class _ThreadCardState extends State<_ThreadCard> {
  /// An avatar, and the column the text beside it starts at.
  static const _face = SuperTabAvatar.rowSize;
  static const _indent = _face + grid.AppDesktop.controlGap;

  late final _text = TextEditingController(
    text: _c.threadDraft(widget.thread.rootId),
  );
  final _focus = FocusNode(debugLabel: 'Threads reply');
  bool _hovered = false, _focused = false;

  // `@` in the reply box, as in the thread pane's (composer_tags.dart): the
  // choice selected, and the text before the caret where it was dismissed.
  final _tagIndex = ValueNotifier(0);
  final _tagDismissed = ValueNotifier<String?>(null);
  final _tagRows = List.generate(superTabCompletionLimit, (_) => GlobalKey());
  late final _tagBackspace = SuperTabTagBackspace(
    () => _c.threadMentions(_thread.conversationId, _thread.rootId).values,
  );

  SuperTabController get _c => widget.attention.controller;
  SuperTabFollowedThread get _thread => widget.thread;
  SuperTabSnapshot? get _snapshot => _c.snapshot;

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    _tagIndex.dispose();
    _tagDismissed.dispose();
    super.dispose();
  }

  /// The `@` tag typed at the caret.
  ({int start, int end, String query})? get _tagAt => superTabTagAtCaret(
    _text.value,
    dismissed: _tagDismissed.value,
    tags: _c.threadMentions(_thread.conversationId, _thread.rootId).values,
  );

  /// Who `@` offers in this reply: whom the thread's own chat offers.
  List<SuperTabComposerChoice> get _tagChoices {
    final group = _snapshot?.conversation(_thread.conversationId);
    if (!_writable || group == null) return const [];
    final at = _tagAt;
    if (at == null) return const [];
    return superTabTagChoices(
      _c,
      group,
      at.query,
      machineName: widget.machineName ?? (_) => '',
      choose: _chooseTag,
    );
  }

  void _chooseTag(String id, String name) {
    final at = _tagAt;
    if (at == null) return;
    final token = '@$name';
    final value = superTabInsertTag(_text.value, at, token);
    _c.setThreadDraft(_thread.rootId, value.text);
    _c.threadMention(id, token, to: _target);
    _text.value = value;
    _tagIndex.value = 0;
    _focus.requestFocus();
    setState(() {});
  }

  void _moveTag(int index) {
    _tagIndex.value = index;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final row = _tagRows[index].currentContext;
      if (mounted && row != null) Scrollable.ensureVisible(row, alignment: .5);
    });
  }

  /// Where the thread is, named as the sidebar names it.
  String _place() {
    final snapshot = _snapshot;
    final group = snapshot?.conversation(_thread.conversationId);
    if (snapshot == null || group == null) return '';
    final project = snapshot.projectFor(group.id);
    if (snapshot.isProjectLead(group.id)) return '# ${project?.name ?? ''}';
    if (group.isBuddyChat) return 'Buddy · ${project?.name ?? ''}';
    final name = SuperTabWorkgroupName.plain(group);
    return project == null ? name : '# ${project.name} · $name';
  }

  /// An author as the chat names them now.
  String _name(Map<String, dynamic> author) {
    final id = author['id'] as String? ?? '';
    final recorded =
        author['displayName'] as String? ?? author['name'] as String? ?? '';
    if (author['kind'] == 'agent') {
      return _snapshot?.agentName(id, fallback: recorded) ?? recorded;
    }
    return _snapshot?.people.where((p) => p.id == id).firstOrNull?.username ??
        superTabPersonName(recorded);
  }

  Widget? _avatar(Map<String, dynamic> author) {
    final id = author['id'] as String? ?? '';
    if (author['kind'] == 'agent') {
      return switch (_snapshot?.agent(id)) {
        final agent? => SuperTabAvatar.agent(
          agent,
          name: _name(author),
          size: _face,
          engineBadge: false,
        ),
        null => null,
      };
    }
    return switch (_snapshot?.people.where((p) => p.id == id).firstOrNull) {
      final person? => SuperTabAvatar.person(person, size: _face),
      null => null,
    };
  }

  Widget _message(
    Map<String, dynamic> author,
    String text, {
    DateTime? at,
    required bool strong,
    int lines = 3,
  }) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(width: _face, height: _face, child: _avatar(author)),
      const SizedBox(width: grid.AppDesktop.controlGap),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Flexible(
                  child: Text(
                    _name(author),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(medium: true).copyWith(
                      fontWeight: strong ? grid.AppFont.semibold : null,
                    ),
                  ),
                ),
                if (at != null) ...[
                  const SizedBox(width: grid.AppDesktop.controlGap),
                  Text(
                    superTabAgo(widget.now().difference(at)),
                    style: DesktopChrome.metadata(),
                  ),
                ],
              ],
            ),
            Text(
              text,
              maxLines: lines,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(
                color: strong ? null : DesktopChrome.muted,
              ),
            ),
          ],
        ),
      ),
    ],
  );

  /// The thread's root, for a reply sent from here.
  ({String conversationId, String root}) get _target =>
      (conversationId: _thread.conversationId, root: _thread.rootId);

  bool get _writable =>
      _c.canWrite &&
      _snapshot?.conversation(_thread.conversationId)?.archived == false &&
      !_c.hasPendingAction;

  bool get _busy => _c.uploading || _c.saving;

  void _edited(String text) {
    _c.setThreadDraft(_thread.rootId, text);
    _tagIndex.value = 0;
    _tagDismissed.value = null;
    setState(() {});
  }

  Future<void> _send() async {
    final files = _c.threadAttachments(_thread.conversationId, _thread.rootId);
    if (!_writable || _busy || (_text.text.trim().isEmpty && files.isEmpty)) {
      return;
    }
    final root = _thread.rootId;
    _c.setThreadDraft(root, _text.text);
    await _c.sendThreadReply(
      to: _target,
      onSending: () {
        if (mounted && _c.threadDraft(root).isEmpty) _text.clear();
      },
    );
    if (mounted) setState(() {});
  }

  Future<void> _follow(bool follow) async {
    final kept = await widget.attention.setFollow(_thread, follow);
    if (!mounted || kept) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(
          follow ? 'Could not follow this thread.' : 'Could not unfollow.',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final a = widget.attention;
    final fresh = a.isNew(_thread);
    final replies = a.newReplies[_thread.key];
    final count = a.newCount(_thread);
    final followed = _thread.follow != false;
    final group = _snapshot?.conversation(_thread.conversationId);
    final canReply = fresh && _c.canWrite && group?.archived == false;
    // A Buddy chat's thread may need a new session (its last one ended),
    // which only the thread pane offers: a box here would be refused.
    final buddyThread = group?.isBuddyChat == true;
    final showMore = _hovered || _focused;
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onFocusChange: (focused) => setState(() => _focused = focused),
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            grid.AppDesktop.groupGap,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.controlGap,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      _place(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(),
                    ),
                  ),
                  // Quiet until the card is pointed at or focused: the
                  // replies are what the eye is for (Lead's review, 10-31).
                  if (a.followSupported)
                    Opacity(
                      opacity: showMore ? 1 : 0,
                      child: KeyedSubtree(
                        key: ValueKey('super-thread-more-${_thread.key}'),
                        child: SuperTabMessageMoreMenu(
                          actions: [
                            followed
                                ? (
                                    label: 'Unfollow thread',
                                    icon: AppIcons.eyeOff,
                                    onPressed: () => unawaited(_follow(false)),
                                  )
                                : (
                                    label: 'Follow thread',
                                    icon: AppIcons.bell,
                                    onPressed: () => unawaited(_follow(true)),
                                  ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
              InkWell(
                key: ValueKey('super-thread-open-${_thread.key}'),
                onTap: () =>
                    widget.onOpen(_thread.conversationId, _thread.rootId),
                hoverColor: grid.AppSurface.hoverFill,
                focusColor: grid.AppSurface.hoverFill,
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: grid.AppDesktop.listRowGap,
                  ),
                  child: _message(
                    _thread.rootAuthor,
                    _thread.rootText,
                    at: DateTime.tryParse(
                      _thread.root['createdAt'] as String? ?? '',
                    ),
                    strong: fresh,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(left: _indent),
                child: fresh
                    ? Text(
                        count == 1 ? '1 new reply' : '$count new replies',
                        style: DesktopChrome.metadata(
                          color: DesktopChrome.accent,
                        ).copyWith(fontWeight: grid.AppFont.semibold),
                      )
                    : Text(
                        [
                          if (_thread.replies case final n?)
                            n == 1 ? '1 reply' : '$n replies',
                          if (_thread.lastReplyAt case final at?)
                            'last ${superTabAgo(widget.now().difference(at))}',
                        ].join(' · '),
                        style: DesktopChrome.metadata(),
                      ),
              ),
              if (fresh && replies != null)
                for (final reply in replies)
                  Padding(
                    padding: const EdgeInsets.only(
                      left: _indent,
                      top: grid.AppDesktop.controlGap,
                    ),
                    child: _message(
                      reply.author,
                      reply.text,
                      at: reply.createdAt,
                      strong: true,
                      lines: 4,
                    ),
                  ),
              if (canReply && buddyThread)
                Padding(
                  padding: const EdgeInsets.only(
                    left: _indent,
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: TextButton(
                    key: ValueKey('super-thread-open-reply-${_thread.key}'),
                    onPressed: () =>
                        widget.onOpen(_thread.conversationId, _thread.rootId),
                    child: const Text('Open thread to reply'),
                  ),
                ),
              if (canReply && !buddyThread)
                Padding(
                  padding: const EdgeInsets.only(
                    left: _indent,
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // The @ list above the box, as in the thread pane.
                      ListenableBuilder(
                        listenable: Listenable.merge([
                          _text,
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
                              listKey: ValueKey(
                                'super-thread-completions-${_thread.key}',
                              ),
                              choices: choices,
                              index: _tagIndex.value,
                              rowKeys: _tagRows,
                            ),
                          );
                        },
                      ),
                      ListenableBuilder(
                        listenable: _c,
                        builder: (context, _) => SuperTabReplyBox(
                          controller: _c,
                          text: _text,
                          focus: _focus,
                          files: _c.threadAttachments(
                            _thread.conversationId,
                            _thread.rootId,
                          ),
                          enabled: _c.canWrite,
                          writable: _writable,
                          busy: _busy,
                          error: _c.threadComposerError(
                            _thread.conversationId,
                            _thread.rootId,
                          ),
                          onEdited: _edited,
                          onSend: () => unawaited(_send()),
                          surfaceKey: ValueKey(
                            'super-thread-reply-surface-${_thread.key}',
                          ),
                          fieldKey: ValueKey(
                            'super-thread-reply-${_thread.key}',
                          ),
                          sendKey: ValueKey('super-thread-send-${_thread.key}'),
                          // `@`: the open list takes its keys first.
                          onKey: (event) {
                            final composing = _text.value.composing;
                            return _focus.hasFocus &&
                                    !(composing.isValid &&
                                        !composing.isCollapsed)
                                ? superTabCompletionKey(
                                    event,
                                    choices: () => _tagChoices,
                                    index: _tagIndex.value,
                                    move: _moveTag,
                                    dismiss: () => _tagDismissed.value = _text
                                        .text
                                        .substring(
                                          0,
                                          _text.selection.baseOffset,
                                        ),
                                  )
                                : null;
                          },
                          inputFormatters: [_tagBackspace],
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
