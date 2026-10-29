import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'identity.dart';
import 'swarm_activity.dart';
import 'swarm_conversation_page.dart';
import 'swarm_home_rows.dart' show swarmNeedAsk;
import 'swarm_inbox.dart';
import 'swarm_need_rows.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Opens Activity over [context]'s page: [focus] — a row's key — open in
/// full under its filter; only Swarm [swarmId]'s rows when Home shows that
/// Swarm alone.
void openSwarmActivity(
  BuildContext context, {
  String? focus,
  String? swarmId,
}) => unawaited(
  Navigator.of(context).push(
    phoneRoute(
      (_) => SwarmActivityPage(focus: focus, swarmId: swarmId),
      listensForItself: true,
    ),
  ),
);

/// Activity as a page of its own, with a way back: Home's "See all" and its
/// rows open it until the tab bar does.
class SwarmActivityPage extends StatelessWidget {
  const SwarmActivityPage({super.key, this.focus, this.swarmId});

  final String? focus, swarmId;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SwarmActivityView(
        focus: focus,
        swarmId: swarmId,
        leading: SwarmBackButton(
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
    );
  }
}

/// Activity, in place of Needs you (Tony's prototype C3): its title in the
/// terminal's face, the filters — Needs you · @ · Threads · Reactions — each
/// with its count, then the open filter's rows: where and who over what, and
/// Approve (which asks first) or Reply at the row's end. A row the person
/// handled stays, dimmed, under the others. The Activity tab's screen, and
/// [SwarmActivityPage]'s.
///
/// Only while it is in sight ([OutOfSight]) does it read the project chats
/// ([SwarmActivity.watch]) and keep the Swarm's notices quiet.
class SwarmActivityView extends StatefulWidget {
  const SwarmActivityView({super.key, this.focus, this.swarmId, this.leading});

  /// The row open first, by its key.
  final String? focus;

  /// Only this Swarm's rows; null for every Swarm's.
  final String? swarmId;

  /// Before the title: a page's back; none on the tab.
  final Widget? leading;

  @override
  State<SwarmActivityView> createState() => _SwarmActivityViewState();
}

class _SwarmActivityViewState extends State<SwarmActivityView> {
  SwarmSession? _session;
  bool _seen = false;
  late SwarmActivityFilter _filter = _filterOf(widget.focus);
  late String? _open = widget.focus;

