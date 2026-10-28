import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'decisions.dart';
import 'section_heading.dart';

/// The reader's decisions in the Notifications pane: what is open first, one
/// batch per ask, then the last few answered.
class SuperTabDecisionList extends StatelessWidget {
  const SuperTabDecisionList({super.key, required this.decisions});
  final SuperTabDecisions decisions;

  /// How many answered decisions stay in view.
  static const answeredShown = 5;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: decisions,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final d = decisions;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(12, 16, 12, 4),
            child: SuperTabSectionHeading('Decisions', endInset: 0),
          ),
          if (d.error case final error?) _note(error),
          if (d.open.isEmpty) _note('No decisions waiting for you.'),
          ..._batches(d),
          for (final answered in d.answered.take(answeredShown))
            SuperTabDecisionCard(decisions: d, decision: answered),
        ],
      );
    },
  );

  Iterable<Widget> _batches(SuperTabDecisions d) sync* {
    String? batch;
    for (final decision in d.open) {
      if (decision.batchId != batch) {
        batch = decision.batchId;
        final count = d.open.where((o) => o.batchId == batch).length;
        // The reader's own chat with the PM is named as the sidebar names it,
        // not by the reader's own name (as notifications.dart does).
        // With Buddies on there is no Chat with PM: it opens the project's
        // chat, and is named so.
        final c = d.controller;
        final place =
            c.pmChat(decision.projectId)?.id != decision.conversationId
            ? decision.conversationTitle
            : c.buddiesOn
            ? '#${decision.projectName}'
            : 'Chat with PM';
        yield _note(
          '${decision.askerName} asked $count '
          '${count == 1 ? 'question' : 'questions'} · '
          '${decision.projectName} · $place',
        );
      }
      yield SuperTabDecisionCard(decisions: d, decision: decision);
    }
  }

  static Widget _note(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
    child: Text(text, style: DesktopChrome.metadata()),
  );
}

/// The open decisions asked in one project, above its Chat with PM.
class SuperTabDecisionsPanel extends StatelessWidget {
  const SuperTabDecisionsPanel({
    super.key,
    required this.decisions,
    required this.projectId,
  });
  final SuperTabDecisions decisions;
  final String projectId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: decisions,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final open = decisions.openIn(projectId);
      if (open.isEmpty) return const SizedBox.shrink();
      return ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 320),
        child: ListView(
          key: const ValueKey('super-pm-decisions'),
          shrinkWrap: true,
          padding: const EdgeInsets.only(bottom: 8),
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(12, 12, 12, 4),
              child: SuperTabSectionHeading('Decisions for you', endInset: 0),
            ),
            for (final decision in open)
              SuperTabDecisionCard(decisions: decisions, decision: decision),
          ],
        ),
      );
    },
  );
}

/// One question: what it unblocks, and one button per option, the
/// recommended one marked. Answered, it shows the choice instead.
class SuperTabDecisionCard extends StatelessWidget {
  const SuperTabDecisionCard({
    super.key,
    required this.decisions,
    required this.decision,
  });
  final SuperTabDecisions decisions;
  final SuperTabDecision decision;

  @override
  Widget build(BuildContext context) {
    final choice = decision.choice;
    return Container(
      key: ValueKey('super-decision-${decision.id}'),
      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: DesktopChrome.surface,
        border: Border.all(color: DesktopChrome.rim),
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(decision.question, style: DesktopChrome.control(medium: true)),
          const SizedBox(height: 2),
          Text(
            'Unblocks: ${decision.unblocks}',
            style: DesktopChrome.metadata(),
          ),
          const SizedBox(height: 8),
          if (choice != null)
            Text(
              'You chose: ${decision.options.elementAtOrNull(choice) ?? ''}',
              style: DesktopChrome.control(color: DesktopChrome.muted),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                for (final (index, option) in decision.options.indexed)
                  _option(index, option),
              ],
            ),
        ],
      ),
    );
  }

  Widget _option(int index, String option) {
    final recommended = index == decision.recommended;
    final busy = decisions.answering.contains(decision.id);
    final onPressed = busy
        ? null
        : () => unawaited(decisions.answer(decision, index));
    final label = Text(recommended ? '$option · Recommended' : option);
    final key = ValueKey('super-decision-${decision.id}-$index');
    return recommended
        ? FilledButton.tonal(key: key, onPressed: onPressed, child: label)
        : OutlinedButton(key: key, onPressed: onPressed, child: label);
  }
}
