import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show CustomSemanticsAction;

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'activity_rows.dart';
import 'avatar_art.dart';
import 'decisions_view.dart' show quietDecisionAction;
import 'machine_status.dart' show superTabAgoShort;
import 'private_project_lock.dart';

/// The building blocks the Decisions, Mentions and Threads pages share: a
/// row that says who said what and where, day headings, a bar of actions,
/// the empty state and the end of a list that reads more.

/// Today's clock time, else how long ago: a row's one word of when.
String superTabPageWhen(BuildContext context, DateTime at, DateTime now) {
  final local = at.toLocal();
  if (local.year == now.year &&
      local.month == now.month &&
      local.day == now.day) {
    return MaterialLocalizations.of(context)
        .formatTimeOfDay(TimeOfDay.fromDateTime(local));
  }
  return superTabAgoShort(now.difference(local));
}

/// Whitespace collapsed to single spaces: a row's one-line preview.
String superTabOneLine(String text) =>
    text.replaceAll(RegExp(r'\s+'), ' ').trim();

/// A bar of actions over a page's list.
Widget superTabPageBar(List<Widget> children) => Container(
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

/// Mark all read, quiet, as the decisions' own actions are.
Widget superTabMarkAllRead(VoidCallback? onPressed) => quietDecisionAction(
  key: const ValueKey('super-activity-mark-all-read'),
  label: 'Mark all read',
  onPressed: onPressed,
);

/// A heading in a page's list: a day, or Read.
Widget superTabPageHeading(String title) => Padding(
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

/// What a page says when it lists nothing.
Widget superTabPageEmpty(String title, [String? more, Widget? action]) =>
    Padding(
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

/// A read that failed, with Retry, over a page's list.
Widget superTabPageError(String error, VoidCallback onRetry) => Padding(
  padding: const EdgeInsets.fromLTRB(
    grid.AppDesktop.groupGap,
    grid.AppDesktop.controlGap,
    grid.AppDesktop.groupGap,
    0,
  ),
  child: Row(
    children: [
      Expanded(child: Text(error, style: DesktopChrome.control())),
      TextButton(onPressed: onRetry, child: const Text('Retry')),
    ],
  ),
);

/// Day headings between runs of [items], already newest first.
List<Widget> superTabByDay<T>(
  List<T> items,
  DateTime? Function(T) at,
  Widget Function(T) row,
  DateTime now,
) {
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
        superTabPageHeading(switch (day) {
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

/// One row, Slack's way: an unread dot, an avatar, who and where and when,
/// then a preview and whatever hangs under it. Every row is unread but a
/// read thread's (Threads lists those below the new ones): it has no dot, a
/// regular muted name and a faint preview. Hover actions float at the
/// right, over the time.
class SuperTabPageRow extends StatefulWidget {
  const SuperTabPageRow({
    super.key,
    this.unread = true,
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
    this.marks = const [],
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

  /// Words of [preview] drawn in the accent, semibold: the reader's own tag
  /// in a mention (`@dee`), wherever it is, in any case.
  final List<String> marks;

  final String? more;
  final Widget? extra;
  final List<({String label, VoidCallback run})> actions;
  final VoidCallback onTap;

  @override
  State<SuperTabPageRow> createState() => _PageRowState();
}

class _PageRowState extends State<SuperTabPageRow> {
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
    // Unread in the foreground, read faint: muted read too close to faint to
    // tell apart (Diego, #2887).
    final base = DesktopChrome.control(
      color: strong || widget.unread
          ? DesktopChrome.foreground
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
                ..._marked(text),
            ],
          ),
          maxLines: widget.previewLines,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }

  /// [text] with each of [SuperTabPageRow.marks] in it drawn marked.
  List<InlineSpan> _marked(String text) {
    final marks = [
      for (final m in widget.marks)
        if (m.isNotEmpty) RegExp.escape(m),
    ];
    if (marks.isEmpty) return [TextSpan(text: text)];
    final style = TextStyle(
      color: DesktopChrome.accent,
      fontWeight: grid.AppFont.semibold,
    );
    final spans = <InlineSpan>[];
    var from = 0;
    for (final match in RegExp(
      marks.join('|'),
      caseSensitive: false,
    ).allMatches(text)) {
      if (match.start > from) {
        spans.add(TextSpan(text: text.substring(from, match.start)));
      }
      spans.add(TextSpan(text: match[0], style: style));
      from = match.end;
    }
    if (from < text.length) spans.add(TextSpan(text: text.substring(from)));
    return spans;
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

/// The end of the read threads while there are more: built only once the list
/// scrolls to it, it asks for the next page.
class SuperTabReadMore extends StatefulWidget {
  const SuperTabReadMore({super.key, required this.onShown});

  final Future<void> Function() onShown;

  @override
  State<SuperTabReadMore> createState() => _ReadMoreState();
}

class _ReadMoreState extends State<SuperTabReadMore> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(widget.onShown());
    });
  }

  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.all(grid.AppDesktop.groupGap),
    child: Center(
      child: SizedBox.square(
        dimension: 16,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
    ),
  );
}
