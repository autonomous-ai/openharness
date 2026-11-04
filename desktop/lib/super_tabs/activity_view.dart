import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'activity.dart';
import 'attention.dart';
import 'decisions_view.dart';
import 'machine_status.dart' show superTabAgoShort;
import 'model.dart';
import 'notifications.dart';
import 'private_project_lock.dart';
import 'reminders.dart';
import 'section_heading.dart';

/// Activity, the one place for everything new for the reader (Quiet Swarm
/// design, screens 6 and 11b): Needs you, Reminders, New replies, Done today. One line
/// to a row, bold when it is new, no filters. A click opens the thing where
/// it is; a decision opens its card to answer.
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

  /// Opens the chat of an agent waiting on the reader, or of a task done.
  final ValueChanged<String> onOpenConversation;

  /// Opens a due reminder's message, which clears it.
  final ValueChanged<SuperTabReminder>? onOpenReminder;
  final DateTime Function() now;

  @override
  State<SuperTabActivityView> createState() => _SuperTabActivityViewState();
}

class _SuperTabActivityViewState extends State<SuperTabActivityView> {
  final _marking = <String>{};
  final _answering = <String>{};
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

  /// Starts where a row's mark does: the row's own two insets.
  Widget _heading(String title) => Padding(
    padding: const EdgeInsets.fromLTRB(
      grid.AppDesktop.controlGap + grid.AppDesktop.groupGap,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.menuInset,
    ),
    child: SuperTabSectionHeading(title, startInset: 0, endInset: 0),
  );

  Widget _empty(String text) => Padding(
    // Under the page title's edge.
    padding: const EdgeInsets.fromLTRB(
      grid.AppDesktop.panelPadding,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.panelPadding,
      grid.AppDesktop.controlGap,
    ),
    child: Text(text, style: DesktopChrome.metadata()),
  );

  Widget _need(SuperTabNeed need) {
    final decision = need.decision;
    final mention = need.mention;
    final open = decision != null && _answering.contains(decision.id);
    final row = _Row(
      key: ValueKey('super-activity-row-${need.id}'),
      // The design's @: the icon set has none, and it adds none.
      glyph: need.kind == SuperTabNeedKind.mention ? '@' : null,
      mark: need.kind == SuperTabNeedKind.mention ? null : AppIcons.circleDot,
      title: need.title,
      privateProjectName: need.privateProjectName,
      unread: true,
      trailing: switch (need.kind) {
        SuperTabNeedKind.decision => 'Answer',
        SuperTabNeedKind.agent => 'Open',
        SuperTabNeedKind.mention => need.at == null ? '' : _when(need.at!),
      },
      hoverAction: mention != null && mention.resolvedBy == null
          ? (
              label: 'Mark done',
              busy: _marking.contains(mention.id),
              run: () => unawaited(_done(mention)),
            )
          : null,
      onTap: () {
        if (decision != null) {
          setState(() {
            if (!_answering.remove(decision.id)) _answering.add(decision.id);
          });
        } else if (mention != null) {
          widget.onOpenMention(mention);
        } else {
          widget.onOpenConversation(need.conversationId);
        }
      },
    );
    if (!open) return row;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        row,
        SuperTabDecisionCard(
          decisions: _activity.decisions,
          decision: decision,
        ),
      ],
    );
  }

  Widget _reminder(SuperTabReminder reminder) {
    final text = reminder.text.replaceAll(RegExp(r'\s+'), ' ').trim();
    return _Row(
      key: ValueKey('super-activity-row-reminder:${reminder.id}'),
      mark: AppIcons.clock,
      title: [
        if (reminder.authorName case final name? when name.isNotEmpty) name,
        text.isEmpty ? reminder.conversationTitle : text,
      ].join(': '),
      unread: true,
      trailing: _when(reminder.dueAt),
      onTap: () => widget.onOpenReminder?.call(reminder),
    );
  }

  Widget _thread(SuperTabFollowedThread thread) {
    final text = thread.rootText.replaceAll(RegExp(r'\s+'), ' ').trim();
    return _Row(
      key: ValueKey('super-activity-row-thread:${thread.key}'),
      mark: AppIcons.reply,
      title: text.isEmpty ? 'Thread' : text,
      unread: true,
      trailing: '${_activity.attention.newCount(thread)} new',
      hoverAction: (
        label: 'Unfollow',
        busy: _activity.attention.following.contains(thread.key),
        run: () => unawaited(_activity.attention.setFollow(thread, false)),
      ),
      onTap: () => widget.onOpenThread(thread.conversationId, thread.rootId),
    );
  }

  Widget _finished(SuperTabConversation group) => _Row(
    key: ValueKey('super-activity-row-done:${group.id}'),
    mark: AppIcons.check,
    title: group.title,
    unread: false,
    trailing: _when(group.shippedAt!),
    onTap: () => widget.onOpenConversation(group.id),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    // The threads are read only while this view shows them.
    listenable: Listenable.merge([_activity, _activity.attention]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final a = _activity;
      final needs = a.needsYou;
      final reminders = a.reminders.due;
      final replies = a.newReplies;
      final done = a.doneToday;
      final error =
          a.mentions.error ??
          a.decisions.error ??
          a.reminders.error ??
          a.attention.error;
      return LaidOutListView(
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
                  Expanded(child: Text(error, style: DesktopChrome.control())),
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
          if (needs.isEmpty &&
              reminders.isEmpty &&
              replies.isEmpty &&
              done.isEmpty)
            _empty("You're all caught up."),
          if (needs.isNotEmpty) ...[
            _heading('Needs you'),
            for (final need in needs) _need(need),
          ],
          if (reminders.isNotEmpty) ...[
            _heading('Reminders'),
            for (final reminder in reminders) _reminder(reminder),
          ],
          if (replies.isNotEmpty) ...[
            _heading('New replies'),
            for (final thread in replies) _thread(thread),
          ],
          if (done.isNotEmpty) ...[
            _heading('Done today'),
            for (final group in done) _finished(group),
          ],
        ],
      );
    },
  );
}

