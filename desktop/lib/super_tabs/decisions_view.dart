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
        final place =
            d.controller.pmChat(decision.projectId)?.id ==
                decision.conversationId
            ? 'Chat with PM'
            : decision.conversationTitle;
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

/// The open decisions asked in one project, above its Chat with PM. Hide
/// and each card's Not now fold them into the one heading line until the
/// reader shows them again; a decision asked later shows.
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
      final shown = decisions.shownIn(projectId);
      final folded = shown.isEmpty;
      return ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 320),
        child: ListView(
          key: const ValueKey('super-pm-decisions'),
          shrinkWrap: true,
          padding: EdgeInsets.only(bottom: folded ? 0 : 8),
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(12, 12, 12, folded ? 0 : 4),
              child: SuperTabSectionHeading(
                'Decisions for you (${open.length})',
                endInset: 0,
                trailing: folded
                    ? quietDecisionAction(
                        key: const ValueKey('super-pm-decisions-show'),
                        label: 'Show',
                        onPressed: () => decisions.showAgain(projectId),
                      )
                    : quietDecisionAction(
                        key: const ValueKey('super-pm-decisions-hide'),
                        label: 'Hide',
                        onPressed: () => decisions.setAside(open),
                      ),
              ),
            ),
            for (final decision in shown)
              SuperTabDecisionCard(
                decisions: decisions,
                decision: decision,
                onNotNow: () => decisions.setAside([decision]),
              ),
          ],
        ),
      );
    },
  );
}

/// A borderless text action, quieter than the options beside it (design
/// system: quiet inline controls).
Widget quietDecisionAction({
  required Key key,
  required String label,
  required VoidCallback? onPressed,
}) => TextButton(
  key: key,
  onPressed: onPressed,
  style: TextButton.styleFrom(
    foregroundColor: DesktopChrome.muted,
    backgroundColor: Colors.transparent,
    side: BorderSide.none,
    minimumSize: const Size(0, 28),
    padding: const EdgeInsets.symmetric(horizontal: 6),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    textStyle: DesktopChrome.metadata(),
  ),
  child: Text(label),
);

/// One question: what it unblocks, one button per option, the recommended
/// one marked, and the quiet Let PM decide (only with a recommendation) and
/// Not now ([onNotNow], in Chat with PM). Answered, it shows the choice, or
/// that the PM decided.
class SuperTabDecisionCard extends StatelessWidget {
  const SuperTabDecisionCard({
    super.key,
    required this.decisions,
    required this.decision,
    this.onNotNow,
  });
  final SuperTabDecisions decisions;
  final SuperTabDecision decision;
  final VoidCallback? onNotNow;

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
              '${decision.delegated ? 'PM decided' : 'You chose'}: '
              '${decision.options.elementAtOrNull(choice) ?? ''}',
              style: DesktopChrome.control(color: DesktopChrome.muted),
            )
          else ...[
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                for (final (index, option) in decision.options.indexed)
                  _option(index, option),
              ],
            ),
            if (_later() case final later?) ...[
              const SizedBox(height: 4),
              later,
            ],
          ],
        ],
      ),
    );
  }

  /// Let PM decide · Not now, whichever of them this card offers.
  Widget? _later() {
    final busy = decisions.answering.contains(decision.id);
    final actions = [
      if (decision.canDelegate)
        quietDecisionAction(
          key: ValueKey('super-decision-${decision.id}-delegate'),
          label: 'Let PM decide',
          onPressed: busy
              ? null
              : () => unawaited(decisions.delegate(decision)),
        ),
      if (onNotNow != null)
        quietDecisionAction(
          key: ValueKey('super-decision-${decision.id}-later'),
          label: 'Not now',
          onPressed: busy ? null : onNotNow,
        ),
    ];
    if (actions.isEmpty) return null;
    return Transform.translate(
      // The actions' text lines up with the question above.
      offset: const Offset(-6, 0),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (final (index, action) in actions.indexed) ...[
            if (index > 0) Text('·', style: DesktopChrome.metadata()),
            action,
          ],
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
