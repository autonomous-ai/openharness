import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart';
import '../theme/app_theme.dart' show AppColors;
import 'swarm_asks.dart';
import 'swarm_inbox.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Opens where a need was asked: a Swarm's conversation.
typedef SwarmOpen = void Function(String swarmId, String conversationId);

/// A need's glyph: a question for a decision, @ for a tag, a clock for work
/// waiting on the person.
IconData swarmNeedIcon(SwarmNeed need) => switch (need) {
  SwarmDecisionNeed() => LucideIcons.circleQuestionMark300,
  SwarmMentionNeed() => LucideIcons.atSign300,
  SwarmWorkNeed() => LucideIcons.clock300,
};

/// The project a need was asked in.
String _projectOf(SwarmNeed need) => switch (need) {
  SwarmDecisionNeed(:final decision) => decision.projectName,
  SwarmMentionNeed(:final mention) => mention.projectName,
  SwarmWorkNeed(:final work) => work.project.name,
};

/// One thing a Swarm asks of the person, open on Swarm Home: its glyph, who
/// asks and in which project — a tap there opens where it was asked — what
/// they ask, and what the person can do: a decision's options, Done on a
/// tag ("Done…" until confirmed, a failure said under it), Open chat on work
/// waiting on them.
class SwarmNeedRow extends StatelessWidget {
  const SwarmNeedRow({
    super.key,
    required this.session,
    required this.need,
    required this.onOpen,
  });

  final SwarmSession session;
  final SwarmNeed need;
  final SwarmOpen onOpen;

  void _open() => onOpen(need.swarmId, need.conversationId);

  @override
  Widget build(BuildContext context) => switch (need) {
    final SwarmDecisionNeed decision => SwarmDecisionCard(
      key: ValueKey('swarm-need-${need.key}'),
      session: session,
      need: decision,
      onOpen: _open,
    ),
    SwarmMentionNeed(:final mention) => _mention(mention),
    SwarmWorkNeed(:final work) => _NeedCard(
      key: ValueKey('swarm-need-${need.key}'),
      need: need,
      onOpen: _open,
      body: work.question ?? work.conversation.label,
      actions: SwarmButton(
        key: ValueKey('swarm-need-chat-${need.key}'),
        label: 'Open chat',
        style: SwarmButtonStyle.fill,
        wide: true,
        onPressed: _open,
      ),
    ),
  };