/// One line: a mark, the name, and one word or time at the end. Bold when it
/// is new; a hover action (Mark done) takes the place of the time.
class _Row extends StatefulWidget {
  const _Row({
    super.key,
    this.mark,
    this.glyph,
    required this.title,
    this.privateProjectName,
    required this.unread,
    required this.trailing,
    required this.onTap,
    this.hoverAction,
  });
  final IconData? mark;
  final String? glyph;
  final String title;
  final String? privateProjectName;
  final bool unread;
  final String trailing;
  final VoidCallback onTap;
  final ({String label, bool busy, VoidCallback run})? hoverAction;

  @override
  State<_Row> createState() => _RowState();
}

class _RowState extends State<_Row> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final action = widget.hoverAction;
    final bold = widget.unread;
    final style = DesktopChrome.control(
      color: bold ? null : DesktopChrome.muted,
    ).copyWith(fontWeight: bold ? grid.AppFont.semibold : null);
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.controlGap,
        vertical: grid.AppDesktop.listRowGap,
      ),
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: widget.onTap,
            hoverColor: grid.AppSurface.hoverFill,
            focusColor: grid.AppSurface.hoverFill,
            child: Semantics(
              label: bold ? 'New' : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: grid.AppDesktop.groupGap,
                  vertical: grid.AppDesktop.controlGap,
                ),
                child: Row(
                  children: [
                    // Every row has the slot, so every title starts in one column.
                    SizedBox(
                      width: 20,
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: widget.mark == null
                            ? Text(widget.glyph ?? '', style: style)
                            : Icon(
                                widget.mark,
                                size: AppIcons.inlineSize,
                                color: style.color,
                              ),
                      ),
                    ),
                    Expanded(
                      child: widget.privateProjectName == null
                          ? Text(
                              widget.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: style,
                            )
                          : Text.rich(
                              TextSpan(
                                children: [
                                  TextSpan(text: widget.title),
                                  WidgetSpan(
                                    alignment: PlaceholderAlignment.middle,
                                    child: PrivateProjectLock(
                                      size: 14,
                                      color: style.color,
                                    ),
                                  ),
                                  TextSpan(
                                    text: ' ${widget.privateProjectName}',
                                  ),
                                ],
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: style,
                            ),
                    ),
                    const SizedBox(width: grid.AppDesktop.groupGap),
                    if (action != null && _hovered)
                      GestureDetector(
                        onTap: action.busy ? null : action.run,
                        child: Text(action.label, style: style),
                      )
                    else
                      Text(widget.trailing, style: DesktopChrome.metadata()),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
