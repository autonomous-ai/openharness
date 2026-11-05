import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import 'backlog.dart';
import 'machine_status.dart';
import 'model.dart';
import 'pulse.dart';
import 'visible_tick.dart';

/// The strip on top of a project's Tasks board (task #3384):
/// `Waiting for River: 2 asks · oldest 14m (Huy) │ Working 6 of 10 │ Next up 7
/// │ Lost 0 │ Held 3`. Each count opens its list. A count is red from its
/// rule's `redAt` on, said by the error ink, a bold label and an alert icon
/// together; the strip's rim turns red with it.
class SuperTabPulseStrip extends StatefulWidget {
  const SuperTabPulseStrip({
    super.key,
    required this.pulse,
    required this.snapshot,
    required this.projectId,
    required this.now,
    required this.onOpenTask,
    required this.onOpenMessage,
  });

  final SuperTabPulse pulse;
  final SuperTabSnapshot snapshot;
  final String projectId;
  final DateTime Function() now;
  final ValueChanged<String> onOpenTask;
  final void Function(String conversationId, String messageId) onOpenMessage;

  /// A list's widest: room for a task title and its number on one line.
  static const menuWidth = 340.0;

  @override
  State<SuperTabPulseStrip> createState() => _SuperTabPulseStripState();
}

