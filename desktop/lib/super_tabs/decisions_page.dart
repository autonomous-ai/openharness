import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'activity.dart';
import 'activity_rows.dart';
import 'decisions.dart';
import 'decisions_view.dart' show quietDecisionAction;
import 'model.dart';
import 'page_rows.dart';
import 'prompt_lines.dart';
import 'reminders.dart';

/// Decisions, the sidebar's first page (anh Dee, 11-05, task #2996): what
/// waits on the reader's answer, as Needs you listed it. Due reminders lead,
/// then the agents waiting on them (an agent of their task at a prompt in its
/// terminal too, task #3029), then the decisions by day. Each can be answered
/// here: a decision by an option or in words, an agent in words or at its
/// prompt.
class SuperTabDecisionsPage extends StatefulWidget {
  const SuperTabDecisionsPage({
    super.key,
    required this.activity,
    required this.onOpenConversation,
    this.onOpenReminder,
    this.highlight,
    this.highlightTurn = 0,
    this.now = DateTime.now,
  });
  final SuperTabActivity activity;

  /// The need a notice opened the page for (`decision:<id>`, as
  /// [SuperTabNeed.id]): its row lights for a moment, so the reader sees which
  /// one (task #3029). [highlightTurn] lights it again for the same need.
  final String? highlight;
  final int highlightTurn;

  /// How long a [highlight] stays lit.
  static const lit = Duration(milliseconds: 1800);

  /// Opens the chat of an agent waiting on the reader, or of a decision.
  final ValueChanged<String> onOpenConversation;

  /// Opens a due reminder's message, which clears it.
  final ValueChanged<SuperTabReminder>? onOpenReminder;
  final DateTime Function() now;

  @override
  State<SuperTabDecisionsPage> createState() => _DecisionsPageState();
}

class _DecisionsPageState extends State<SuperTabDecisionsPage> {
  late SuperTabActivity _activity = widget.activity;
  bool _handledShown = false;

  /// The row lit for a moment ([SuperTabDecisionsPage.highlight]).
  String? _lit;
  Timer? _unlight;

  @override
  void initState() {
    super.initState();
    _activity.opened();
    _light(widget.highlight);
  }

  @override
  void didUpdateWidget(SuperTabDecisionsPage old) {
    super.didUpdateWidget(old);
    if (old.activity != widget.activity) {
      _activity.closed();
      _activity = widget.activity..opened();
    }
    if (widget.highlight != old.highlight ||
        widget.highlightTurn != old.highlightTurn) {
      _light(widget.highlight);
    }
  }

  void _light(String? id) {
    _unlight?.cancel();
    _lit = id;
    if (id == null) return;
    _unlight = Timer(SuperTabDecisionsPage.lit, () {
      if (mounted) setState(() => _lit = null);
    });
  }

  @override
  void dispose() {
    _unlight?.cancel();
    _activity.closed();
    super.dispose();
  }