  /// A Lead's tag: Done says "Done…" the moment it is tapped, the tag goes
  /// once confirmed, and a failure is said under it.
  Widget _mention(SuperTabMention mention) {
    final asks = session.inbox.asks(need.swarmId);
    return _NeedCard(
      key: ValueKey('swarm-need-${need.key}'),
      need: need,
      onOpen: _open,
      body: mention.text.isNotEmpty ? mention.text : mention.conversationTitle,
      actions: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: SwarmButton(
                  key: ValueKey('swarm-done-${mention.id}'),
                  label: 'Done',
                  style: SwarmButtonStyle.fill,
                  busy: asks?.finishing(mention) ?? false,
                  busyLabel: 'Done…',
                  onPressed: () => unawaited(asks?.done(mention)),
                ),
              ),
              const SizedBox(width: 8),
              SwarmButton(
                key: ValueKey('swarm-need-chat-${need.key}'),
                label: 'Open chat',
                style: SwarmButtonStyle.link,
                onPressed: _open,
              ),
            ],
          ),
          if (asks?.notDone(mention) case final failure?) ...[
            const SizedBox(height: 8),
            Text(
              failure,
              key: ValueKey('swarm-not-done-${mention.id}'),
              style: TextStyle(
                color: AppColors.danger,
                fontSize: 13.5,
                height: 1.35,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Who asks, in a few words: "River asks you", "Nova is stuck".
String swarmNeedTitle(SwarmNeed need) => switch (need) {
  SwarmDecisionNeed(:final decision) => '${decision.askerName} asks you',
  SwarmMentionNeed(:final mention) => '${mention.leadName} tagged you',
  SwarmWorkNeed(:final work) =>
    work.status == 'blocked'
        ? '${work.agentName} is stuck'
        : '${work.agentName} needs you',
};

/// A need on Swarm Home while another is open there: its glyph, who asks and
/// one line of what, a tap to open it in its place. A decision whose answer
/// is held for Undo says so.
class SwarmNeedLine extends StatelessWidget {
  const SwarmNeedLine({
    super.key,
    required this.session,
    required this.need,
    required this.onTap,
  });

  final SwarmSession session;
  final SwarmNeed need;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final line = switch (need) {
      final SwarmDecisionNeed decision => switch (session.held(decision)) {
        final choice? =>
          'Sending “${_option(decision.decision.options, choice)}”',
        null => decision.decision.question,
      },
      SwarmMentionNeed(:final mention) =>
        mention.text.isNotEmpty ? mention.text : mention.conversationTitle,
      SwarmWorkNeed(:final work) => work.question ?? work.conversation.label,
    };
    return SwarmRow(
      leading: Icon(
        swarmNeedIcon(need),
        size: 20,
        color: AppPalette.textSecondary,
      ),
      title: swarmNeedTitle(need),
      detail: line.isEmpty ? null : SwarmRow.line(line),
      chevron: LucideIcons.chevronDown300,
      onTap: onTap,
    );
  }
}

/// An open need: its glyph in the warning colour, who asks and where — a tap
/// there opens where it was asked, when [onOpen] is given — then [body] and
/// [actions].
class _NeedCard extends StatelessWidget {
  const _NeedCard({
    super.key,
    required this.need,
    required this.body,
    required this.actions,
    this.onOpen,
  });

  final SwarmNeed need;
  final String body;
  final Widget actions;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final project = _projectOf(need);
    final header = Text.rich(
      TextSpan(
        children: [
          TextSpan(text: swarmNeedTitle(need)),
          if (project.isNotEmpty)
            TextSpan(
              text: ' · $project',
              style: TextStyle(
                color: AppPalette.textSecondary,
                fontSize: 13.5,
                fontWeight: FontWeight.w400,
              ),
            ),
        ],
      ),
      style: TextStyle(
        color: AppPalette.textPrimary,
        fontSize: 16,
        fontWeight: FontWeight.w500,
        height: 1.3,
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(
              swarmNeedIcon(need),
              size: 20,
              color: AppColors.warning,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (onOpen case final open?)
                  GestureDetector(
                    key: ValueKey('swarm-need-open-${need.key}'),
                    behavior: HitTestBehavior.opaque,
                    onTap: open,
                    child: header,
                  )
                else
                  header,
                if (body.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text.rich(
                    _mentions(body),
                    style: TextStyle(
                      color: AppPalette.textPrimary,
                      fontSize: 16,
                      height: 1.4,
                    ),
                  ),
                ],
                const SizedBox(height: 14),
                actions,
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// [text] with each @name in the accent, on a faint wash.
TextSpan _mentions(String text) {
  final spans = <InlineSpan>[];
  var at = 0;
  for (final match in RegExp(r'@[\w.-]+').allMatches(text)) {
    if (match.start > at) {
      spans.add(TextSpan(text: text.substring(at, match.start)));
    }
    spans.add(
      TextSpan(
        text: match[0],
        style: TextStyle(
          color: AppPalette.swarmAccent,
          backgroundColor: AppPalette.swarmAccent.withValues(alpha: .13),
          fontWeight: FontWeight.w500,
        ),
      ),
    );
    at = match.end;
  }
  if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
  return TextSpan(children: spans);
}

/// A decision asked of the person: who asks, the question, and what can be
/// done with it ([SwarmDecisionAnswer]).
class SwarmDecisionCard extends StatelessWidget {
  const SwarmDecisionCard({
    super.key,
    required this.session,
    required this.need,
    this.onOpen,
  });

  final SwarmSession session;
  final SwarmDecisionNeed need;

  /// Opens the conversation it was asked in; null where it is already open.
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) => _NeedCard(
    need: need,
    onOpen: onOpen,
    body: need.decision.question,
    actions: SwarmDecisionAnswer(session: session, need: need),
  );
}

/// What can be done with an open decision, as the prototype draws it on
/// Swarm Home and in a chat alike: its options side by side. One tap holds
/// the answer for the session's Undo window — a bar drains while it waits —
/// then sends it; an answer cannot be changed once sent. In a chat's card
/// ([fillRecommended]) the recommended option is filled.
class SwarmDecisionAnswer extends StatelessWidget {
  const SwarmDecisionAnswer({
    super.key,
    required this.session,
    required this.need,
    this.fillRecommended = false,
  });

  final SwarmSession session;
  final SwarmDecisionNeed need;
  final bool fillRecommended;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final decision = need.decision;
    final asks = session.inbox.asks(need.swarmId);
    final held = session.held(need);
    final sending = asks?.answering.contains(decision.id) ?? false;
    final note = TextStyle(
      color: AppColors.warning,
      fontSize: 13.5,
      height: 1.35,
    );
    final Widget actions;
    if (held != null) {
      actions = _Held(
        key: ValueKey('swarm-held-box-${decision.id}-$held'),
        label: 'Sending “${_option(decision.options, held)}”',
        labelKey: ValueKey('swarm-held-${decision.id}'),
        window: session.undoWindow,
        action: SwarmButton(
          key: ValueKey('swarm-undo-${decision.id}'),
          label: 'Undo',
          style: SwarmButtonStyle.link,
          onPressed: () => session.undo(need),
        ),
      );
    } else if (sending) {
      actions = const _Held(label: 'Sending…');
    } else if (asks?.unconfirmed(decision) case final choice?) {
      // Sent, and maybe taken: only the same answer may go again.
      actions = _Held(
        label: '“${_option(decision.options, choice)}” is not confirmed.',
        action: SwarmButton(
          key: ValueKey('swarm-resend-${decision.id}'),
          label: 'Send again',
          style: SwarmButtonStyle.link,
          onPressed: () => unawaited(asks!.answer(decision, choice)),
        ),
      );
    } else {
      actions = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (session.dropped(need)) ...[
            Text(
              'Not sent, choose again.',
              key: ValueKey('swarm-dropped-${decision.id}'),
              style: note,
            ),
            const SizedBox(height: 8),
          ],
          _Options(
            labels: decision.options,
            filled: fillRecommended ? decision.recommended : null,
            keyOf: (index) => ValueKey('swarm-option-${decision.id}-$index'),
            onTap: (index) => session.hold(need, index),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        actions,
        if (asks?.error case final error?) ...[
          const SizedBox(height: 8),
          Text(error, style: note.copyWith(color: AppColors.danger)),
        ],
      ],
    );
  }
}

String _option(List<String> options, int index) =>
    index >= 0 && index < options.length ? options[index] : 'Option $index';

/// A decision's options, as many to a line as fit at 120 points or more,
/// sharing it evenly; a long one wraps inside its button. The [filled] one,
/// if any, is filled and read as recommended.
class _Options extends StatelessWidget {
  const _Options({
    required this.labels,
    required this.keyOf,
    required this.onTap,
    this.filled,
  });

  final List<String> labels;
  final Key Function(int index) keyOf;
  final void Function(int index) onTap;
  final int? filled;

  static const _gap = 8.0, _least = 120.0;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final perLine = math.max(
        1,
        ((constraints.maxWidth + _gap) / (_least + _gap)).floor(),
      );
      final lines = [
        for (var start = 0; start < labels.length; start += perLine)
          [
            for (
              var i = start;
              i < math.min(start + perLine, labels.length);
              i++
            )
              i,
          ],
      ];
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (n, line) in lines.indexed) ...[
            if (n > 0) const SizedBox(height: _gap),
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (j, index) in line.indexed) ...[
                    if (j > 0) const SizedBox(width: _gap),
                    Expanded(
                      child: switch (SwarmButton(
                        key: keyOf(index),
                        label: labels[index],
                        style: index == filled
                            ? SwarmButtonStyle.fill
                            : SwarmButtonStyle.plain,
                        onPressed: () => onTap(index),
                      )) {
                        final button when index == filled => Semantics(
                          button: true,
                          label: '${labels[index]} (recommended)',
                          onTap: () => onTap(index),
                          excludeSemantics: true,
                          child: button,
                        ),
                        final button => button,
                      },
                    ),
                  ],
                ],
              ),
            ),
          ],
        ],
      );
    },
  );
}

/// An answer on its way: its words in a field, maybe a way to take it back,
/// and — while it is held — a bar that drains over [window].
class _Held extends StatelessWidget {
  const _Held({
    super.key,
    required this.label,
    this.labelKey,
    this.action,
    this.window,
  });

  final String label;
  final Key? labelKey;
  final Widget? action;
  final Duration? window;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: ColoredBox(
        color: AppPalette.swarmSearchSurface,
        child: Stack(
          children: [
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 2, 4, 5),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        label,
                        key: labelKey,
                        style: TextStyle(
                          color: AppPalette.textPrimary,
                          fontSize: 15,
                          height: 1.3,
                        ),
                      ),
                    ),
                    ?action,
                  ],
                ),
              ),
            ),
            if (window case final window? when window > Duration.zero)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 1, end: 0),
                  duration: window,
                  builder: (context, left, _) => FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: left,
                    child: Container(height: 3, color: AppPalette.accent),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