class _SuperTabPulseStripState extends State<SuperTabPulseStrip>
    with WidgetsBindingObserver, VisibleTick {
  /// Wakes the strip for what changes with no new read: a `redAt` passing and
  /// the oldest ask's age reaching its next step. Only while on screen.
  Timer? _wake;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _arm();
  }

  @override
  void didUpdateWidget(SuperTabPulseStrip old) {
    super.didUpdateWidget(old);
    _arm();
  }

  @override
  void onScreenChanged(bool onScreen) => _arm();

  @override
  void dispose() {
    _wake?.cancel();
    super.dispose();
  }

  void _arm() {
    _wake?.cancel();
    _wake = null;
    if (!onScreen) return;
    final now = widget.now();
    final pulse = widget.pulse;
    final oldest = pulse.asks.count > 0 ? pulse.asks.oldestAt : null;
    final waits = [
      if (pulse.nextRedAfter(now) case final at?) at.difference(now),
      if (oldest != null) _nextAgeStep(now.difference(oldest)),
    ];
    if (waits.isEmpty) return;
    final wait = waits.reduce((a, b) => a < b ? a : b);
    _wake = Timer(wait, () {
      if (!mounted) return;
      setState(() {});
      _arm();
    });
  }

  /// How long until [age], as [_age] writes it, reads differently.
  static Duration _nextAgeStep(Duration age) {
    final unit = age < const Duration(hours: 1)
        ? const Duration(minutes: 1)
        : age < const Duration(days: 1)
        ? const Duration(hours: 1)
        : const Duration(days: 1);
    final into = Duration(
      microseconds: age.inMicroseconds % unit.inMicroseconds,
    );
    return unit - into;
  }

  /// An age as the board's captions write it: now, 14m, 3h, 2d.
  static String _age(Duration age) =>
      age.inMinutes < 1 ? 'now' : superTabAgoShort(age);

  SuperTabSnapshot get _snapshot => widget.snapshot;

  String? _person(String? id) => id == null
      ? null
      : _snapshot.people.where((p) => p.id == id).firstOrNull?.shownName;

  String get _pmName => _snapshot.agentName(
    widget.pulse.pmId ?? '',
    fallback: _snapshot.coordinatorNameOf(widget.projectId),
  );

  String _asksText(DateTime now) {
    final asks = widget.pulse.asks;
    if (asks.count == 0) return 'Nothing waiting for $_pmName';
    final person = _person(asks.personId);
    return [
      'Waiting for $_pmName: ${asks.count} ${asks.count == 1 ? 'ask' : 'asks'}',
      if (asks.oldestAt case final at?)
        'oldest ${_age(now.difference(at))}${person == null ? '' : ' ($person)'}',
    ].join(' · ');
  }

  String _heldText() {
    final held = widget.pulse.held;
    return held.withoutReason > 0
        ? 'Held ${held.count} (${held.withoutReason} no reason)'
        : 'Held ${held.count}';
  }

  /// Why [rule] is red, for its icon's tooltip and screen readers.
  String _why(SuperTabPulseRule rule) {
    final limits = widget.pulse.limits;
    String over(int? minutes, String text) =>
        minutes == null ? text : '$text $minutes minutes';
    return switch (rule) {
      SuperTabPulseRule.asks => over(
        limits.askMinutes,
        'An ask has waited for $_pmName over',
      ),
      SuperTabPulseRule.idle => over(
        limits.idleMinutes,
        'Nobody has worked while tasks waited for',
      ),
      SuperTabPulseRule.lost => over(
        limits.lostMinutes,
        'A task has had no agent for',
      ),
      SuperTabPulseRule.held => 'A task is held with no reason',
    };
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final now = widget.now();
    final pulse = widget.pulse;
    final error = Theme.of(context).colorScheme.error;
    bool red(SuperTabPulseRule rule) => pulse.isRed(rule, now);
    final parts = [
      _segment(
        'asks',
        _asksText(now),
        red(SuperTabPulseRule.asks) ? SuperTabPulseRule.asks : null,
        _askRows(now),
      ),
      _segment(
        'working',
        'Working ${pulse.working.count} of ${pulse.working.crew}',
        red(SuperTabPulseRule.idle) ? SuperTabPulseRule.idle : null,
        _agentRows(),
      ),
      _segment(
        'nextUp',
        'Next up ${pulse.nextUp.count}',
        null,
        _taskRows(pulse.nextUp.conversationIds, empty: 'No tasks next up'),
      ),
      _segment(
        'lost',
        'Lost ${pulse.lost.count}',
        red(SuperTabPulseRule.lost) ? SuperTabPulseRule.lost : null,
        _taskRows(pulse.lost.conversationIds, empty: 'No lost tasks'),
      ),
      _segment(
        'held',
        _heldText(),
        red(SuperTabPulseRule.held) ? SuperTabPulseRule.held : null,
        _taskRows(
          [for (final hold in pulse.held.list) hold.conversationId],
          reasons: {
            for (final hold in pulse.held.list)
              hold.conversationId: hold.reason ?? 'No reason',
          },
          empty: 'No held tasks',
        ),
      ),
    ];
    return DecoratedBox(
      key: const ValueKey('super-pulse'),
      decoration: BoxDecoration(
        color: grid.AppCard.base,
        borderRadius: BorderRadius.circular(grid.AppCard.radius),
        border: Border.all(
          color: pulse.anyRed(now) ? error : grid.AppCard.hair,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(grid.AppDesktop.listRowGap),
        child: Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            for (final (i, part) in parts.indexed) ...[
              if (i > 0) _divider(),
              part,
            ],
          ],
        ),
      ),
    );
  }

  Widget _divider() => SizedBox(
    height: AppIcons.inlineSize,
    child: VerticalDivider(
      width: grid.AppDesktop.listRowGap,
      thickness: 1,
      color: grid.AppCard.hair,
    ),
  );

  /// One count: its words, red by [redBy] when that rule has passed, opening
  /// [rows] beneath it.
  Widget _segment(
    String name,
    String text,
    SuperTabPulseRule? redBy,
    List<Widget> rows,
  ) {
    final error = Theme.of(context).colorScheme.error;
    final red = redBy != null;
    final style =
        DesktopChrome.control(color: red ? error : DesktopChrome.foreground)
            .copyWith(
              fontWeight: red ? FontWeight.w600 : FontWeight.w400,
              fontFeatures: const [FontFeature.tabularFigures()],
            );
    return AppDropdown(
      width: SuperTabPulseStrip.menuWidth,
      consumeOutsideTap: false,
      children: rows,
      builder: (context, menu, _) => Semantics(
        button: true,
        child: InkWell(
          key: ValueKey('super-pulse-$name'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          hoverColor: grid.AppSurface.hoverFill,
          onTap: () => menu.isOpen ? menu.close() : menu.open(),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.controlGap,
              vertical: grid.AppDesktop.menuInset,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (red) ...[
                  Tooltip(
                    message: _why(redBy),
                    child: Icon(
                      AppIcons.circleAlert,
                      size: AppIcons.inlineSize,
                      color: error,
                      semanticLabel: _why(redBy),
                    ),
                  ),
                  const SizedBox(width: grid.AppDesktop.menuInset),
                ],
                Text(text, style: style),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// A row's age or task number at its end edge, one column down the list. Not
  /// the row's note: a note shares the row's slack with the label half and
  /// half, which cut a task's title short beside a three-figure number.
  static Widget _aside(String text) => Text(
    text,
    style: DesktopChrome.metadata().copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
    ),
  );

  /// A row saying a list is empty, so a count of 0 still answers its tap.
  static Widget _none(String text) => AppMenuItem(label: text, onPressed: null);

  /// [conversationId]'s place, as the ask's row says where it was asked.
  String? _placeOf(String conversationId) {
    final project = _snapshot.projectById(widget.projectId);
    if (project?.leadConversationId == conversationId) {
      return '${project!.isPrivate ? '' : '# '}${project.name}';
    }
    final group = _snapshot.conversation(conversationId);
    return group == null ? null : _label(group);
  }

  /// A task as a list names it: `#12 Its title`, the priority marker dropped as
  /// the board's cards drop it.
  static String _label(SuperTabConversation task) {
    final title = superTabTitlePriority(task.title).title;
    return task.number == null ? title : '#${task.number} $title';
  }

  List<Widget> _askRows(DateTime now) => [
    for (final ask in widget.pulse.asks.list)
      AppMenuItem(
        key: ValueKey('super-pulse-ask-${ask.messageId}'),
        label: _person(ask.personId) ?? 'Someone',
        trailing: _aside(_age(now.difference(ask.at))),
        detail: _placeOf(ask.conversationId),
        onPressed: () =>
            widget.onOpenMessage(ask.conversationId, ask.messageId),
      ),
    if (widget.pulse.asks.list.isEmpty) _none('No asks waiting'),
  ];

  /// The task [agentId] works on in this project, while the Swarm holds it.
  SuperTabConversation? _taskOf(String agentId) => _snapshot.conversations
      .where(
        (g) =>
            g.projectId == widget.projectId &&
            g.assignment?['agentId'] == agentId &&
            !g.closed &&
            !superTabTaskShipped(g),
      )
      .firstOrNull;

  List<Widget> _agentRows() => [
    for (final id in widget.pulse.working.agentIds)
      if (_taskOf(id) case final task)
        AppMenuItem(
          key: ValueKey('super-pulse-agent-$id'),
          label: _snapshot.agentName(id),
          detail: task == null ? null : _label(task),
          onPressed: task == null ? null : () => widget.onOpenTask(task.id),
        ),
    if (widget.pulse.working.agentIds.isEmpty) _none('No agents working'),
  ];

  List<Widget> _taskRows(
    List<String> ids, {
    Map<String, String> reasons = const {},
    required String empty,
  }) => [
    for (final id in ids)
      if (_snapshot.conversation(id) case final task)
        AppMenuItem(
          key: ValueKey('super-pulse-task-$id'),
          label: task == null
              ? 'Task'
              : superTabTitlePriority(task.title).title,
          trailing: task?.number == null ? null : _aside('#${task!.number}'),
          detail: reasons[id],
          onPressed: () => widget.onOpenTask(id),
        ),
    if (ids.isEmpty) _none(empty),
  ];
}
