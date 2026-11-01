import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_inbox.dart' show SwarmListing;
import 'swarm_project_page.dart' show swarmChatRoute;
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_threads.dart';

/// The followed threads of the Swarms [shown] ([SwarmThreadsMerge]): every
/// Swarm's, or [swarmId]'s alone when Home shows that one. [changed] tells
/// when they may have changed, beside the inbox.
SwarmThreadsMerge swarmThreadsOf(
  SwarmSession session, {
  String? swarmId,
  List<SwarmListing> Function()? shown,
  Listenable? changed,
}) => SwarmThreadsMerge(
  source: session.inbox.threads,
  swarms:
      shown ??
      () => [
        for (final swarm in session.inbox.swarms)
          if (swarmId == null || swarm.id == swarmId) swarm,
      ],
  changed: changed == null
      ? session.inbox
      : Listenable.merge([session.inbox, changed]),
);

/// Opens Threads over [context]'s page, [swarmId]'s alone when Home shows
/// that Swarm.
void openSwarmThreads(BuildContext context, {String? swarmId}) => unawaited(
  Navigator.of(context).push(
    phoneRoute(
      (_) => SwarmThreadsPage(swarmId: swarmId),
      listensForItself: true,
    ),
  ),
);

/// Home's Threads row, over the projects: bold while a followed thread has
/// new replies, the person's tags in threads at its end (desktop's Threads
/// row, #2434). A tap opens Threads.
class SwarmThreadsRow extends StatelessWidget {
  const SwarmThreadsRow({
    super.key,
    required this.threads,
    required this.onTap,
  });

