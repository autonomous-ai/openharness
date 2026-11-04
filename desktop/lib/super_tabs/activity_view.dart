import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show CustomSemanticsAction;

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'activity.dart';
import 'activity_rows.dart';
import 'attention.dart';
import 'avatar_art.dart';
import 'buddy_rows.dart' show SuperTabCountBadge;
import 'decisions.dart';
import 'decisions_view.dart' show quietDecisionAction;
import 'machine_status.dart' show superTabAgoShort;
import 'model.dart';
import 'notifications.dart';
import 'private_project_lock.dart';
import 'reminders.dart';

enum _Tab { needs, mentions, threads }

/// Activity, the one place for everything new for the reader, one list at a
/// time (Slack's way): Needs you, Mentions and Threads. Only Needs you has a
/// red number. A row says who said what; a click opens the thing where it is.
class SuperTabActivityView extends StatefulWidget {
  const SuperTabActivityView({
    super.key,
    required this.activity,
    required this.onOpenMention,
    required this.onOpenThread,
    required this.onOpenConversation,
    this.onOpenReminder,
    this.now = DateTime.now,
  });
  final SuperTabActivity activity;
  final ValueChanged<SuperTabMention> onOpenMention;

  /// Opens a followed thread in its chat: chat, the thread's root message.
  final void Function(String conversationId, String rootId) onOpenThread;

  /// Opens the chat of an agent waiting on the reader, or of a decision.
  final ValueChanged<String> onOpenConversation;

  /// Opens a due reminder's message, which clears it.
  final ValueChanged<SuperTabReminder>? onOpenReminder;
  final DateTime Function() now;

  @override
  State<SuperTabActivityView> createState() => _SuperTabActivityViewState();
}

class _SuperTabActivityViewState extends State<SuperTabActivityView> {
  late SuperTabActivity _activity = widget.activity;
  _Tab _tab = _Tab.needs;

  /// The opening tab is chosen once: when the decisions are read (or failed
  /// to be), or as soon as the reader does anything here. Until then more
  /// arriving may still change it; after, it never moves under their hands.
  bool _settled = false;
  bool _mentionsUnreadOnly = false;
  bool _handledShown = false;