  static SwarmActivityFilter _filterOf(String? key) => switch (key) {
    final key? when key.startsWith('mention:') => SwarmActivityFilter.mentions,
    final key? when key.startsWith('thread:') => SwarmActivityFilter.threads,
    final key? when key.startsWith('reaction:') =>
      SwarmActivityFilter.reactions,
    _ => SwarmActivityFilter.needsYou,
  };

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    final seen = session != null && !OutOfSight.of(context);
    if (identical(session, _session) && seen == _seen) return;
    _see(false);
    _session = session;
    _see(seen);
  }

  /// In sight: Activity reads its chats, the inbox is read now, and the
  /// Swarm's notices keep quiet. Out of sight, none of it.
  void _see(bool seen) {
    final session = _session;
    if (session == null || seen == _seen) return;
    _seen = seen;
    if (seen) {
      session.enter();
      session.activity.watch();
      unawaited(session.inbox.refresh());
    } else {
      session.activity.unwatch();
      session.leave();
    }
  }

  @override
  void dispose() {
    _see(false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = _session;
    return Material(
      color: AppPalette.windowBg,
      child: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.leading case final leading?)
              SwarmTopBar(leading: leading, title: 'Activity')
            else
              const SwarmTabHeader('Activity'),
            if (session != null)
              Expanded(
                child: ListenWhileInSight(
                  listenable: session.activity,
                  builder: (context) => _body(context, session),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// [filter]'s rows, of [widget.swarmId] alone when it names one.
  List<SwarmActivityItem> _items(
    SwarmActivity activity,
    SwarmActivityFilter filter,
  ) => [
    for (final item in activity.items(filter))
      if (widget.swarmId == null || item.swarmId == widget.swarmId) item,
  ];

  Widget _body(BuildContext context, SwarmSession session) {
    final activity = session.activity;
    final items = _items(activity, _filter);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(
            AppSpace.m,
            AppSpace.xs,
            AppSpace.m,
            AppSpace.s,
          ),
          child: Row(
            children: [
              for (final (i, filter) in SwarmActivityFilter.values.indexed) ...[
                if (i > 0) const SizedBox(width: AppSpace.s),
                SwarmActivityFilterPill(
                  key: ValueKey('swarm-activity-filter-${filter.name}'),
                  filter: filter,
                  count: _items(
                    activity,
                    filter,
                  ).where((item) => activity.handled(item) == null).length,
                  selected: filter == _filter,
                  onTap: () => setState(() => _filter = filter),
                ),
              ],
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(
              AppSpace.m,
              AppSpace.xs,
              AppSpace.m,
              MediaQuery.paddingOf(context).bottom + AppSpace.xl,
            ),
            children: _rows(context, session, items),
          ),
        ),
      ],
    );
  }

  List<Widget> _rows(
    BuildContext context,
    SwarmSession session,
    List<SwarmActivityItem> items,
  ) {
    final activity = session.activity, inbox = session.inbox;
    final fromChats =
        _filter == SwarmActivityFilter.threads ||
        _filter == SwarmActivityFilter.reactions;
    final note = AppType.caption(color: AppPalette.textSecondary, height: 1.35);
    return [
      if (fromChats && activity.unreadChats)
        _Note(
          text: 'Some chats could not be read.',
          action: SwarmButton(
            key: const ValueKey('swarm-activity-retry'),
            label: 'Try again',
            style: SwarmButtonStyle.link,
            onPressed: activity.retry,
          ),
        ),
      if (!inbox.loaded && inbox.error != null)
        _Note(
          text: inbox.error!,
          action: SwarmButton(
            key: const ValueKey('swarm-activity-retry-list'),
            label: 'Try again',
            style: SwarmButtonStyle.link,
            onPressed: () => unawaited(inbox.refresh()),
          ),
        )
      else if (items.isEmpty &&
          (!inbox.loaded || fromChats && activity.reading))
        SwarmSkeletonRows(id: 'swarm-activity-loading', round: true)
      else if (items.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.xs,
            vertical: AppSpace.s,
          ),
          child: Text(
            _nothing(_filter),
            key: const ValueKey('swarm-activity-none'),
            style: note,
          ),
        )
      else
        SwarmGroup(
          children: [for (final item in items) _row(context, session, item)],
        ),
    ];
  }

  static String _nothing(SwarmActivityFilter filter) => switch (filter) {
    SwarmActivityFilter.needsYou => 'Nothing needs you.',
    SwarmActivityFilter.mentions => 'No one tagged you.',
    SwarmActivityFilter.threads => 'No threads with you yet.',
    SwarmActivityFilter.reactions => 'No reactions to you yet.',
  };

  Widget _row(
    BuildContext context,
    SwarmSession session,
    SwarmActivityItem item,
  ) {
    final activity = session.activity;
    final handled = activity.handled(item);
    // A need tapped opens in full: every option, Done, Open chat.
    if (item case SwarmActivityNeed(:final need)
        when handled == null && item.key == _open) {
      return SwarmNeedRow(
        key: ValueKey('swarm-activity-open-${item.key}'),
        session: session,
        need: need,
        onOpen: (_, _) => _reply(context, session, item),
      );
    }
    return SwarmActivityRow(
      key: ValueKey('swarm-activity-row-${item.key}'),
      session: session,
      item: item,
      handled: handled,
      now: DateTime.now(),
      onTap: () => item is SwarmActivityNeed && handled == null
          ? setState(() => _open = item.key)
          : _reply(context, session, item),
      onApprove: () => unawaited(_approve(context, session, item)),
      onReply: () => _reply(context, session, item),
    );
  }

  /// Opens where [item] was asked, at its message, and counts it handled.
  void _reply(
    BuildContext context,
    SwarmSession session,
    SwarmActivityItem item,
  ) {
    session.activity.replied(item);
    unawaited(
      Navigator.of(context).push(
        phoneRoute(
          (_) => SwarmConversationPage(
            swarmId: item.swarmId,
            conversationId: item.conversationId,
            messageId: item.messageId,
            decisionId: switch (item) {
              SwarmActivityNeed(need: SwarmDecisionNeed(:final decision)) =>
                decision.id,
              _ => null,
            },
          ),
          listensForItself: true,
        ),
      ),
    );
  }

  /// Approve asks first, naming the option it sends and to whom; then the
  /// answer is held for Undo before it goes ([SwarmActivity.approve]).
  Future<void> _approve(
    BuildContext context,
    SwarmSession session,
    SwarmActivityItem item,
  ) async {
    final option = session.activity.approveOption(item);
    if (option == null ||
        item is! SwarmActivityNeed ||
        item.need is! SwarmDecisionNeed) {
      return;
    }
    final decision = (item.need as SwarmDecisionNeed).decision;
    final where = decision.projectName.isEmpty
        ? ''
        : ' in #${decision.projectName}';
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          'Approve?',
          style: AppType.heading(color: AppPalette.textPrimary),
        ),
        content: Text(
          'Sends “$option” to ${decision.askerName}$where: '
          '${decision.question}\n\nYou can undo it for a few seconds.',
          style: AppType.body(color: AppPalette.textSecondary),
        ),
        actions: [
          SwarmButton(
            key: const ValueKey('swarm-activity-approve-cancel'),
            label: 'Cancel',
            style: SwarmButtonStyle.link,
            onPressed: () => Navigator.of(context).pop(false),
          ),
          SwarmButton(
            key: const ValueKey('swarm-activity-approve-confirm'),
            label: 'Approve',
            style: SwarmButtonStyle.fill,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (yes == true && mounted) session.activity.approve(item);
  }
}

/// A line over the rows, with what can be done about it.
class _Note extends StatelessWidget {
  const _Note({required this.text, required this.action});

  final String text;
  final Widget action;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: AppSpace.xs, bottom: AppSpace.s),
    child: Row(
      children: [
        Expanded(
          child: Text(
            text,
            style: AppType.caption(
              color: AppPalette.textSecondary,
              height: 1.35,
            ),
          ),
        ),
        action,
      ],
    ),
  );
}