  final SwarmThreadsMerge threads;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: threads,
    builder: (context, _) {
      AppTheme.watch(context);
      final unread = threads.unread, tags = threads.mentions;
      final bright = unread || tags > 0;
      return Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: const ValueKey('swarm-threads-row'),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: SwarmRow.height),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpace.l,
                vertical: AppSpace.m,
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: 16,
                    child: Icon(
                      LucideIcons.messagesSquare300,
                      size: 16,
                      color: bright
                          ? AppPalette.textPrimary
                          : AppPalette.textSecondary,
                    ),
                  ),
                  const SizedBox(width: AppSpace.s),
                  Expanded(
                    child: Semantics(
                      label: unread && tags == 0 ? 'New replies' : null,
                      child: Text(
                        'Threads',
                        style: AppType.label(
                          color: bright
                              ? AppPalette.textPrimary
                              : AppPalette.textSecondary,
                          height: 1.3,
                          fontWeight: bright ? AppFont.semibold : null,
                        ),
                      ),
                    ),
                  ),
                  if (tags > 0)
                    SwarmTags(
                      tags,
                      key: const ValueKey('swarm-threads-tags'),
                      filled: true,
                    ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

/// Threads, as Slack's and the desktop's (#2434): the threads the person
/// follows, those with new replies first under New replies, each with its
/// newest replies, then Earlier. Opening it reads what it shows: each new
/// thread is marked read on every device once its replies are in. A tap
/// opens the thread in its chat; ⋯, or a long press, Follow or Unfollow.
class SwarmThreadsPage extends StatefulWidget {
  const SwarmThreadsPage({super.key, this.swarmId, this.now = DateTime.now});

  /// Home shows this Swarm alone; null for every Swarm.
  final String? swarmId;
  final DateTime Function() now;

  @override
  State<SwarmThreadsPage> createState() => _SwarmThreadsPageState();
}

class _SwarmThreadsPageState extends State<SwarmThreadsPage> {
  SwarmSession? _session;
  SwarmThreadsMerge? _threads;
  bool _seen = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    final seen = session != null && !OutOfSight.of(context);
    if (!identical(session, _session)) {
      _see(false);
      _threads?.dispose();
      _session = session;
      _threads = session == null
          ? null
          : swarmThreadsOf(session, swarmId: widget.swarmId);
    }
    _see(seen);
  }

  /// In sight: the Swarms are read, and the page reads its threads (and
  /// marks what it shows); out of sight, neither.
  void _see(bool seen) {
    final session = _session, threads = _threads;
    if (session == null || threads == null || seen == _seen) return;
    _seen = seen;
    if (seen) {
      session.enter();
      threads.opened();
      unawaited(session.inbox.refresh());
    } else {
      threads.closed();
      session.leave();
    }
  }

  @override
  void dispose() {
    _see(false);
    _threads?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final threads = _threads;
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: 'Threads',
            ),
            if (threads != null)
              Expanded(
                child: ListenableBuilder(
                  listenable: threads,
                  builder: (context, _) => _list(context, threads),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _list(BuildContext context, SwarmThreadsMerge threads) {
    final fresh = threads.fresh, rest = threads.rest;
    // What it shows is read: the first threads with new replies.
    if (_seen) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _seen) threads.showReplies();
      });
    }
    final note = AppType.caption(color: AppPalette.textSecondary, height: 1.35);
    Widget card(SwarmThreadEntry entry) => SwarmThreadCard(
      key: ValueKey('swarm-thread-${entry.swarmId}/${entry.thread.key}'),
      threads: threads,
      entry: entry,
      now: widget.now(),
      onOpen: () => _open(context, threads, entry),
      onMore: () => _more(context, threads, entry),
    );
    return ListView(
      key: const ValueKey('swarm-threads-list'),
      padding: EdgeInsets.fromLTRB(
        AppSpace.m,
        AppSpace.xs,
        AppSpace.m,
        MediaQuery.paddingOf(context).bottom + AppSpace.xl,
      ),
      children: [
        if (threads.error case final error?)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
            child: Row(
              children: [
                Expanded(child: Text(error, style: note)),
                SwarmButton(
                  key: const ValueKey('swarm-threads-retry'),
                  label: 'Try again',
                  style: SwarmButtonStyle.link,
                  onPressed: threads.retry,
                ),
              ],
            ),
          ),
        if (!threads.loaded)
          SwarmSkeletonRows(id: 'swarm-threads-loading', round: true)
        else if (fresh.isEmpty && rest.isEmpty && threads.error == null)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.xs,
              vertical: AppSpace.s,
            ),
            child: Text(
              'No threads yet.',
              key: const ValueKey('swarm-threads-none'),
              style: note,
            ),
          ),
        if (fresh.isNotEmpty) ...[
          const SwarmCaption('New replies', first: true),
          SwarmGroup(children: [for (final entry in fresh) card(entry)]),
        ],
        if (rest.isNotEmpty) ...[
          SwarmCaption('Earlier', first: fresh.isEmpty),
          SwarmGroup(children: [for (final entry in rest) card(entry)]),
        ],
        if (threads.more)
          Padding(
            padding: const EdgeInsets.all(AppSpace.s),
            child: Text('Older threads are not listed.', style: note),
          ),
      ],
    );
  }

  /// Opens [entry]'s chat at its newest new reply, which opens its thread,
  /// else at its root with its thread open over it, as the desktop's Threads
  /// opens one.
  void _open(
    BuildContext context,
    SwarmThreadsMerge threads,
    SwarmThreadEntry entry,
  ) {
    final reply = threads.newReplies(entry)?.lastOrNull;
    unawaited(
      Navigator.of(context).push(
        swarmChatRoute(
          swarmId: entry.swarmId,
          conversationId: entry.thread.conversationId,
          messageId: reply?.id ?? entry.thread.rootId,
          threadId: reply == null ? entry.thread.rootId : null,
        ),
      ),
    );
  }

  Future<void> _more(
    BuildContext context,
    SwarmThreadsMerge threads,
    SwarmThreadEntry entry,
  ) async {
    if (!threads.followOffered(entry)) return;
    final followed = entry.thread.follow != false;
    final key = entry.thread.key;
    bool listed() => [
      ...threads.fresh,
      ...threads.rest,
    ].any((e) => e.swarmId == entry.swarmId && e.thread.key == key);
    final picked = await showSwarmThreadFollowSheet(
      context,
      followed: followed,
      watch: threads,
      listed: listed,
    );
    if (picked != true || !mounted || !listed()) return;
    final kept = await threads.setFollow(entry, !followed);
    if (!kept && context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(followed ? 'Could not unfollow.' : 'Could not follow.'),
        ),
      );
    }
  }
}

/// One followed thread: where it is, its root, then its new replies while
/// new, else its reply count; a quiet ⋯ for Follow or Unfollow.
class SwarmThreadCard extends StatelessWidget {
  const SwarmThreadCard({
    super.key,
    required this.threads,
    required this.entry,
    required this.now,
    required this.onOpen,
    required this.onMore,
  });

  final SwarmThreadsMerge threads;
  final SwarmThreadEntry entry;
  final DateTime now;
  final VoidCallback onOpen, onMore;