  @override
  void initState() {
    super.initState();
    _activity.opened();
    _tab = _opening();
    _settled = _readEnough(_activity);
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

  /// Needs you when something needs the reader, else the first tab with
  /// unread rows, else Needs you.
  _Tab _opening() {
    if (_activity.needsYou.isNotEmpty) return _Tab.needs;
    if (_activity.mentionRows.any((r) => r.unread)) return _Tab.mentions;
    if (_activity.threadRows.isNotEmpty) return _Tab.threads;
    return _Tab.needs;
  }

  /// The reader acted: the tab they are on stays, whatever arrives.
  void _settle() => _settled = true;

  /// Whether the opening tab can be chosen for good: the decisions and the
  /// tags have each answered or failed. Settling on the decisions alone left
  /// the view on an empty Needs you while unread tags were still on their way.
  static bool _readEnough(SuperTabActivity a) =>
      (a.decisions.loaded || a.decisions.error != null) &&
      (a.mentions.loaded || a.mentions.error != null);

  void _choose(_Tab tab) => setState(() {
    _tab = tab;
    _settle();
  });

  /// Today's clock time, else how long ago: a row's one word of when.
  String _when(DateTime at) {
    final now = widget.now(), local = at.toLocal();
    if (local.year == now.year &&
        local.month == now.month &&
        local.day == now.day) {
      return MaterialLocalizations.of(context)
          .formatTimeOfDay(TimeOfDay.fromDateTime(local));
    }
    return superTabAgoShort(now.difference(local));
  }

  SuperTabSnapshot? get _snapshot => _activity.controller.snapshot;

  bool _isPrivate(String projectId) =>
      _snapshot?.projects
          .where((p) => p.id == projectId)
          .firstOrNull
          ?.isPrivate ==
      true;

  String _oneLine(String text) => text.replaceAll(RegExp(r'\s+'), ' ').trim();

  Future<void> _confirmDecideAll(
    List<SuperTabDecision> deciding,
    String name,
  ) async {
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Let $name decide all ${deciding.length}?'),
        content: Text(
          '${deciding.length} ${deciding.length == 1 ? 'decision' : 'decisions'}: '
          '$name takes each one\'s recommended option.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const ValueKey('super-activity-decide-all-confirm'),
            onPressed: () => Navigator.pop(context, true),
            child: Text('Let $name decide'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      _settle();
      unawaited(_activity.decisions.delegateAll(deciding));
    }
  }

  // ---- Chrome: tabs and bars ----

  Widget _tabButton(_Tab tab, String key, String label, int count) {
    final selected = _tab == tab;
    final color = selected ? DesktopChrome.foreground : DesktopChrome.muted;
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        key: ValueKey(key),
        onTap: () => _choose(tab),
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        child: Container(
          padding: const EdgeInsets.only(bottom: grid.AppDesktop.controlGap),
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                width: 2,
                color: selected ? DesktopChrome.foreground : Colors.transparent,
              ),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: DesktopChrome.control(color: color)
                    .copyWith(fontWeight: grid.AppFont.semibold),
              ),
              if (count > 0) ...[
                const SizedBox(width: grid.AppDesktop.controlGap - 2),
                if (tab == _Tab.needs)
                  SuperTabCountBadge(count)
                else
                  Text(
                    '$count',
                    style: DesktopChrome.metadata(color: DesktopChrome.muted)
                        .copyWith(fontWeight: grid.AppFont.semibold),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _tabs({
    required int needs,
    required int mentions,
    required int threads,
  }) => Container(
    padding: const EdgeInsets.fromLTRB(
      grid.AppDesktop.groupGap,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.groupGap,
      0,
    ),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
    ),
    child: Wrap(
      spacing: grid.AppDesktop.groupGap + grid.AppDesktop.controlGap,
      children: [
        _tabButton(_Tab.needs, 'super-activity-tab-needs', 'Needs you', needs),
        _tabButton(
          _Tab.mentions,
          'super-activity-tab-mentions',
          'Mentions',
          mentions,
        ),
        _tabButton(
          _Tab.threads,
          'super-activity-tab-threads',
          'Threads',
          threads,
        ),
      ],
    ),
  );

  Widget _bar(List<Widget> children) => Container(
    padding: const EdgeInsets.symmetric(
      horizontal: grid.AppDesktop.groupGap,
      vertical: grid.AppDesktop.controlGap,
    ),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
    ),
    child: Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      runSpacing: grid.AppDesktop.controlGap,
      spacing: grid.AppDesktop.groupGap,
      children: children,
    ),
  );

  Widget _unreadsOnly() => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('Unreads only', style: DesktopChrome.metadata()),
      const SizedBox(width: grid.AppDesktop.controlGap),
      Transform.scale(
        scale: .8,
        child: Switch(
          key: const ValueKey('super-activity-unreads-only'),
          value: _mentionsUnreadOnly,
          onChanged: (on) => setState(() {
            _settle();
            _mentionsUnreadOnly = on;
          }),
        ),
      ),
    ],
  );

  Widget _markAll(VoidCallback? onPressed) => quietDecisionAction(
    key: const ValueKey('super-activity-mark-all-read'),
    label: 'Mark all read',
    onPressed: onPressed,
  );

  Widget _heading(String title) => Padding(
    padding: const EdgeInsets.fromLTRB(
      grid.AppDesktop.groupGap + grid.AppDesktop.controlGap,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.listRowGap,
    ),
    child: Text(
      title,
      style: DesktopChrome.metadata(color: grid.AppPalette.textFaint)
          .copyWith(fontWeight: grid.AppFont.semibold),
    ),
  );

  Widget _empty(String title, [String? more, Widget? action]) => Padding(
    padding: const EdgeInsets.all(grid.AppDesktop.groupGap * 2),
    child: Column(
      children: [
        Text(
          title,
          style: DesktopChrome.text(medium: true)
              .copyWith(fontWeight: grid.AppFont.semibold),
        ),
        if (more != null) ...[
          const SizedBox(height: grid.AppDesktop.listRowGap * 2),
          Text(
            more,
            textAlign: TextAlign.center,
            style: DesktopChrome.control(color: DesktopChrome.muted),
          ),
        ],
        ?action,
      ],
    ),
  );

  /// Day headings between runs of rows already in newest-first order.
  List<Widget> _byDay<T>(
    List<T> items,
    DateTime? Function(T) at,
    Widget Function(T) row,
  ) {
    final now = widget.now();
    final out = <Widget>[];
    SuperTabDay? last;
    for (final item in items) {
      final when = at(item);
      // A row with no date belongs to the day it follows.
      final day = when == null
          ? (last ?? SuperTabDay.today)
          : dayOf(when.toLocal(), now);
      if (day != last) {
        last = day;
        out.add(
          _heading(switch (day) {
            SuperTabDay.today => 'Today',
            SuperTabDay.yesterday => 'Yesterday',
            SuperTabDay.earlier => 'Earlier',
          }),
        );
      }
      out.add(row(item));
    }
    return out;
  }

  // ---- Needs you ----

  List<Widget> _needsYou() {
    final a = _activity;
    // Until the decisions are read the list is not known: neither "nothing"
    // nor a count. A failed read says so above, with Retry.
    if (!a.decisions.loaded) {
      return a.decisions.error != null
          ? const []
          : [
              SkeletonList(
                key: const ValueKey('super-activity-skeleton'),
                rows: 3,
                padding: const EdgeInsets.symmetric(
                  horizontal: grid.AppDesktop.controlGap,
                ),
                itemBuilder: (context, _) => const SkeletonListTile(
                  leading: 32,
                  leadingRadius: 8,
                  padding: EdgeInsets.all(grid.AppDesktop.controlGap),
                ),
              ),
            ];
    }
    final needs = a.needsYou;
    final due = a.reminders.due;
    final decided = [
      for (final n in needs)
        if (n.decision != null) n,
    ];
    // Only these can be left to the PM, and only these the bar speaks of.
    final delegatable = [
      for (final n in decided)
        if (n.decision!.canDelegate) n.decision!,
    ];
    final bar = delegatable.isEmpty
        ? null
        : () {
            final name = a.coordinatorFor(delegatable);
            final busy = delegatable.any(
              (d) => a.decisions.answering.contains(d.id),
            );
            return _bar([
              Text(
                name == 'the PMs'
                    ? '$name take over anything you leave for 24 hours'
                    : '$name takes over anything you leave for 24 hours',
                style: DesktopChrome.metadata(),
              ),
              FilledButton(
                key: const ValueKey('super-activity-decide-all'),
                onPressed: busy
                    ? null
                    : () => unawaited(_confirmDecideAll(delegatable, name)),
                child: Text('Let $name decide for all'),
              ),
            ]);
          }();
    if (needs.isEmpty && due.isEmpty) {
      final handled = a.handledToday;
      final name = a.coordinatorFor(handled);
      return [
        _empty(
          'Nothing needs you',
          handled.isEmpty
              ? null
              : '$name handled ${handled.length} for you today',
          handled.isEmpty
              ? null
              : quietDecisionAction(
                  key: const ValueKey('super-activity-handled'),
                  label: 'See what',
                  onPressed: () =>
                      setState(() => _handledShown = !_handledShown),
                ),
        ),
        if (_handledShown && handled.isNotEmpty)
          for (final d in handled) _handledRow(d),
      ];
    }
    return [
      ?bar,
      // A reminder the reader set is theirs to answer: it leads, above the
      // decisions, and is not left to the PM.
      for (final reminder in due) _reminder(reminder),
      // An agent waiting has no time of its own: it leads, above the days.
      for (final n in needs)
        if (n.decision == null) _need(n),
      ..._byDay<SuperTabNeed>(decided, (n) => n.at, _need),
    ];
  }

  Widget _handledRow(SuperTabDecision d) {
    final choice = d.choice;
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.groupGap * 2,
        vertical: grid.AppDesktop.listRowGap,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              d.question,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(),
            ),
          ),
          const SizedBox(width: grid.AppDesktop.groupGap),
          if (choice != null && choice >= 0 && choice < d.options.length)
            Text(d.options[choice], style: DesktopChrome.metadata()),
        ],
      ),
    );
  }

  Widget _need(SuperTabNeed need) {
    final decision = need.decision;
    if (decision == null) {
      final project = _snapshot?.projectFor(need.conversationId);
      return _ActivityRow(
        key: ValueKey('super-activity-row-${need.id}'),
        unread: true,
        avatarName: need.title,
        who: need.title,
        where: project?.name,
        privateWhere: project?.isPrivate == true,
        trailing: 'Open',
        preview: _oneLine(need.question ?? ''),
        onTap: () => widget.onOpenConversation(need.conversationId),
      );
    }
    final now = widget.now(), created = decision.createdAt;
    // The sweep takes only what it can answer, and only within its window.
    final pmComing =
        decision.pmTakesOver &&
        created != null &&
        now.difference(created) < const Duration(days: 8);
    return _ActivityRow(
      key: ValueKey('super-activity-row-${need.id}'),
      unread: true,
      avatarName: decision.askerName,
      who: decision.askerName,
      where: decision.projectName,
      privateWhere: _isPrivate(decision.projectId),
      trailing: pmComing
          ? pmIn(created, now)
          : created == null
          ? ''
          : _when(created),
      trailingWarn: pmComing && pmSoon(created, now),
      preview: decision.question,
      previewStrong: true,
      previewLines: 2,
      extra: _options(decision),
      onTap: () => widget.onOpenConversation(decision.conversationId),
    );
  }

  Widget _reminder(SuperTabReminder reminder) {
    final project = _snapshot?.projectFor(reminder.conversationId);
    final name = reminder.authorName?.trim() ?? '';
    final who = name.isEmpty ? 'Reminder' : name;
    final text = _oneLine(reminder.text);
    return _ActivityRow(
      key: ValueKey('super-activity-row-reminder:${reminder.id}'),
      unread: true,
      avatarName: who,
      who: who,
      where: project?.name,
      privateWhere: project?.isPrivate == true,
      trailing: _when(reminder.dueAt),
      preview: text.isEmpty ? reminder.conversationTitle : text,
      onTap: () => widget.onOpenReminder?.call(reminder),
    );
  }

  Widget _options(SuperTabDecision decision) {
    final decisions = _activity.decisions;
    final busy = decisions.answering.contains(decision.id);
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
      child: Wrap(
        spacing: grid.AppDesktop.controlGap,
        runSpacing: grid.AppDesktop.controlGap,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (final (index, option) in decision.options.indexed)
            _option(decision, index, option, busy),
          if (decisions.failedToSend(decision))
            Text(SuperTabDecisions.sendFailed, style: DesktopChrome.metadata()),
          if (decisions.failedToSend(decision))
            quietDecisionAction(
              key: ValueKey('super-activity-retry:${decision.id}'),
              label: 'Retry',
              onPressed: busy
                  ? null
                  : () => unawaited(decisions.retry(decision)),
            ),
        ],
      ),
    );
  }

  Widget _option(
    SuperTabDecision decision,
    int index,
    String option,
    bool busy,
  ) {
    final recommended = index == decision.recommended;
    final onPressed = busy
        ? null
        : () {
            _settle();
            unawaited(_activity.decisions.answer(decision, index));
          };
    final label = Text(
      recommended ? '$option · Recommended' : option,
      overflow: TextOverflow.ellipsis,
    );
    final key = ValueKey('super-activity-option:${decision.id}:$index');
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 320),
      child: recommended
          ? FilledButton.tonal(key: key, onPressed: onPressed, child: label)
          : OutlinedButton(key: key, onPressed: onPressed, child: label),
    );
  }

  // ---- Mentions ----

  List<Widget> _mentions() {
    final a = _activity;
    final all = a.mentionRows;
    final rows = _mentionsUnreadOnly
        ? [
            for (final r in all)
              if (r.unread) r,
          ]
        : all;
    // Every one still waiting, read past or not: Mark read answers them all.
    final waiting = [
      for (final r in rows)
        for (final m in r.all)
          if (m.resolvedBy == null) m,
    ];
    final people = {
      for (final p in _snapshot?.people ?? const <SuperTabPerson>[]) p.id: p,
    };
    String author(SuperTabMention m) =>
        people[m.leadId]?.shownName ?? m.leadName;
    void markRead(List<SuperTabMention> mentions) {
      _settle();
      unawaited(a.mentions.doneAll(mentions));
    }

    return [
      _bar([
        _unreadsOnly(),
        _markAll(waiting.isEmpty ? null : () => markRead(waiting)),
      ]),
      if (rows.isEmpty)
        _empty(_mentionsUnreadOnly ? 'No unread mentions' : 'No mentions')
      else
        ..._byDay<SuperTabMentionRow>(rows, (r) => r.newest.createdAt, (row) {
          final m = row.newest;
          final name = author(m);
          return _ActivityRow(
            key: ValueKey('super-activity-row-mention:${m.id}'),
            unread: row.unread,
            avatarName: name,
            who: name,
            where: m.projectName,
            privateWhere: _isPrivate(m.projectId),
            trailing: m.createdAt == null ? '' : _when(m.createdAt!),
            preview: _oneLine(m.text),
            more: row.more > 0 ? '+${row.more} more from $name' : null,
            actions: row.unresolved
                ? [(label: 'Mark read', run: () => markRead(row.all))]
                : const [],
            onTap: () => widget.onOpenMention(m),
          );
        }),
    ];
  }

  // ---- Threads ----

  /// Every thread listed is unread (Activity lists today's new replies), so
  /// there is no Unreads only here.
  List<Widget> _threads() {
    final a = _activity;
    final rows = a.threadRows;
    return [
      _bar([
        _markAll(
          rows.isEmpty
              ? null
              : () {
                  _settle();
                  a.attention.markAllRead(rows);
                },
        ),
      ]),
      if (rows.isEmpty)
        _empty('No threads with new replies')
      else
        ..._byDay<SuperTabFollowedThread>(rows, (t) => t.lastReplyAt, (t) {
          // The data holds the root and the newest reply's author, not the
          // reply's text: the preview is the root, said by the root's author.
          final author = t.rootAuthor['name'] as String? ?? '';
          final replier = t.lastReplier?['name'] as String? ?? '';
          final project = _snapshot?.projectFor(t.conversationId);
          final subject = threadSubject(t.rootText);
          final root = _oneLine(t.rootText);
          return _ActivityRow(
            key: ValueKey('super-activity-row-thread:${t.key}'),
            unread: a.attention.isNew(t),
            avatarName: author.isEmpty ? subject : author,
            who: subject.isEmpty ? 'Thread' : subject,
            where: project?.name,
            privateWhere: project?.isPrivate == true,
            forThread: true,
            repliedBy: replier.isEmpty ? null : replier,
            trailing: '${a.attention.newCount(t)} new',
            preview: author.isEmpty ? root : '$author: $root',
            previewLead: author.isEmpty ? null : author.length + 1,
            actions: [
              (
                label: 'Mark read',
                run: () {
                  _settle();
                  a.attention.markRead(t);
                },
              ),
              (
                label: 'Unfollow',
                run: () {
                  _settle();
                  unawaited(a.attention.setFollow(t, false));
                },
              ),
            ],
            onTap: () => widget.onOpenThread(t.conversationId, t.rootId),
          );
        }),
    ];
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    // The threads are read only while this view shows them.
    listenable: Listenable.merge([_activity, _activity.attention]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final a = _activity;
      if (!_settled) {
        _tab = _opening();
        _settled = _readEnough(a);
      }
      final error =
          a.mentions.error ??
          a.decisions.error ??
          a.reminders.error ??
          a.attention.error;
      final body = switch (_tab) {
        _Tab.needs => _needsYou(),
        _Tab.mentions => _mentions(),
        _Tab.threads => _threads(),
      };
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _tabs(
            needs: a.count,
            mentions: a.mentionRows.where((r) => r.unread).length,
            threads: a.threadRows.length,
          ),
          Expanded(
            child: LaidOutListView(
              key: const ValueKey('super-activity-list'),
              padding: const EdgeInsets.only(bottom: grid.AppDesktop.groupGap),
              children: [
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
                        Expanded(
                          child: Text(error, style: DesktopChrome.control()),
                        ),
                        TextButton(
                          onPressed: () {
                            unawaited(a.mentions.load());
                            unawaited(a.decisions.load());
                            unawaited(a.attention.load());
                            unawaited(a.reminders.load());
                          },
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  ),
                ...body,
              ],
            ),
          ),
        ],
      );
    },
  );
}