/// One of Activity's filters: its name and count in a pill a thumb can find,
/// filled while it is the one open.
class SwarmActivityFilterPill extends StatelessWidget {
  const SwarmActivityFilterPill({
    super.key,
    required this.filter,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final SwarmActivityFilter filter;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = selected ? AppPalette.windowBg : AppPalette.textPrimary;
    final heard = filter == SwarmActivityFilter.mentions
        ? 'Mentions'
        : filter.label;
    return Semantics(
      button: true,
      selected: selected,
      label: '$heard, $count',
      excludeSemantics: true,
      child: Material(
        color: selected
            ? AppPalette.textPrimary
            : AppPalette.swarmSearchSurface,
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.l),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    filter.label,
                    style: AppType.label(
                      color: ink,
                      fontWeight: AppFont.semibold,
                      height: 1,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '$count',
                    style: AppType.label(
                      color: selected
                          ? ink.withValues(alpha: .7)
                          : AppPalette.textSecondary,
                      height: 1,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One row of Activity, as prototype C3 draws it: who it is from, "#project ·
/// who · when" over what it is in bold, maybe a line under that (a thread's
/// replies, the reactions), and at its end Approve or Reply. A decision
/// whose answer is held or on its way shows that, with Undo, in place of
/// the button; a handled row is dimmed, with what was done at its end.
class SwarmActivityRow extends StatelessWidget {
  const SwarmActivityRow({
    super.key,
    required this.session,
    required this.item,
    required this.handled,
    required this.now,
    required this.onTap,
    required this.onApprove,
    required this.onReply,
  });

  final SwarmSession session;
  final SwarmActivityItem item;

  /// What was done with it; null while it is still to handle.
  final String? handled;
  final DateTime now;
  final VoidCallback onTap, onApprove, onReply;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final reader = session.inbox.reader(item.swarmId);
    final who = swarmActivityWho(item, reader);
    final busy = _busy();
    final line = _line();
    final content = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwarmAvatar(id: who.id, name: who.name),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                [
                  '#${_project()}',
                  who.name,
                  fzfAge(item.at?.toLocal(), now.toLocal()),
                ].where((part) => part.length > 1).join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.caption(
                  color: AppPalette.textSecondary,
                  height: 1.35,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                _title(),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: AppType.label(
                  color: AppPalette.textPrimary,
                  fontWeight: handled == null
                      ? AppFont.semibold
                      : AppFont.regular,
                  height: 1.3,
                ),
              ),
              if (line != null) ...[
                const SizedBox(height: 2),
                SwarmRow.line(line),
              ],
            ],
          ),
        ),
      ],
    );
    final Widget? end = switch (handled) {
      final word? => Row(
        key: ValueKey('swarm-activity-handled-${item.key}'),
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(LucideIcons.check300, size: 16, color: AppPalette.textFaint),
          const SizedBox(width: 4),
          Text(word, style: AppType.caption(color: AppPalette.textFaint)),
        ],
      ),
      null when busy != null => null,
      null when session.activity.canApprove(item) => SwarmButton(
        key: ValueKey('swarm-activity-approve-${item.key}'),
        label: 'Approve',
        style: SwarmButtonStyle.fill,
        onPressed: onApprove,
      ),
      null => SwarmButton(
        key: ValueKey('swarm-activity-reply-${item.key}'),
        label: 'Reply',
        onPressed: onReply,
      ),
    };
    return Material(
      type: MaterialType.transparency,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.l,
            vertical: AppSpace.m,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: handled == null
                        ? content
                        : Opacity(opacity: .55, child: content),
                  ),
                  if (end != null) ...[const SizedBox(width: 12), end],
                ],
              ),
              if (busy != null) ...[
                const SizedBox(height: AppSpace.m),
                Padding(padding: const EdgeInsets.only(left: 44), child: busy),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// A decision whose answer is held, on its way, not confirmed or dropped:
  /// what its full card says of it, with Undo while it is held.
  Widget? _busy() {
    if (item case SwarmActivityNeed(need: final SwarmDecisionNeed need)
        when handled == null) {
      final asks = session.inbox.asks(need.swarmId);
      if (session.held(need) != null ||
          (asks?.answering.contains(need.decision.id) ?? false) ||
          asks?.unconfirmed(need.decision) != null ||
          session.dropped(need)) {
        return SwarmDecisionAnswer(session: session, need: need);
      }
    }
    return null;
  }

  String _project() => switch (item) {
    SwarmActivityNeed(:final need) => switch (need) {
      SwarmDecisionNeed(:final decision) => decision.projectName,
      SwarmMentionNeed(:final mention) => mention.projectName,
      SwarmWorkNeed(:final work) => work.project.name,
    },
    SwarmActivityThread(:final project) => project.name,
    SwarmActivityReaction(:final project) => project.name,
  };

  String _title() => switch (item) {
    SwarmActivityNeed(:final need) => swarmNeedAsk(need),
    SwarmActivityThread(:final root, :final project) => switch (root?.text) {
      final text? when text.trim().isNotEmpty => text.trim(),
      _ => 'A thread in #${project.name}',
    },
    SwarmActivityReaction(:final message) => message.text.trim(),
  };

  String? _line() => switch (item) {
    SwarmActivityThread(:final thread) =>
      thread.replies == 1 ? '1 reply' : '${thread.replies} replies',
    SwarmActivityReaction(:final reactions) => [
      for (final r in reactions) '${r.emoji.glyph} ${r.count}',
    ].join('  '),
    _ => null,
  };
}

