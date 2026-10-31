import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'activity.dart';
import 'decisions_view.dart';
import 'identity.dart';
import 'machine_status.dart' show superTabAgo;
import 'notifications.dart';
import 'profile_model.dart';
import 'section_heading.dart';

/// Slack's Activity, where Notifications was (Lead, 10-31): decisions asked
/// of the reader first, then one list, newest first, of their tags, the
/// replies to their messages and the reactions to them. Unread rows are bold;
/// a click opens the message where it is. Filters show one kind.
class SuperTabActivityView extends StatefulWidget {
  const SuperTabActivityView({
    super.key,
    required this.activity,
    required this.onOpenMention,
    required this.onOpenMessage,
    this.now = DateTime.now,
  });
  final SuperTabActivity activity;
  final ValueChanged<SuperTabMention> onOpenMention;

  /// Opens a reply or the reacted message: chat, message.
  final void Function(String conversationId, String messageId) onOpenMessage;
  final DateTime Function() now;

  @override
  State<SuperTabActivityView> createState() => _SuperTabActivityViewState();
}

/// One row of the merged list: a tag, or a reply or reaction.
typedef _Entry = ({
  DateTime at,
  SuperTabMention? mention,
  SuperTabActivityItem? item,
});

class _SuperTabActivityViewState extends State<SuperTabActivityView> {
  final _marking = <String>{};
  late SuperTabActivity _activity = widget.activity;

  @override
  void initState() {
    super.initState();
    _activity.opened();
  }