  /// [row], washed in the accent while it is the one lit, and brought into
  /// view. One shape lit or not, so the row keeps its state (a typed answer).
  Widget _lighting(String id, Widget row) {
    final lit = _lit == id;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 240),
      decoration: BoxDecoration(
        color: lit ? grid.AppSurface.accentWashHover : Colors.transparent,
        borderRadius: BorderRadius.circular(grid.AppDesktop.fieldRadius),
      ),
      child: Stack(
        children: [
          row,
          if (lit) _BringIntoView(key: ValueKey('super-activity-lit:$id')),
        ],
      ),
    );
  }

  String _when(DateTime at) => superTabPageWhen(context, at, widget.now());

  SuperTabSnapshot? get _snapshot => _activity.controller.snapshot;

  bool _isPrivate(String projectId) =>
      _snapshot?.projects
          .where((p) => p.id == projectId)
          .firstOrNull
          ?.isPrivate ==
      true;

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
      unawaited(_activity.decisions.delegateAll(deciding));
    }
  }

  List<Widget> _rows() {
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
    // The one list the menu bar draws too (task #2914), in its order.
    final notices = a.notices;
    final due = [for (final n in notices) ?n.reminder];
    final waiting = [
      for (final n in notices)
        if (n.kind == SuperTabNoticeKind.agent) n.need!,
    ];
    final decided = [
      for (final n in notices)
        if (n.kind == SuperTabNoticeKind.decision) n.need!,
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
            return superTabPageBar([
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
    if (due.isEmpty && waiting.isEmpty && decided.isEmpty) {
      final handled = a.handledToday;
      final name = a.coordinatorFor(handled);
      return [
        superTabPageEmpty(
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
      for (final n in waiting) _lighting(n.id, _need(n)),
      ...superTabByDay<SuperTabNeed>(
        decided,
        (n) => n.at,
        (n) => _lighting(n.id, _need(n)),
        widget.now(),
      ),
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
    if (need.kind == SuperTabNeedKind.prompt) return _prompt(need);
    if (decision == null) {
      final project = _snapshot?.projectFor(need.conversationId);
      return SuperTabPageRow(
        key: ValueKey('super-activity-row-${need.id}'),
        avatarName: need.title,
        who: need.title,
        where: project?.name,
        privateWhere: project?.isPrivate == true,
        trailing: 'Open',
        preview: superTabOneLine(need.question ?? ''),
        extra: _AnswerInWords(
          key: ValueKey('super-decision-answer:${need.id}'),
          id: need.id,
          send: (words) => _activity.answerWaiting(need, words),
        ),
        onTap: () {
          widget.onOpenConversation(need.conversationId);
          // At its prompt, beside the task (Huy, #2792).
          if (need.agentId case final agentId?) {
            _activity.controller.openAgentTerminal(
              agentId,
              conversationId: need.conversationId,
            );
          }
        },
      );
    }
    final now = widget.now(), created = decision.createdAt;
    // The sweep takes only what it can answer, and only within its window.
    final pmComing =
        decision.pmTakesOver &&
        created != null &&
        now.difference(created) < const Duration(days: 8);
    final decisions = _activity.decisions;
    return SuperTabPageRow(
      key: ValueKey('super-activity-row-${need.id}'),
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
      extra: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          _options(decision),
          _AnswerInWords(
            key: ValueKey('super-decision-answer:${need.id}'),
            id: need.id,
            busy: decisions.answering.contains(decision.id),
            send: (words) => decisions.answerInWords(decision, words),
            refused: decisions.refusedWords(decision),
            onOpenChat: () =>
                widget.onOpenConversation(decision.conversationId),
          ),
        ],
      ),
      onTap: () => widget.onOpenConversation(decision.conversationId),
    );
  }

  /// An agent of the reader's task at a prompt in its terminal (task #3029):
  /// its last lines, and its terminal a click away, beside the task. It
  /// leaves once the agent moves on (the read drops it).
  Widget _prompt(SuperTabNeed need) {
    final agentId = need.agentId!;
    final project = _snapshot?.projectFor(need.conversationId);
    void open() {
      widget.onOpenConversation(need.conversationId);
      _activity.controller.openAgentTerminal(
        agentId,
        conversationId: need.conversationId,
      );
    }

    return SuperTabPageRow(
      key: ValueKey('super-activity-row-${need.id}'),
      avatarName: _snapshot?.agent(agentId)?.displayName ?? need.title,
      who: need.title,
      where: project?.name,
      privateWhere: project?.isPrivate == true,
      trailing: 'Open',
      preview: need.question,
      extra: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          SuperTabPromptLines(
            key: ValueKey('super-prompt-read:$agentId'),
            controller: _activity.controller,
            agentId: agentId,
          ),
          Padding(
            padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
            child: OutlinedButton(
              key: ValueKey('super-prompt-open:$agentId'),
              onPressed: open,
              child: const Text('Open terminal'),
            ),
          ),
        ],
      ),
      onTap: open,
    );
  }

  Widget _reminder(SuperTabReminder reminder) {
    final project = _snapshot?.projectFor(reminder.conversationId);
    final name = reminder.authorName?.trim() ?? '';
    final who = name.isEmpty ? 'Reminder' : name;
    final text = superTabOneLine(reminder.text);
    return SuperTabPageRow(
      key: ValueKey('super-activity-row-reminder:${reminder.id}'),
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
        : () => unawaited(_activity.decisions.answer(decision, index));
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

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _activity,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final a = _activity;
      final error = a.decisions.error ?? a.reminders.error;
      return LaidOutListView(
        key: const ValueKey('super-decisions-list'),
        padding: const EdgeInsets.only(bottom: grid.AppDesktop.groupGap),
        children: [
          if (error != null)
            superTabPageError(error, () {
              unawaited(a.decisions.load());
              unawaited(a.reminders.load());
            }),
          ..._rows(),
        ],
      );
    },
  );
}

/// "Or type your answer…" with Send, under a row of Decisions (anh Dee,
/// 11-05): the words go to whoever asked. The words stay while they are on
/// their way and when they could not be sent; a server that takes only an
/// option ([refused]) leaves the chat to answer in.
class _AnswerInWords extends StatefulWidget {
  const _AnswerInWords({
    super.key,
    required this.id,
    required this.send,
    this.busy = false,
    this.refused = false,
    this.onOpenChat,
  });

  /// The row's need id, which names the field and its button.
  final String id;
  final Future<bool> Function(String words) send;
  final bool busy, refused;
  final VoidCallback? onOpenChat;

  @override
  State<_AnswerInWords> createState() => _AnswerInWordsState();
}

class _AnswerInWordsState extends State<_AnswerInWords> {
  final _text = TextEditingController();
  bool _sending = false, _failed = false;

  @override
  void initState() {
    super.initState();
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _ready => !_sending && !widget.busy && _text.text.trim().isNotEmpty;

  Future<void> _send() async {
    if (!_ready) return;
    setState(() {
      _sending = true;
      _failed = false;
    });
    final sent = await widget.send(_text.text);
    if (!mounted) return;
    setState(() {
      _sending = false;
      // A refusal says so itself; any other failure is said here.
      _failed = !sent && !widget.refused;
    });
    if (sent) _text.clear();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final id = widget.id;
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: ValueKey('super-decision-words:$id'),
                  controller: _text,
                  enabled: !_sending,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => unawaited(_send()),
                  style: DesktopChrome.control(),
                  decoration: const InputDecoration(
                    isDense: true,
                    hintText: 'Or type your answer…',
                  ),
                ),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              FilledButton(
                key: ValueKey('super-decision-send:$id'),
                onPressed: _ready ? () => unawaited(_send()) : null,
                child: const Text('Send'),
              ),
            ],
          ),
          if (widget.refused || _failed)
            Padding(
              padding: const EdgeInsets.only(top: grid.AppDesktop.listRowGap),
              child: Wrap(
                spacing: grid.AppDesktop.controlGap,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    widget.refused
                        ? "Your words couldn't be sent here. Choose an option, or answer in the chat."
                        : SuperTabDecisions.sendFailed,
                    style: DesktopChrome.metadata(),
                  ),
                  if (widget.refused && widget.onOpenChat != null)
                    quietDecisionAction(
                      key: ValueKey('super-decision-open-chat:$id'),
                      label: 'Open the chat',
                      onPressed: widget.onOpenChat,
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Brings the row it sits in into view once, as it lights.
class _BringIntoView extends StatefulWidget {
  const _BringIntoView({super.key});

  @override
  State<_BringIntoView> createState() => _BringIntoViewState();
}

class _BringIntoViewState extends State<_BringIntoView> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(
        Scrollable.ensureVisible(
          context,
          alignment: 0.3,
          duration: const Duration(milliseconds: 200),
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
