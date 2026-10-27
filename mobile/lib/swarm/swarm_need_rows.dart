import 'dart:async';

import 'package:flutter/material.dart';

import '../phone/settings_row.dart';
import '../phone/tty.dart';
import '../phone/tty_controls.dart';
import '../shared/theme/app_theme.dart';
import 'swarm_asks.dart';
import 'swarm_inbox.dart';
import 'swarm_session.dart';

/// Opens where a need was asked: a Swarm's conversation.
typedef SwarmOpen = void Function(String swarmId, String conversationId);

/// One thing a Swarm asks of the person, as a row of "Needs you": a decision
/// with its options, a Lead's tag with Done, or work waiting on them. A tap
/// on the row opens where it was asked.
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
    SwarmMentionNeed(:final mention) => _mentionRow(mention),
    SwarmWorkNeed(:final work) => SettingsRow(
      key: ValueKey('swarm-need-${need.key}'),
      title: work.status == 'blocked'
          ? '${work.agentName} is stuck'
          : '${work.agentName} needs you',
      detail: [
        _where(work.project.name, work.conversation.label),
        ?work.question,
      ].join('\n'),
      detailLines: 3,
      onTap: _open,
    ),
  };

  /// A Lead's tag with Done: "Done…" the moment it is tapped, gone once
  /// confirmed, and a failure said on the row.
  Widget _mentionRow(SuperTabMention mention) {
    final asks = session.inbox.asks(need.swarmId);
    final finishing = asks?.finishing(mention) ?? false;
    return SettingsRow(
      key: ValueKey('swarm-need-${need.key}'),
      title: '${mention.leadName} tagged you',
      detail: [
        _where(mention.projectName, mention.conversationTitle),
        if (mention.text.isNotEmpty) mention.text,
        ?asks?.notDone(mention),
      ].join('\n'),
      detailLines: 4,
      trailing: TtyTextButton(
        key: ValueKey('swarm-done-${mention.id}'),
        label: finishing ? 'Done…' : 'Done',
        onPressed: finishing ? null : () => unawaited(asks?.done(mention)),
      ),
      onTap: _open,
    );
  }
}

String _where(String project, String conversation) =>
    [project, conversation].where((part) => part.isNotEmpty).join(' · ');

/// A decision asked of the person: who asks, the question, and its options.
/// One tap on an option holds it for the session's Undo window, then sends
/// it — an answer cannot be changed once sent.
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
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final decision = need.decision;
    final secondary = TextStyle(
      color: AppPalette.textSecondary,
      fontSize: 12.5,
      height: 1.4,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 10, 13, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${decision.askerName} asks you',
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w500,
            ),
          ),
          if (_where(decision.projectName, decision.conversationTitle)
              case final where when where.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(where, style: secondary),
          ],
          const SizedBox(height: 8),
          Text(
            decision.question,
            style: TextStyle(color: AppPalette.textPrimary, fontSize: 15),
          ),
          if (decision.unblocks.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('Unblocks: ${decision.unblocks}', style: secondary),
          ],
          const SizedBox(height: 8),
          SwarmDecisionAnswer(session: session, need: need),
          if (onOpen != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TtyTextButton(
                label: 'Open chat',
                size: TtySize.meta,
                color: tty.dim,
                onPressed: onOpen,
              ),
            ),
        ],
      ),
    );
  }
}

/// What can be done with an open decision: its options, one tap holding the
/// answer for the session's Undo window, then how its sending goes. Stacked,
/// each option the whole width, as "Needs you" lists them — or [sideBySide],
/// sharing a row as a chat's card has them, the recommended one filled.
class SwarmDecisionAnswer extends StatelessWidget {
  const SwarmDecisionAnswer({
    super.key,
    required this.session,
    required this.need,
    this.sideBySide = false,
  });

