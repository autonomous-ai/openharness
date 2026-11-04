import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/swarm/swarm_lead_start.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// A Personal Swarm and the person's computers, for the phone's Start Lead
/// card (task #2941).

/// The person's computers a Lead can start on, as a test scripts them: each
/// start is remembered, and answers [started] or throws [failure].
class FakeLeadComputers extends ChangeNotifier implements SwarmLeadComputers {
  FakeLeadComputers(this.leadComputers);

  @override
  List<SwarmLeadComputer> leadComputers;

  final starts = <(String, SwarmLeadLaunch)>[];
  SuperTabFailure? failure;

  /// Holds a start until completed.
  Completer<void>? held;

  @override
  Future<SwarmLeadStarted> startLead(
    String machineId,
    SwarmLeadLaunch launch,
  ) async {
    starts.add((machineId, launch));
    await held?.future;
    if (failure case final failure?) throw failure;
    return (
      harnessId: 'harness-new',
      cwd: launch.folder ?? '/Users/me/Harness/Games-Lead',
      remote: launch.folder == null ? null : 'github.com/acme/games',
    );
  }
}

/// The repo the Personal project is made for, and that project's id as every
/// computer of the person's makes it (Desktop's personalProjectOperation).
const repo = 'github.com/acme/games';
final personal = swarmPersonalProjectOperation(repo);
const personalChat = 'project-personal';

SwarmLeadComputer computer(
  String id,
  String name, {
  List<String> engines = const ['claude', 'codex'],
  Map<String, String> folders = const {},
}) => (id: id, name: name, engines: engines, folders: folders);

/// A Swarm read with one project whose chat has [leadId] as its Lead, or none.
Map<String, dynamic> personalLoad({
  String name = 'Personal',
  String? leadId,
  List<String> people = const [me],
  String role = 'owner',
}) => {
  ...firstLoad(
    head: headData(
      name: name,
      projects: [
        {
          'id': personal,
          'name': 'games',
          'ownerId': me,
          'leadConversationId': personalChat,
          'visibility': 'private',
          'members': <Object>[],
          'updateMinutes': 5,
          'skillMode': 'default',
        },
      ],
    ),
    agents: [if (leadId != null) agent(leadId, name: 'Lead')],
    groups: [
      {
        ...groupData(
          personalChat,
          title: 'games',
          agentIds: [?leadId],
          leadId: leadId,
        ),
        'projectId': personal,
      },
      {...groupData('g-task', title: 'Fix it'), 'projectId': personal},
    ],
  ),
  'members': [
    for (final id in people)
      part(id, 1, person(id, role: id == me ? role : 'collaborator')),
  ],
};
