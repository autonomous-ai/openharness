import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_activity.dart';
import 'swarm_activity_feed.dart';
import 'swarm_asks.dart' show SwarmAsks;
import 'swarm_home_rows.dart' show swarmNeedAsk;
import 'swarm_inbox.dart';
import 'swarm_need_rows.dart';
import 'swarm_project_page.dart' show swarmChatRoute;
import 'swarm_project_status.dart' show swarmReadsProject;
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Opens Activity over [context]'s page: [focus] — a row's key — open in
/// full under its filter; only Swarm [swarmId]'s rows when Home shows that
/// Swarm alone, and only its project [projectId]'s when a project's status
/// card opens it.
void openSwarmActivity(
  BuildContext context, {
  String? focus,
  String? swarmId,
  String? projectId,
}) => unawaited(
  Navigator.of(context).push(
    swarmActivityRoute(focus: focus, swarmId: swarmId, projectId: projectId),
  ),
);

/// The route [openSwarmActivity] pushes: a decision's notice or link pushes it
/// too, so the decision opens where it is answered, never in a chat.
Route<void> swarmActivityRoute({
  String? focus,
  String? swarmId,
  String? projectId,
}) => phoneRoute(
  (_) =>
      SwarmActivityPage(focus: focus, swarmId: swarmId, projectId: projectId),
  listensForItself: true,
);

/// Activity as a page of its own, with a way back: Home's "See all" and its
/// rows open it until the tab bar does.
class SwarmActivityPage extends StatelessWidget {
  const SwarmActivityPage({
    super.key,
    this.focus,
    this.swarmId,
    this.projectId,
  });

  final String? focus, swarmId, projectId;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SwarmActivityView(
        focus: focus,
        swarmId: swarmId,
        projectId: projectId,
        leading: SwarmBackButton(
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
    );
  }
}

/// Activity, in place of Needs you (Tony's prototype C3): its title in the
/// terminal's face, the filters — Needs you · @ · Replies · Reactions (Threads
/// from a server before Activity) — each with its count, then the open
/// filter's rows: where and who over what, and Approve (which asks first) or
/// Reply at the row's end. A need the person handled stays, dimmed, under the
/// others; a reply or reaction is bold while unread. The rows shown are read
/// on every device once Activity is left ([SwarmActivity.showing]). The
/// Activity tab's screen, and [SwarmActivityPage]'s.
///
/// Only while it is in sight ([OutOfSight]) does it read the project chats
/// ([SwarmActivity.watch]) and keep the Swarm's notices quiet.
class SwarmActivityView extends StatefulWidget {
  const SwarmActivityView({
    super.key,
    this.focus,
    this.swarmId,
    this.projectId,
    this.leading,
  });

  /// The row open first, by its key.
  final String? focus;

  /// Only this Swarm's rows; null for every Swarm's.
  final String? swarmId;

  /// Only the rows of this project of [swarmId], while the person still reads
  /// it; none once they do not, and its name with them.
  final String? projectId;

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

  /// The focused row, brought into view once it is drawn.
  final _focusKey = GlobalKey();
  bool _focusShown = false;

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
              // The project's name goes with the person's access to it.
              ListenableBuilder(
                listenable: Listenable.merge([
                  session?.inbox,
                  session?.activity,
                  if (widget.swarmId case final id?) session?.inbox.reader(id),
                ]),
                builder: (context, _) => SwarmTopBar(
                  leading: leading,
                  title: 'Activity',
                  subtitle: switch (session) {
                    final session? => switch (_project(session)) {
                      final project? => '#${project.name}',
                      null => null,
                    },
                    null => null,
                  },
                ),
              )
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

  /// [filter]'s rows, of [widget.swarmId] alone when it names one, and of
  /// [widget.projectId] alone when it names one.
  List<SwarmActivityItem> _items(
    SwarmSession session,
    SwarmActivityFilter filter,
  ) {
    final projectId = widget.projectId;
    final reader = projectId == null || widget.swarmId == null
        ? null
        : session.inbox.reader(widget.swarmId!);
    final snapshot = _project(session) == null ? null : reader?.snapshot;
    return [
      for (final item in session.activity.items(filter))
        if ((widget.swarmId == null || item.swarmId == widget.swarmId) &&
            (projectId == null ||
                snapshot != null &&
                    swarmActivityItemIn(item, snapshot, projectId)))
          item,
    ];
  }

  /// [widget.projectId] while the person reads it, as the status card holds
  /// to it ([swarmReadsProject]); null for none, or once they do not.
  SuperTabProject? _project(SwarmSession session) {
    final projectId = widget.projectId, swarmId = widget.swarmId;
    if (projectId == null || swarmId == null) return null;
    final reader = session.inbox.reader(swarmId);
    if (reader == null || reader.accessRevoked) return null;
    final project = reader.snapshot?.projectById(projectId);
    return project != null && swarmReadsProject(reader, project)
        ? project
        : null;
  }

