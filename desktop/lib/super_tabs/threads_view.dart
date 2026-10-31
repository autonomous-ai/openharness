import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'attention.dart';
import 'identity.dart';
import 'machine_status.dart' show superTabAgo;
import 'model.dart';
import 'project_sidebar.dart' show kProductManagersChannel;
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
  });

  final SuperTabAttention attention;

  /// Opens [rootId]'s thread in its chat [conversationId].
  final void Function(String conversationId, String rootId) onOpen;
  final DateTime Function() now;

  @override
  State<SuperTabThreadsView> createState() => _SuperTabThreadsViewState();
}

class _SuperTabThreadsViewState extends State<SuperTabThreadsView> {
  final _drafts = <String, TextEditingController>{};
  final _sending = <String>{};
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
    for (final draft in _drafts.values) {
      draft.dispose();
    }
    super.dispose();
  }

  SuperTabSnapshot? get _snapshot => _attention.controller.snapshot;

  /// Where a thread is, named as the sidebar names it.
  String _place(SuperTabFollowedThread thread) {
    final snapshot = _snapshot;
    final group = snapshot?.conversation(thread.conversationId);
    if (snapshot == null || group == null) return '';
    if (group.id == snapshot.leadsConversationId) {
      return '# $kProductManagersChannel';
    }
    final project = snapshot.projectFor(group.id);
    if (snapshot.isProjectLead(group.id)) return '# ${project?.name ?? ''}';
    if (group.isBuddyChat) return 'Buddy · ${project?.name ?? ''}';
    final name = SuperTabWorkgroupName.plain(group);
    return project == null ? name : '# ${project.name} · $name';
  }

  /// An author as the chat names them now.
  String _name(Map<String, dynamic> author) {
    final snapshot = _snapshot;
    final id = author['id'] as String? ?? '';
    final recorded =
        author['displayName'] as String? ?? author['name'] as String? ?? '';
    if (author['kind'] == 'agent') {
      return snapshot?.agentName(id, fallback: recorded) ?? recorded;
    }
    return snapshot?.people.where((p) => p.id == id).firstOrNull?.username ??
        superTabPersonName(recorded);
  }

  Widget? _face(Map<String, dynamic> author) {
    final snapshot = _snapshot;
    final id = author['id'] as String? ?? '';
    if (author['kind'] == 'agent') {
      return switch (snapshot?.agent(id)) {
        final agent? => SuperTabAvatar.agent(
          agent,
          name: _name(author),
          size: 24,
          engineBadge: false,
        ),
        null => null,
      };
    }
    return switch (snapshot?.people.where((p) => p.id == id).firstOrNull) {
      final person? => SuperTabAvatar.person(person, size: 24),
      null => null,
    };
  }

  Future<void> _reply(SuperTabFollowedThread thread) async {
    final draft = _drafts[thread.key];
    final text = draft?.text.trim() ?? '';
    if (draft == null || text.isEmpty || !_sending.add(thread.key)) return;
    setState(() {});
    final sent = await _attention.controller.replyInThread(
      thread.conversationId,
      thread.rootId,
      text,
    );
    if (!mounted) return;
    setState(() => _sending.remove(thread.key));
    if (sent == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('Reply not sent. Try again.')),
      );
      return;
    }
    if (draft.text.trim() == text) draft.clear();
  }

  Future<void> _follow(SuperTabFollowedThread thread, bool follow) async {
    final kept = await _attention.setFollow(thread, follow);
    if (!mounted || kept) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(
          follow ? 'Could not follow this thread.' : 'Could not unfollow.',
        ),
      ),
    );
  }

  Widget _message(
    Map<String, dynamic> author,
    String text, {
    DateTime? at,
    required bool strong,
    int lines = 3,
  }) {
    final face = _face(author);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(right: 10, top: 2),
          child: SizedBox(width: 24, height: 24, child: face),
        ),
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
                    const SizedBox(width: 8),
                    Text(
                      superTabAgo(widget.now().difference(at)),
                      style: DesktopChrome.metadata(),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 2),
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
  }

  Widget _thread(SuperTabFollowedThread thread) {
    final fresh = _attention.isNew(thread);
    final replies = _attention.newReplies[thread.key];
    final snapshot = _snapshot;
    final accent = DesktopChrome.accent;
    final canReply =
        fresh &&
        _attention.controller.canWrite &&
        snapshot?.conversation(thread.conversationId)?.archived == false;
    final draft = canReply
        ? _drafts.putIfAbsent(thread.key, TextEditingController.new)
        : null;
    final followed = thread.follow != false;
    final count = thread.unreadReplies;
    return Padding(
      key: ValueKey('super-thread-${thread.key}'),
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 4),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      _place(thread),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(),
                    ),
                  ),
                  if (_attention.followSupported)
                    TextButton(
                      key: ValueKey('super-thread-follow-${thread.key}'),
                      onPressed: _attention.following.contains(thread.key)
                          ? null
                          : () => unawaited(_follow(thread, !followed)),
                      child: Text(followed ? 'Unfollow' : 'Follow'),
                    ),
                ],
              ),
              InkWell(
                key: ValueKey('super-thread-open-${thread.key}'),
                onTap: () =>
                    widget.onOpen(thread.conversationId, thread.rootId),
                hoverColor: grid.AppSurface.hoverFill,
                focusColor: grid.AppSurface.hoverFill,
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: _message(
                    thread.rootAuthor,
                    thread.rootText,
                    at: DateTime.tryParse(
                      thread.root['createdAt'] as String? ?? '',
                    ),
                    strong: fresh,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(left: 34, top: 2),
                child: fresh
                    ? Text(
                        count == 1 ? '1 new reply' : '$count new replies',
                        style: DesktopChrome.metadata(color: accent)
                            .copyWith(fontWeight: grid.AppFont.semibold),
                      )
                    : Text(
                        [
                          if (thread.replies case final n?)
                            n == 1 ? '1 reply' : '$n replies',
                          if (thread.lastReplyAt case final at?)
                            'last ${superTabAgo(widget.now().difference(at))}',
                        ].join(' · '),
                        style: DesktopChrome.metadata(),
                      ),
              ),
              if (fresh && replies != null)
                for (final reply in replies)
                  Padding(
                    padding: const EdgeInsets.only(left: 34, top: 8),
                    child: _message(
                      reply.author,
                      reply.text,
                      at: reply.createdAt,
                      strong: true,
                      lines: 4,
                    ),
                  ),
              if (draft != null)
                Padding(
                  padding: const EdgeInsets.only(left: 34, top: 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          key: ValueKey('super-thread-reply-${thread.key}'),
                          controller: draft,
                          minLines: 1,
                          maxLines: 4,
                          style: DesktopChrome.control(),
                          decoration: const InputDecoration(
                            hintText: 'Reply…',
                            isDense: true,
                          ),
                          onSubmitted: (_) => unawaited(_reply(thread)),
                        ),
                      ),
                      const SizedBox(width: 8),
                      TextButton(
                        key: ValueKey('super-thread-send-${thread.key}'),
                        onPressed: _sending.contains(thread.key)
                            ? null
                            : () => unawaited(_reply(thread)),
                        child: const Text('Send'),
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
        padding: const EdgeInsets.only(bottom: 16),
        children: [
          if (a.error case final error?)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
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
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Text('Loading threads…', style: DesktopChrome.metadata()),
            )
          else if (a.loaded && shown.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Text(
                'No threads yet. Threads you start, reply in or are '
                'tagged in show here.',
                style: DesktopChrome.metadata(),
              ),
            ),
          if (fresh.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.fromLTRB(12, 16, 12, 4),
              child: SuperTabSectionHeading('New replies', endInset: 0),
            ),
            for (final thread in fresh) _thread(thread),
          ],
          if (rest.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.fromLTRB(12, 16, 12, 4),
              child: SuperTabSectionHeading('Earlier', endInset: 0),
            ),
            for (final thread in rest) _thread(thread),
          ],
          if (a.more)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
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