  final SwarmSession session;
  final SwarmDecisionNeed need;
  final bool sideBySide;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final decision = need.decision;
    final asks = session.inbox.asks(need.swarmId);
    final held = session.held(need);
    final sending = asks?.answering.contains(decision.id) ?? false;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (held != null)
          Row(
            children: [
              Expanded(
                child: Text(
                  'Sending “${_option(decision.options, held)}”…',
                  key: ValueKey('swarm-held-${decision.id}'),
                  style: tty.style(color: tty.yellow, size: TtySize.meta),
                ),
              ),
              TtyTextButton(
                key: ValueKey('swarm-undo-${decision.id}'),
                label: 'Undo',
                onPressed: () => session.undo(need),
              ),
            ],
          )
        else if (sending)
          Text(
            'Sending…',
            style: tty.style(color: tty.dim, size: TtySize.meta),
          )
        // Sent, and maybe taken: only the same answer may go again.
        else if (asks?.unconfirmed(decision) case final choice?)
          Row(
            children: [
              Expanded(
                child: Text(
                  '“${_option(decision.options, choice)}” is not confirmed.',
                  style: tty.style(color: tty.yellow, size: TtySize.meta),
                ),
              ),
              TtyTextButton(
                key: ValueKey('swarm-resend-${decision.id}'),
                label: 'Send again',
                onPressed: () => unawaited(asks!.answer(decision, choice)),
              ),
            ],
          )
        else ...[
          if (session.dropped(need))
            Text(
              'Not sent, choose again.',
              key: ValueKey('swarm-dropped-${decision.id}'),
              style: tty.style(color: tty.yellow, size: TtySize.meta),
            ),
          if (sideBySide)
            _OptionRows(
              decision: decision,
              onTap: (index) => session.hold(need, index),
            )
          else
            for (final (index, option) in decision.options.indexed)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: _OptionButton(
                  key: ValueKey('swarm-option-${decision.id}-$index'),
                  label: index == decision.recommended
                      ? '$option (recommended)'
                      : option,
                  onTap: () => session.hold(need, index),
                ),
              ),
        ],
        if (asks?.error case final error?) ...[
          const SizedBox(height: 6),
          Text(
            error,
            style: tty.style(color: tty.red, size: TtySize.meta),
          ),
        ],
      ],
    );
  }
}

String _option(List<String> options, int index) =>
    index >= 0 && index < options.length ? options[index] : 'Option $index';

/// One option of a decision: the whole width, a 1px rule, the option's text.
class _OptionButton extends StatelessWidget {
  const _OptionButton({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(color: tty.faint),
        borderRadius: BorderRadius.circular(6),
      ),
      child: TtyTap(
        onTap: onTap,
        semanticsLabel: label,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Text(label, style: tty.style(size: TtySize.row)),
        ),
      ),
    );
  }
}

/// A decision's options side by side: as many to a row as fit at 120 wide
/// each, sharing it equally; the recommended one filled.
class _OptionRows extends StatelessWidget {
  const _OptionRows({required this.decision, required this.onTap});

  final SuperTabDecision decision;
  final ValueChanged<int> onTap;

  static const double _least = 120, _gap = 8;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final options = decision.options;
      final perRow = ((constraints.maxWidth + _gap) / (_least + _gap))
          .floor()
          .clamp(1, options.isEmpty ? 1 : options.length);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var first = 0; first < options.length; first += perRow)
            Padding(
              padding: EdgeInsets.only(top: first == 0 ? 0 : _gap),
              child: IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var i = first; i < first + perRow; i++) ...[
                      if (i > first) const SizedBox(width: _gap),
                      Expanded(
                        child: i < options.length
                            ? _SideOption(
                                key: ValueKey('swarm-option-${decision.id}-$i'),
                                label: options[i],
                                recommended: i == decision.recommended,
                                onTap: () => onTap(i),
                              )
                            : const SizedBox(),
                      ),
                    ],
                  ],
                ),
              ),
            ),
        ],
      );
    },
  );
}

/// One option in a row of them: rounded, raised, in the app's own face.
class _SideOption extends StatelessWidget {
  const _SideOption({
    super.key,
    required this.label,
    required this.recommended,
    required this.onTap,
  });

  final String label;
  final bool recommended;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: recommended ? '$label (recommended)' : label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 44),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: recommended ? AppPalette.accent : ttyRaised(tty),
            border: Border.all(
              color: recommended
                  ? Colors.transparent
                  : tty.text.withValues(alpha: 0.12),
            ),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: recommended ? Colors.white : AppPalette.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w500,
              height: 1.3,
            ),
          ),
        ),
      ),
    );
  }
}
