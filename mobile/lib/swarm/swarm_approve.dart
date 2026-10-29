import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_inbox.dart';
import 'swarm_style.dart';

/// Asks before [option] is sent as the answer to [need]: who asked, where,
/// and the question, and that it can still be undone. True once the person
/// confirms; the caller then holds the answer for Undo and sends it
/// ([SwarmSession.hold]). The review's gap list (2026-10-29): Approve asks
/// before acting everywhere. Activity's Approve asks the same, in the same
/// words (Theo's `confirmSwarmApprove`); the Tasks rows ask this.
Future<bool> confirmSwarmApprove(
  BuildContext context,
  SwarmDecisionNeed need,
  String option,
) async {
  final decision = need.decision;
  final where = decision.projectName.isEmpty
      ? ''
      : ' in #${decision.projectName}';
  final yes = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(
        'Approve?',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Text(
        'Sends “$option” to ${decision.askerName}$where: '
        '${decision.question}\n\nYou can undo it for a few seconds.',
        style: AppType.body(color: AppPalette.textSecondary),
      ),
      actions: [
        SwarmButton(
          key: const ValueKey('swarm-activity-approve-cancel'),
          label: 'Cancel',
          style: SwarmButtonStyle.link,
          onPressed: () => Navigator.of(context).pop(false),
        ),
        SwarmButton(
          key: const ValueKey('swarm-activity-approve-confirm'),
          label: 'Approve',
          style: SwarmButtonStyle.fill,
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ],
    ),
  );
  return yes ?? false;
}