/// One row, Slack's way: an unread dot, an avatar, who and where and when,
/// then a preview and whatever hangs under it. Hover actions float at the
/// right, over the time.
class _ActivityRow extends StatefulWidget {
  const _ActivityRow({
    super.key,
    required this.unread,
    required this.avatarName,
    required this.who,
    this.where,
    this.privateWhere = false,
    this.forThread = false,
    this.repliedBy,
    required this.trailing,
    this.trailingWarn = false,
    this.preview,
    this.previewStrong = false,
    this.previewLines = 1,
    this.previewLead,
    this.more,
    this.extra,
    this.actions = const [],
    required this.onTap,
  });
  final bool unread;
  final String avatarName, who, trailing;
  final String? where;

  /// The project is private: its lock stands for the #.
  final bool privateWhere;

  /// A thread's meta reads `{repliedBy} replied · # project` (or the project
  /// alone with no replier) in place of `in # project`.
  final bool forThread;
  final String? repliedBy;
  final bool trailingWarn;
  final String? preview;
  final bool previewStrong;
  final int previewLines;

  /// How many leading characters of [preview] are a name, shown stronger.
  final int? previewLead;

  final String? more;
  final Widget? extra;
  final List<({String label, VoidCallback run})> actions;
  final VoidCallback onTap;