  @override
  void didUpdateWidget(SuperTabActivityView old) {
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

  Future<void> _done(SuperTabMention mention) async {
    setState(() => _marking.add(mention.id));
    await _activity.mentions.done(mention);
    if (mounted) setState(() => _marking.remove(mention.id));
  }

  List<_Entry> _entries() {
    final a = _activity;
    final filter = a.filter;
    final mentions =
        filter == SuperTabActivityFilter.all ||
        filter == SuperTabActivityFilter.mentions;
    bool kind(SuperTabActivityItem i) => switch (filter) {
      SuperTabActivityFilter.all => true,
      SuperTabActivityFilter.replies => i.kind == SuperTabActivityKind.reply,
      SuperTabActivityFilter.reactions =>
        i.kind == SuperTabActivityKind.reaction,
      _ => false,
    };
    final epoch = DateTime.fromMillisecondsSinceEpoch(0);
    return [
      if (mentions)
        for (final m in [...a.mentions.waiting, ...a.mentions.earlier])
          (at: m.createdAt ?? epoch, mention: m, item: null),
      for (final i in a.items)
        if (kind(i)) (at: i.createdAt ?? epoch, mention: null, item: i),
    ]..sort((x, y) => y.at.compareTo(x.at));
  }

  Widget _filters() {
    Widget tab(SuperTabActivityFilter value, String label) {
      final selected = _activity.filter == value;
      return Padding(
        padding: const EdgeInsets.only(right: grid.AppDesktop.menuInset),
        child: Material(
          color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            key: ValueKey('super-activity-filter-${value.name}'),
            onTap: () => _activity.setFilter(value),
            hoverColor: grid.AppSurface.hoverFill,
            child: Semantics(
              selected: selected,
              button: true,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: grid.AppDesktop.controlGap,
                  vertical: grid.AppDesktop.menuInset,
                ),
                child: Text(
                  label,
                  style: DesktopChrome.control(
                    medium: selected,
                    color: selected ? null : DesktopChrome.muted,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        grid.AppDesktop.groupGap,
        grid.AppDesktop.controlGap,
        grid.AppDesktop.groupGap,
        0,
      ),
      child: Wrap(
        children: [
          tab(SuperTabActivityFilter.all, 'All'),
          tab(SuperTabActivityFilter.decisions, 'Decisions'),
          tab(SuperTabActivityFilter.mentions, 'Mentions'),
          tab(SuperTabActivityFilter.replies, 'Replies'),
          tab(SuperTabActivityFilter.reactions, 'Reactions'),
        ],
      ),
    );
  }

  Widget _empty(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(
      grid.AppDesktop.groupGap,
      grid.AppDesktop.controlGap,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.controlGap,
    ),
    child: Text(text, style: DesktopChrome.metadata()),
  );

  Widget _face({String? personId, String? agentId, required String name}) {
    final snapshot = _activity.controller.snapshot;
    final person = personId == null
        ? null
        : snapshot?.people.where((p) => p.id == personId).firstOrNull;
    if (person != null) return SuperTabAvatar.person(person, size: 24);
    final agent = agentId == null ? null : snapshot?.agent(agentId);
    if (agent != null) {
      return SuperTabAvatar.agent(agent, name: name, size: 24);
    }
    return const SizedBox(width: 24);
  }

  Widget _row({
    required Key key,
    required Widget face,
    required String title,
    required String place,
    required String text,
    required DateTime? at,
    required bool unread,
    required VoidCallback onTap,
    Widget? trailing,
  }) => Padding(
    padding: const EdgeInsets.symmetric(
      horizontal: grid.AppDesktop.controlGap,
      vertical: grid.AppDesktop.listRowGap,
    ),
    child: Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: key,
        onTap: onTap,
        hoverColor: grid.AppSurface.hoverFill,
        focusColor: grid.AppSurface.hoverFill,
        child: Semantics(
          label: unread ? 'Unread' : null,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.groupGap,
              grid.AppDesktop.controlGap,
              grid.AppDesktop.controlGap,
              grid.AppDesktop.controlGap,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(
                    right: grid.AppDesktop.controlGap,
                    top: grid.AppDesktop.listRowGap,
                  ),
                  child: face,
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style:
                                  DesktopChrome.control(
                                    color: unread ? null : DesktopChrome.muted,
                                  ).copyWith(
                                    fontWeight: unread
                                        ? grid.AppFont.semibold
                                        : null,
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
                      Text(
                        place,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.metadata(),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        text,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.control(
                          color: unread ? null : DesktopChrome.muted,
                        ),
                      ),
                    ],
                  ),
                ),
                ?trailing,
              ],
            ),
          ),
        ),
      ),
    ),
  );

  Widget _mentionRow(SuperTabMention mention) {
    final c = _activity.controller;
    final hidden = c.snapshot?.conversation(mention.conversationId);
    // An old Chat with PM an older server still sends opens the project's
    // chat, and is named so; every other place by its title.
    final place = hidden == null || !c.hiddenByBuddies(hidden)
        ? mention.conversationTitle
        : '#${c.snapshot?.projects.where((p) => p.id == mention.projectId).firstOrNull?.name ?? mention.projectName}';
    final person = c.snapshot?.people
        .where((p) => p.id == mention.leadId)
        .firstOrNull;
    final author = person?.username ?? mention.leadName;
    final waiting = mention.resolvedBy == null;
    return _row(
      key: ValueKey('super-mention-${mention.id}'),
      face: _face(
        personId: mention.leadId,
        agentId: mention.leadId,
        name: mention.leadName,
      ),
      title: '$author tagged you',
      place: '${mention.projectName} · $place',
      text: mention.text,
      at: mention.createdAt,
      unread: _activity.mentionUnread(mention),
      onTap: () => widget.onOpenMention(mention),
      trailing: waiting
          ? Padding(
              padding: const EdgeInsets.only(left: grid.AppDesktop.controlGap),
              child: TextButton(
                onPressed: _marking.contains(mention.id)
                    ? null
                    : () => unawaited(_done(mention)),
                child: const Text('Mark done'),
              ),
            )
          : null,
    );
  }

  Widget _itemRow(SuperTabActivityItem item) {
    final name = item.actorName;
    final glyph = SuperTabReactionEmoji.of(item.emoji)?.glyph ?? '';
    return _row(
      key: ValueKey('super-activity-${item.id}'),
      face: _face(
        personId: item.byAgent ? null : item.actorId,
        agentId: item.byAgent ? item.actorId : null,
        name: name,
      ),
      title: item.kind == SuperTabActivityKind.reply
          ? '$name replied to your message'
          : '$name reacted $glyph to your message',
      place: '${item.projectName} · ${item.conversationTitle}',
      text: item.text,
      at: item.createdAt,
      unread: _activity.isUnread(item),
      onTap: () => widget.onOpenMessage(item.conversationId, item.messageId),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _activity,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final a = _activity;
      final filter = a.filter;
      final decisions =
          filter == SuperTabActivityFilter.all ||
          filter == SuperTabActivityFilter.decisions;
      final entries = filter == SuperTabActivityFilter.decisions
          ? const <_Entry>[]
          : _entries();
      final error = a.error ?? a.mentions.error;
      return ListView(
        key: const ValueKey('super-activity-list'),
        padding: const EdgeInsets.only(bottom: grid.AppDesktop.groupGap),
        children: [
          _filters(),
          if (error != null)
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
                    onPressed: () {
                      unawaited(a.load());
                      unawaited(a.mentions.load());
                    },
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          if (decisions) SuperTabDecisionList(decisions: a.decisions),
          if (filter != SuperTabActivityFilter.decisions) ...[
            if (filter == SuperTabActivityFilter.all)
              const Padding(
                padding: EdgeInsets.fromLTRB(
                  grid.AppDesktop.groupGap,
                  grid.AppDesktop.groupGap,
                  grid.AppDesktop.groupGap,
                  grid.AppDesktop.menuInset,
                ),
                child: SuperTabSectionHeading('Activity', endInset: 0),
              ),
            if (entries.isEmpty)
              _empty(switch (filter) {
                SuperTabActivityFilter.mentions => 'Nobody tagged you yet.',
                SuperTabActivityFilter.replies =>
                  a.supported
                      ? 'No replies to your messages yet.'
                      : 'Update the server to see replies here.',
                SuperTabActivityFilter.reactions =>
                  a.supported
                      ? 'No reactions to your messages yet.'
                      : 'Update the server to see reactions here.',
                _ => 'Nothing yet.',
              }),
            for (final e in entries)
              if (e.mention case final mention?)
                _mentionRow(mention)
              else
                _itemRow(e.item!),
            if (a.more) _empty('Older activity is not shown.'),
          ],
        ],
      );
    },
  );
}
