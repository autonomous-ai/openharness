import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_conversation.dart';

/// Whether [c], a project's channel, shows its owner that it has no Product
/// Manager, as Desktop's empty channel does (view.dart `_offersLead`): its
/// owner may write there, the channel is open, no PM New project asked for
/// is starting (`pmChatId`), and the Swarm lists none.
bool swarmOffersPm(SwarmConversation c) {
  final snapshot = c.reader.snapshot, group = c.conversation;
  if (!c.writes || snapshot == null || group == null || group.archived) {
    return false;
  }
  if (!snapshot.isProjectLead(group.id)) return false;
  final project = snapshot.projectFor(group.id);
  return project != null &&
      project.ownerId == c.reader.accountId &&
      project.pmChatId == null &&
      snapshot.leadOf(project.id) == null;
}

/// What a project's channel with no Product Manager shows its owner: the line
/// of Desktop's card (choose_pm.dart `SwarmPmChoose`). Its Choose PM is
/// Desktop's alone for now, and the phone starts no PM.
class SwarmPmChoose extends StatelessWidget {
  const SwarmPmChoose({super.key = const ValueKey('swarm-pm-choose')});

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: AppCard.base,
      borderRadius: BorderRadius.circular(AppCard.radius),
      border: Border.all(color: AppCard.hair),
    ),
    child: Padding(
      padding: const EdgeInsets.all(AppSpace.m),
      child: SizedBox(
        width: double.infinity,
        child: Text(
          'This project has no Product Manager.',
          style: AppType.body(color: AppPalette.textPrimary),
        ),
      ),
    ),
  );
}
