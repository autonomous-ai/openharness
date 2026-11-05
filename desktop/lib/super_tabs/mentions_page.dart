import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'activity.dart';
import 'activity_rows.dart' show threadSubject;
import 'model.dart';
import 'notifications.dart';
import 'page_rows.dart';
import 'private_project_lock.dart';

/// Mentions, the sidebar's second page (anh Dee, 11-05, task #2996): each
/// row is the message that tagged the reader, with their tag marked and
/// where it is; the unread ones first, by day, then the ones read. Opening
/// one opens its chat at that message.
class SuperTabMentionsPage extends StatefulWidget {
  const SuperTabMentionsPage({
    super.key,
    required this.activity,
    required this.onOpenMention,
    this.now = DateTime.now,
  });
  final SuperTabActivity activity;
  final ValueChanged<SuperTabMention> onOpenMention;
  final DateTime Function() now;

  @override
  State<SuperTabMentionsPage> createState() => _MentionsPageState();
}

class _MentionsPageState extends State<SuperTabMentionsPage> {
  late SuperTabActivity _activity = widget.activity;

  @override
  void initState() {
    super.initState();
    _activity.opened();
  }

  @override
  void didUpdateWidget(SuperTabMentionsPage old) {
    super.didUpdateWidget(old);
    if (old.activity != widget.activity) {
      _activity.closed();
      _activity = widget.activity..opened();
    }
  }

  @override
  void dispose() {
    _activity.closed();
    super.dispose();
  }

  SuperTabSnapshot? get _snapshot => _activity.controller.snapshot;

  /// Every tag the server listed, once, newest first; equal times keep the
  /// server's order.
  List<SuperTabMention> get _all {
    final epoch = DateTime.fromMillisecondsSinceEpoch(0);
    final seen = <String>{};
    final all = [
      for (final m in [
        ..._activity.mentions.waiting,
        ..._activity.mentions.earlier,
      ])
        if (seen.add(m.id)) m,
    ];
    final order = [for (var i = 0; i < all.length; i++) i]
      ..sort((a, b) {
        final byTime = (all[b].createdAt ?? epoch).compareTo(
          all[a].createdAt ?? epoch,
        );
        return byTime != 0 ? byTime : a.compareTo(b);
      });
    return [for (final i in order) all[i]];
  }

  /// The reader's own tag as it is written: `@` and their username, or the
  /// name they set.
  List<String> get _marks {
    final c = _activity.controller;
    final me = _snapshot?.people.where((p) => p.id == c.accountId).firstOrNull;
    if (me == null) return const [];
    return {'@${me.username}', '@${me.shownName}'}.toList();
  }

  /// `Mention in # project`, then the task or thread it is in.
  Widget _where(SuperTabMention m) {
    final snapshot = _snapshot;
    final project = snapshot?.projectFor(m.conversationId);
    final name = project?.name ?? m.projectName;
    String? inside;
    if (m.threadId case final root?) {
      final key = '${m.conversationId}/$root';
      final thread = _activity.attention.shown
          .where((t) => t.key == key)
          .firstOrNull;
      if (thread != null) inside = threadSubject(thread.rootText);
    }
    if (inside == null &&
        snapshot != null &&
        !snapshot.isProjectLead(m.conversationId)) {
      final title =
          snapshot.conversation(m.conversationId)?.title ?? m.conversationTitle;
      if (title.isNotEmpty) inside = title;
    }
    final style = DesktopChrome.metadata();
    final rest = inside == null ? name : '$name › $inside';
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: project?.isPrivate == true
          ? Text.rich(
              TextSpan(
                children: [
                  const TextSpan(text: 'Mention in '),
                  WidgetSpan(
                    alignment: PlaceholderAlignment.middle,
                    child: PrivateProjectLock(size: 12, color: style.color),
                  ),
                  TextSpan(text: ' $rest'),
                ],
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style,
            )
          : Text(
              'Mention in # $rest',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style,
            ),
    );
  }

  Widget _row(SuperTabMention m, {required bool unread}) {
    final name =
        _snapshot?.people
            .where((p) => p.id == m.leadId)
            .firstOrNull
            ?.shownName ??
        m.leadName;
    return SuperTabPageRow(
      key: ValueKey('super-activity-row-mention:${m.id}'),
      unread: unread,
      avatarName: name,
      who: name,
      trailing: m.createdAt == null
          ? ''
          : superTabPageWhen(context, m.createdAt!, widget.now()),
      preview: m.text.trim(),
      previewLines: 3,
      marks: _marks,
      extra: _where(m),
      actions: [
        if (unread)
          (label: 'Mark read', run: () => _activity.markMentionsRead([m])),
      ],
      onTap: () => widget.onOpenMention(m),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([_activity, _activity.attention]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final a = _activity;
      final all = _all;
      final unread = [
        for (final m in all)
          if (a.mentionUnread(m)) m,
      ];
      final read = [
        for (final m in all)
          if (!a.mentionUnread(m)) m,
      ];
      return LaidOutListView(
        key: const ValueKey('super-mentions-list'),
        padding: const EdgeInsets.only(bottom: grid.AppDesktop.groupGap),
        children: [
          if (a.mentions.error case final error?)
            superTabPageError(error, () => unawaited(a.mentions.load())),
          superTabPageBar([
            superTabMarkAllRead(
              unread.isEmpty ? null : () => a.markMentionsRead(unread),
            ),
          ]),
          if (all.isEmpty)
            superTabPageEmpty('No mentions yet')
          else ...[
            ...superTabByDay<SuperTabMention>(
              unread,
              (m) => m.createdAt,
              (m) => _row(m, unread: true),
              widget.now(),
            ),
            if (read.isNotEmpty) ...[
              superTabPageHeading('Read'),
              for (final m in read) _row(m, unread: false),
            ],
          ],
        ],
      );
    },
  );
}
