import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';

/// A group's partner (collaboration protocol): the person its work needs for
/// judgement, taste, knowledge or hands, named beside its Engineer.

/// "Engineer: Atlas · Partner: dee"; null while the group has no partner, or
/// names one no longer in the Swarm.
String? superTabPartnerLine(
  SuperTabSnapshot snapshot,
  SuperTabConversation group,
) {
  final partner = snapshot.people
      .where((p) => p.id == group.partnerId)
      .firstOrNull;
  if (partner == null) return null;
  final engineer = group.assignment?['agentId'];
  return [
    if (engineer is String) 'Engineer: ${snapshot.agentName(engineer)}',
    'Partner: ${superTabPersonName(partner.email)}',
  ].join(' · ');
}

/// Picks [group]'s partner from the people who read it, or none.
Future<void> showSuperTabPartner(
  BuildContext context,
  SuperTabController c,
  SuperTabConversation group,
) async {
  final readers = c.snapshot?.readersOf(group) ?? const <SuperTabPerson>[];
  final project = c.snapshot?.projects
      .where((p) => p.id == group.projectId)
      .firstOrNull;
  Widget option(String? id, String name, String? detail) => SimpleDialogOption(
    onPressed: () => Navigator.pop(context, (id: id)),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, style: DesktopChrome.control()),
              if (detail != null) Text(detail, style: DesktopChrome.metadata()),
            ],
          ),
        ),
        if (id == group.partnerId) const Icon(Icons.check, size: 16),
      ],
    ),
  );
  final chosen = await showAppDialog<({String? id})>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      conversationId: group.id,
      child: SimpleDialog(
        key: const ValueKey('super-partner-picker'),
        title: const Text('Partner'),
        children: [
          option(null, 'No partner', null),
          for (final person in readers)
            option(
              person.id,
              superTabPersonName(person.email),
              // What they cover, to pick by; else who they are.
              project?.areas[person.id]?.join(', ') ?? person.email,
            ),
        ],
      ),
    ),
  );
  if (chosen == null || chosen.id == group.partnerId) return;
  await c.command({
    'type': 'conversation.partner',
    'conversationId': group.id,
    'personId': chosen.id,
  });
}
