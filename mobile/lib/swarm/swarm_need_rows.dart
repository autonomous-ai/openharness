import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../phone/settings_row.dart';
import '../phone/tty.dart';
import '../phone/tty_controls.dart';
import '../shared/theme/app_theme.dart';
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
    SwarmMentionNeed(:final mention) => SettingsRow(
      key: ValueKey('swarm-need-${need.key}'),
      title: swarmNeedTitle(need),
      detail: [
        _where(mention.projectName, mention.conversationTitle),
        if (mention.text.isNotEmpty) mention.text,
      ].join('\n'),
      detailLines: 3,
      trailing: TtyTextButton(
        key: ValueKey('swarm-done-${mention.id}'),
        label: 'Done',
        onPressed: () =>
            unawaited(session.inbox.asks(need.swarmId)?.done(mention)),
      ),
      onTap: _open,
    ),
    SwarmWorkNeed(:final work) => SettingsRow(
      key: ValueKey('swarm-need-${need.key}'),
      title: swarmNeedTitle(need),
      detail: [
        _where(work.project.name, work.conversation.label),
        ?work.question,
      ].join('\n'),
      detailLines: 3,
      onTap: _open,
    ),
  };
}

String _where(String project, String conversation) =>
    [project, conversation].where((part) => part.isNotEmpty).join(' · ');

/// Who asks, in a few words: "River asks you", "Nova is stuck".
String swarmNeedTitle(SwarmNeed need) => switch (need) {
  SwarmDecisionNeed(:final decision) => '${decision.askerName} asks you',
  SwarmMentionNeed(:final mention) => '${mention.leadName} tagged you',
  SwarmWorkNeed(:final work) =>
    work.status == 'blocked'
        ? '${work.agentName} is stuck'
        : '${work.agentName} needs you',
};

/// A need on Swarm Home while another is open there: who asks and one line
/// of what, a tap to open it in its place. A decision whose answer is held
/// for Undo says so.
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
          'Sending “${_option(decision.decision.options, choice)}”…',
        null => decision.decision.question,
      },
      SwarmMentionNeed(:final mention) =>
        mention.text.isNotEmpty
            ? mention.text
            : _where(mention.projectName, mention.conversationTitle),
      SwarmWorkNeed(:final work) =>
        work.question ?? _where(work.project.name, work.conversation.label),
    };
    return SettingsRow(
      title: swarmNeedTitle(need),
      detail: line.isEmpty ? null : line,
      detailLines: 1,
      trailing: Icon(
        LucideIcons.chevronDown300,
        size: 20,
        color: AppPalette.textFaint,
      ),
      onTap: onTap,
    );
  }
}

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
    final asks = session.inbox.asks(need.swarmId);
    final held = session.held(need);
    final sending = asks?.answering.contains(decision.id) ?? false;
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
            swarmNeedTitle(need),
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