  @override
  State<_ActivityRow> createState() => _ActivityRowState();
}

class _ActivityRowState extends State<_ActivityRow> {
  bool _hovered = false;

  /// The row has keyboard focus, on it or on one of its actions: they show
  /// for someone who cannot hover.
  bool _focused = false;

  bool get _hasProject => widget.where?.isNotEmpty ?? false;

  String get _lead => !widget.forThread
      ? 'in'
      : widget.repliedBy == null
      ? ''
      : '${widget.repliedBy} replied';

  /// Whether the row has meta to show: a project, or who replied.
  bool get _hasWhere => _hasProject || (widget.forThread && _lead.isNotEmpty);

  Widget _where() {
    final style = DesktopChrome.metadata();
    final where = widget.where;
    final lead = _lead;
    final join = lead.isEmpty ? '' : (widget.forThread ? ' · ' : ' ');
    if (where == null || where.isEmpty) {
      return Text(
        lead,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }
    if (!widget.privateWhere) {
      return Text(
        '$lead$join# $where',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(text: '$lead$join'),
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: PrivateProjectLock(size: 12, color: style.color),
          ),
          TextSpan(text: ' $where'),
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );
  }

  Widget _preview() {
    final text = widget.preview;
    if (text == null) return const SizedBox.shrink();
    final strong = widget.previewStrong;
    final base = DesktopChrome.control(
      color: strong
          ? DesktopChrome.foreground
          : widget.unread
          ? DesktopChrome.muted
          : grid.AppPalette.textFaint,
    ).copyWith(fontWeight: strong ? grid.AppFont.semibold : null);
    final lead = widget.previewLead;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 1),
        Text.rich(
          TextSpan(
            style: base,
            children: [
              if (lead != null) ...[
                TextSpan(
                  text: text.substring(0, lead),
                  style: TextStyle(color: DesktopChrome.foreground),
                ),
                TextSpan(text: text.substring(lead)),
              ] else
                TextSpan(text: text),
            ],
          ),
          maxLines: widget.previewLines,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final unread = widget.unread;
    final whoStyle = DesktopChrome.control(
      color: unread ? DesktopChrome.foreground : DesktopChrome.muted,
    ).copyWith(fontWeight: unread ? grid.AppFont.semibold : null);
    final actions = widget.actions;
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.controlGap,
        vertical: grid.AppDesktop.listRowGap,
      ),
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        // Focus on the row or on any action in it: the actions stay while
        // someone tabs to them.
        child: Focus(
          canRequestFocus: false,
          skipTraversal: true,
          onFocusChange: (focused) => setState(() => _focused = focused),
          child: Stack(
            children: [
              Material(
                color: Colors.transparent,
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: widget.onTap,
                  hoverColor: grid.AppSurface.hoverFill,
                  focusColor: grid.AppSurface.hoverFill,
                  child: Semantics(
                    label: unread ? 'New' : null,
                    // The hover actions, for a screen reader that cannot hover.
                    customSemanticsActions: {
                      for (final action in actions)
                        CustomSemanticsAction(label: action.label): action.run,
                    },
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: grid.AppDesktop.controlGap,
                        vertical: grid.AppDesktop.controlGap,
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: grid.AppDesktop.controlGap,
                            child: unread
                                ? Column(
                                    mainAxisAlignment: MainAxisAlignment.start,
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      const SizedBox(height: 13),
                                      DecoratedBox(
                                        key: const ValueKey(
                                          'super-activity-dot',
                                        ),
                                        decoration: BoxDecoration(
                                          color: DesktopChrome.accent,
                                          shape: BoxShape.circle,
                                        ),
                                        child: const SizedBox.square(
                                          dimension: 7,
                                        ),
                                      ),
                                    ],
                                  )
                                : null,
                          ),
                          const SizedBox(width: grid.AppDesktop.controlGap),
                          SuperTabAvatarFace(
                            identity: widget.avatarName,
                            name: widget.avatarName,
                            size: 32,
                            radius: 8,
                          ),
                          const SizedBox(width: grid.AppDesktop.controlGap + 4),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    // The name and channel share what the time
                                    // leaves: loose Flexibles beside a Spacer left
                                    // the time floating mid-row (review shots).
                                    Expanded(
                                      child: Row(
                                        children: [
                                          Flexible(
                                            flex: 3,
                                            child: Text(
                                              widget.who,
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: whoStyle,
                                            ),
                                          ),
                                          if (_hasWhere) ...[
                                            const SizedBox(width: 6),
                                            Flexible(flex: 2, child: _where()),
                                          ],
                                        ],
                                      ),
                                    ),
                                    const SizedBox(
                                      width: grid.AppDesktop.controlGap,
                                    ),
                                    Text(
                                      widget.trailing,
                                      maxLines: 1,
                                      style: DesktopChrome.metadata(
                                        color: widget.trailingWarn
                                            ? grid.AppPalette.warn
                                            : grid.AppPalette.textFaint,
                                      ),
                                    ),
                                  ],
                                ),
                                _preview(),
                                if (widget.more != null) ...[
                                  const SizedBox(height: 3),
                                  Text(
                                    widget.more!,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: DesktopChrome.metadata(
                                      color: DesktopChrome.accent,
                                    ),
                                  ),
                                ],
                                ?widget.extra,
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              if ((_hovered || _focused) && actions.isNotEmpty)
                Positioned(
                  right: grid.AppDesktop.controlGap,
                  top: 4,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: grid.AppDesktop.surface,
                      borderRadius: BorderRadius.circular(
                        DesktopChrome.rowRadius,
                      ),
                      border: Border.all(color: DesktopChrome.rim),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (final action in actions)
                          InkWell(
                            onTap: action.run,
                            borderRadius: BorderRadius.circular(
                              DesktopChrome.rowRadius,
                            ),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: grid.AppDesktop.controlGap,
                              ),
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const SizedBox(height: 3),
                                  Text(
                                    action.label,
                                    style: DesktopChrome.metadata(
                                      color: DesktopChrome.foreground,
                                    ),
                                  ),
                                  const SizedBox(height: 3),
                                ],
                              ),
                            ),
                          ),
                      ],
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