/// Who an Activity row is from, by an id its avatar is coloured by and a
/// name, read in the row's own Swarm ([reader]) and never another's: the
/// asker, the tagging Lead, the worker, a thread's last writer, or who
/// reacted. A person is named by their email's name, never the email.
({String id, String name}) swarmActivityWho(
  SwarmActivityItem item,
  SwarmReader? reader,
) {
  final snapshot = reader?.snapshot;
  String named(String kind, String id, String fallback) {
    if (kind == 'person' && id == reader?.accountId) return 'You';
    if (kind == 'agent') {
      return snapshot?.agentName(id, fallback: fallback) ?? fallback;
    }
    final email = snapshot?.people.where((p) => p.id == id).firstOrNull?.email;
    return email == null || email.isEmpty
        ? 'Someone'
        : superTabPersonName(email);
  }

  return switch (item) {
    SwarmActivityNeed(:final need) => switch (need) {
      SwarmDecisionNeed(:final decision) => (
        id: 'asker:${decision.askerName}',
        name: decision.askerName,
      ),
      SwarmMentionNeed(:final mention) => (
        id: 'lead:${mention.leadName}',
        name: mention.leadName,
      ),
      SwarmWorkNeed(:final work) => (
        id: work.conversation.assignment?['agentId'] as String? ?? 'work',
        name: work.agentName,
      ),
    },
    SwarmActivityThread(:final thread) => switch (thread.authors.firstOrNull) {
      {'kind': final String kind, 'id': final String id} && final author => (
        id: id,
        name: named(
          kind,
          id,
          author['displayName'] as String? ??
              author['name'] as String? ??
              'Someone',
        ),
      ),
      _ => (id: thread.id, name: 'Someone'),
    },
    SwarmActivityReaction(:final reactions) => () {
      final by = [
        for (final r in reactions)
          for (final who in r.by) who,
      ];
      final names = {for (final who in by) named(who.kind, who.id, 'Someone')}
          .toList();
      return (
        id: by.isEmpty ? item.key : by.first.id,
        name: names.length <= 2
            ? names.join(', ')
            : '${names.take(2).join(', ')} +${names.length - 2}',
      );
    }(),
  };
}