  /// The words under the avatar start here: past it and the gap beside it.
  static const _indent = 32.0 + 12;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final thread = entry.thread;
    final fresh = threads.fresh.any(
      (e) => e.swarmId == entry.swarmId && e.thread.key == thread.key,
    );
    final replies = threads.newReplies(entry);
    final count = threads.newCount(entry);
    final chat = threads.chat(entry);
    final place = [
      '#${chat?.title ?? ''}',
      if (threads.manySwarms) entry.swarmName,
    ].where((part) => part.length > 1).join(' · ');
    final caption = AppType.caption(
      color: AppPalette.textSecondary,
      height: 1.35,
    );
    return Material(
      type: MaterialType.transparency,
      child: InkWell(
        onTap: onOpen,
        onLongPress: threads.followOffered(entry) ? onMore : null,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.l,
            AppSpace.s,
            AppSpace.xs,
            AppSpace.m,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      place,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: caption,
                    ),
                  ),
                  if (threads.followOffered(entry))
                    SwarmIconButton(
                      key: ValueKey('swarm-thread-more-${thread.key}'),
                      icon: LucideIcons.ellipsis300,
                      size: 18,
                      label: thread.follow == false
                          ? 'Follow thread'
                          : 'Unfollow thread',
                      onPressed: onMore,
                    )
                  else
                    const SizedBox(height: 44),
                ],
              ),
              Padding(
                padding: const EdgeInsets.only(right: AppSpace.m),
                child: _Said(
                  author: thread.rootAuthor,
                  text: thread.rootText,
                  at: thread.rootAt,
                  now: now,
                  strong: fresh,
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(left: _indent, top: AppSpace.xs),
                child: fresh
                    ? Text(
                        count == 1 ? '1 new reply' : '$count new replies',
                        key: ValueKey('swarm-thread-new-${thread.key}'),
                        style: AppType.caption(
                          color: AppPalette.accent,
                          fontWeight: AppFont.semibold,
                          height: 1.35,
                        ),
                      )
                    : Text(
                        [
                          if (thread.replies case final n?)
                            n == 1 ? '1 reply' : '$n replies',
                          if (thread.lastReplyAt case final at?)
                            'last ${fzfAge(at.toLocal(), now.toLocal())}',
                        ].join(' · '),
                        style: caption,
                      ),
              ),
              if (fresh && replies != null)
                for (final reply in replies)
                  Padding(
                    padding: const EdgeInsets.only(
                      left: _indent,
                      top: AppSpace.s,
                      right: AppSpace.m,
                    ),
                    child: _Said(
                      author: reply.author,
                      text: reply.text,
                      at: reply.createdAt,
                      now: now,
                      strong: true,
                      small: true,
                    ),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One message in a thread card: who, when, and what they said.
class _Said extends StatelessWidget {
  const _Said({
    required this.author,
    required this.text,
    required this.at,
    required this.now,
    required this.strong,
    this.small = false,
  });

  final Map<String, dynamic> author;
  final String text;
  final DateTime? at;
  final DateTime now;
  final bool strong, small;

  @override
  Widget build(BuildContext context) {
    final id = author['id'] as String? ?? '';
    final name =
        author['displayName'] as String? ?? author['name'] as String? ?? '';
    final age = at == null ? '' : fzfAge(at!.toLocal(), now.toLocal());
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwarmAvatar(id: id, name: name, size: small ? 24 : 32),
        SizedBox(width: small ? 8 : 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                [name, age].where((part) => part.isNotEmpty).join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.caption(
                  color: AppPalette.textSecondary,
                  height: 1.35,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                text,
                maxLines: small ? 4 : 3,
                overflow: TextOverflow.ellipsis,
                style: AppType.label(
                  color: strong
                      ? AppPalette.textPrimary
                      : AppPalette.textSecondary,
                  fontWeight: strong && !small ? AppFont.semibold : null,
                  height: 1.3,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Follow or Unfollow of a thread ([followed]), on a sheet. Answers true when
/// tapped, null when closed. Once the thread is no longer [listed] — its
/// Swarm or access gone — it shows nothing of it and closes.
Future<bool?> showSwarmThreadFollowSheet(
  BuildContext context, {
  required bool followed,
  required Listenable watch,
  required bool Function() listed,
}) => showModalBottomSheet<bool>(
  context: context,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (context) =>
      _FollowSheet(followed: followed, watch: watch, listed: listed),
);

class _FollowSheet extends StatefulWidget {
  const _FollowSheet({
    required this.followed,
    required this.watch,
    required this.listed,
  });

  final bool followed;
  final Listenable watch;
  final bool Function() listed;

  @override
  State<_FollowSheet> createState() => _FollowSheetState();
}

class _FollowSheetState extends State<_FollowSheet> {
  bool _closing = false;

  /// Closes the sheet once, after the frame it went blank in.
  void _close() {
    if (_closing) return;
    _closing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop();
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.watch,
    builder: (context, _) {
      if (_closing || !widget.listed()) {
        _close();
        return const SizedBox.shrink();
      }
      final followed = widget.followed;
      return SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.l,
            AppSpace.m,
            AppSpace.l,
            AppSpace.l,
          ),
          child: SwarmGroup(
            children: [
              Material(
                type: MaterialType.transparency,
                child: InkWell(
                  key: const ValueKey('swarm-thread-follow'),
                  onTap: () => Navigator.of(context).pop(true),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpace.l,
                      vertical: AppSpace.m,
                    ),
                    child: Row(
                      children: [
                        Icon(
                          followed
                              ? LucideIcons.bellOff300
                              : LucideIcons.bell300,
                          size: 18,
                          color: AppPalette.textPrimary,
                        ),
                        const SizedBox(width: AppSpace.m),
                        Text(
                          followed ? 'Unfollow thread' : 'Follow thread',
                          style: AppType.label(color: AppPalette.textPrimary),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