  Widget _body(BuildContext context, SwarmSession session) {
    final activity = session.activity;
    final items = _items(session, _filter);
    // What is open here is what goes read once Activity is left.
    activity.showing(items);
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
                  label: activity.label(filter),
                  count: _items(session, filter).where(activity.waiting).length,
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
    final missing = _focusMissing(session, items);
    if (missing == null) _showFocus();
    return [
      if (missing case (:final asks?))
        _Note(
          key: const ValueKey('swarm-activity-focus-failed'),
          text: asks.error!,
          action: SwarmButton(
            key: const ValueKey('swarm-activity-focus-retry'),
            label: 'Try again',
            style: SwarmButtonStyle.link,
            onPressed: () => unawaited(asks.load()),
          ),
        )
      else if (missing != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            0,
            AppSpace.xs,
            AppSpace.s,
          ),
          child: Text(
            'This decision is no longer open.',
            key: const ValueKey('swarm-activity-focus-gone'),
            style: note,
          ),
        ),
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
            _nothing(_filter, replies: activity.repliesFromServer),
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

  /// A decision this page was opened at (a notice, a link) that is not among
  /// its rows once what waits on the person is read: answered, withdrawn, or
  /// never theirs — said alike, naming nothing of it. When that read failed,
  /// [asks] is the Swarm's, to say so and read again: its next read that
  /// gets through brings the decision. Null while it is shown, or not read
  /// yet.
  ({SwarmAsks? asks})? _focusMissing(
    SwarmSession session,
    List<SwarmActivityItem> items,
  ) {
    final focus = widget.focus;
    if (focus == null || !focus.startsWith('decision:')) return null;
    if (_filter != SwarmActivityFilter.needsYou) return null;
    if (items.any((item) => item.key == focus)) return null;
    final inbox = session.inbox;
    if (!inbox.loaded) return null;
    final swarmId = widget.swarmId;
    final asks = swarmId == null ? null : inbox.asks(swarmId);
    if (asks != null && asks.loading) return null;
    return (
      asks: asks?.error != null && !asks!.reader.accessRevoked ? asks : null,
    );
  }

  /// Brings the focused row into view once, after the frame that draws it.
  void _showFocus() {
    if (_focusShown || widget.focus == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _focusShown) return;
      final row = _focusKey.currentContext;
      if (row == null) return;
      _focusShown = true;
      unawaited(
        Scrollable.ensureVisible(
          row,
          alignment: 0.3,
          duration: const Duration(milliseconds: 250),
        ),
      );
    });
  }

  static String _nothing(SwarmActivityFilter filter, {required bool replies}) =>
      switch (filter) {
        SwarmActivityFilter.needsYou => 'Nothing needs you.',
        SwarmActivityFilter.mentions => 'No one tagged you.',
        SwarmActivityFilter.threads when replies =>
          'No replies to your messages yet.',
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
    final row = _rowOf(context, session, item, handled);
    return item.key == widget.focus
        ? KeyedSubtree(key: _focusKey, child: row)
        : row;
  }

  Widget _rowOf(
    BuildContext context,
    SwarmSession session,
    SwarmActivityItem item,
    String? handled,
  ) {
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
      unread: session.activity.unread(item),
      now: DateTime.now(),
      onTap: () => item is SwarmActivityNeed && handled == null
          ? setState(() => _open = item.key)
          : _reply(context, session, item),
      onApprove: () => unawaited(_approve(context, session, item)),
      onReply: () => _reply(context, session, item),
    );
  }

  /// Opens where [item] was asked, at its message — in its thread, opened
  /// over the chat, when it lives there — and counts it handled. A
  /// decision opens its chat at the end: decisions are answered here, never
  /// shown in a chat.
  void _reply(
    BuildContext context,
    SwarmSession session,
    SwarmActivityItem item,
  ) {
    final focus = session.activity.landingOf(item);
    session.activity.replied(item);
    unawaited(
      Navigator.of(context).push(
        swarmChatRoute(
          swarmId: item.swarmId,
          conversationId: item.conversationId,
          // A thread opens over the chat at its root, which the chat shows
          // behind it.
          messageId: item.threadId ?? item.messageId,
          threadId: item.threadId,
          threadFocus: focus,
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
    final need = item.need as SwarmDecisionNeed;
    final activity = session.activity;
    final yes = await confirmSwarmApprove(
      context,
      need,
      option,
      // Answered elsewhere, or access lost, while it asks: it closes.
      until: activity,
      stillOpen: () => activity.canApprove(item),
    );
    if (yes && mounted) activity.approve(item);
  }
}

/// Asks before [option] is sent as the answer to [need]: who asked, where,
/// and the question, and that it can still be undone. True once the person
/// confirms; the caller then holds the answer for Undo and sends it
/// ([SwarmSession.hold]). Activity's Approve asks this.
///
/// With [until], the question closes, as Cancel, once [stillOpen] says the
/// decision can no longer be answered — answered elsewhere, or the person's
/// access to it lost — so nothing of it stays on screen.
Future<bool> confirmSwarmApprove(
  BuildContext context,
  SwarmDecisionNeed need,
  String option, {
  Listenable? until,
  bool Function()? stillOpen,
}) async {
  final decision = need.decision;
  final where = decision.projectName.isEmpty
      ? ''
      : ' in #${decision.projectName}';
  final yes = await showDialog<bool>(
    context: context,
    // Over the page or sheet it asks from, on their navigator: what closes
    // them, as access is lost, finds it there. The shell's pages are on a
    // navigator of their own, under the app's.
    useRootNavigator: false,
    builder: (context) => _ClosesWhenGone(
      until: until,
      stillOpen: stillOpen,
      child: AlertDialog(
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
    ),
  );
  return yes ?? false;
}

/// [child] — a question asked over Activity — closed as Cancel once
/// [stillOpen] no longer holds, checked whenever [until] changes.
class _ClosesWhenGone extends StatefulWidget {
  const _ClosesWhenGone({
    required this.until,
    required this.stillOpen,
    required this.child,
  });

  final Listenable? until;
  final bool Function()? stillOpen;
  final Widget child;

  @override
  State<_ClosesWhenGone> createState() => _ClosesWhenGoneState();
}

class _ClosesWhenGoneState extends State<_ClosesWhenGone> {
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    widget.until?.addListener(_check);
  }

  @override
  void dispose() {
    widget.until?.removeListener(_check);
    super.dispose();
  }

  void _check() {
    if (_closing || (widget.stillOpen?.call() ?? true)) return;
    _closing = true;
    // Not while a listener's notice is being told: once this frame is done.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop(false);
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// A line over the rows, with what can be done about it.
class _Note extends StatelessWidget {
  const _Note({super.key, required this.text, required this.action});

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
    this.label,
  });

  final SwarmActivityFilter filter;

  /// What it is called, when not [SwarmActivityFilter.label].
  final String? label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = selected ? AppPalette.windowBg : AppPalette.textPrimary;
    final name = label ?? filter.label;
    final heard = filter == SwarmActivityFilter.mentions ? 'Mentions' : name;
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
                    name,
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
    bool? unread,
  }) : unread = unread ?? handled == null;

  final SwarmSession session;
  final SwarmActivityItem item;

  /// What was done with it; null while it is still to handle.
  final String? handled;

  /// Bold: still to handle, or a reply or reaction not read.
  final bool unread;
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
                  fontWeight: unread ? AppFont.semibold : AppFont.regular,
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
                // Under the words, past the 32-point avatar and the gap beside it.
                Row(
                  children: [
                    const SizedBox(width: 32 + 12),
                    Expanded(child: busy),
                  ],
                ),
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
    // The project as this Swarm's own read has the chat: never the server's
    // word for it.
    SwarmActivityServerItem(:final conversationId) =>
      session.inbox
              .reader(item.swarmId)
              ?.snapshot
              ?.projectFor(conversationId)
              ?.name ??
          '',
  };

  String _title() => switch (item) {
    SwarmActivityNeed(:final need) => swarmNeedAsk(need),
    SwarmActivityThread(:final root, :final project) => switch (root?.text) {
      final text? when text.trim().isNotEmpty => text.trim(),
      _ => 'A thread in #${project.name}',
    },
    SwarmActivityReaction(:final message) => message.text.trim(),
    SwarmActivityServerItem(:final entry) => swarmActivityDid(
      entry,
      swarmActivityWho(item, session.inbox.reader(item.swarmId)).name,
    ),
  };

  String? _line() => switch (item) {
    SwarmActivityServerItem(:final entry) => switch (entry.text.trim()) {
      '' => null,
      final text => text,
    },
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
/// reacted. A person is named by their username, never the email.
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
    final person = snapshot?.people.where((p) => p.id == id).firstOrNull;
    return person == null || person.email.isEmpty ? 'Someone' : person.username;
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
    // An agent the Swarm no longer lists keeps the server's name for it; a
    // person is named only as this Swarm lists them.
    SwarmActivityServerItem(:final entry) => (
      id: entry.actorId.isEmpty ? item.key : entry.actorId,
      name: named(
        entry.actorKind,
        entry.actorId,
        entry.actorName.isEmpty ? 'An agent' : entry.actorName,
      ),
    ),
  };
}

/// What [entry]'s [who] did, as Desktop's Activity says it.
String swarmActivityDid(SwarmActivityEntry entry, String who) =>
    switch (entry.kind) {
      SwarmActivityKind.reply => '$who replied to your message',
      SwarmActivityKind.reaction => switch (SuperTabReactionEmoji.of(
        entry.emoji,
      )?.glyph) {
        final glyph? => '$who reacted $glyph to your message',
        null => '$who reacted to your message',
      },
    };
