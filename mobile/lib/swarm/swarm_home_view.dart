import 'model.dart';

/// One Swarm as Home last drew it: a state [SuperTabSnapshot.fromJson] reads,
/// thinned to what Home, its drawer and a project's rows draw, and each
/// conversation's partner ([swarmPartners]).
typedef SwarmHomeSwarm = ({
  Map<String, dynamic> state,
  Map<String, String> partners,
});

/// [snapshot] thinned to what Home draws: its projects, its agents by name,
/// engine and status, each conversation's title, project, people and work
/// status, and the built-in pictures people and agents wear. Nothing a chat
/// holds — no message, brief, check, task, question or email, no photo or
/// status — nor machines, starts or what waits on the person, which come
/// with the next read.
SwarmHomeSwarm swarmHomeSwarm(
  SuperTabSnapshot snapshot,
  Map<String, String> partners,
) => (
  state: {
    'version': 1,
    'id': snapshot.id,
    'name': snapshot.name,
    'ownerId': snapshot.ownerId,
    'paused': snapshot.paused,
    'leadsConversationId': ?snapshot.leadsConversationId,
    'projects': [for (final p in snapshot.projects) _project(p)],
    'people': [
      for (final p in snapshot.people)
        {'id': p.id, 'email': '', 'role': p.role, 'avatar': ?_preset(p.avatar)},
    ],
    'agents': [for (final a in snapshot.agents) _agent(a)],
    'conversations': [for (final c in snapshot.conversations) _conversation(c)],
    'machines': const <Object>[],
    'starts': const <Object>[],
    'invitations': const <Object>[],
  },
  partners: {...partners},
);

/// A built-in picture by its name. An uploaded one is not kept: its signed
/// link opens the picture, and comes again with the next read.
Map<String, dynamic>? _preset(SuperTabAvatarPicture? avatar) =>
    switch (avatar) {
      SuperTabPresetAvatar(:final key) => {'kind': 'preset', 'key': key},
      _ => null,
    };

Map<String, dynamic> _project(SuperTabProject p) => {
  'id': p.id,
  'name': p.name,
  'ownerId': p.ownerId,
  'leadConversationId': p.leadConversationId,
  'visibility': p.isPrivate ? 'private' : 'public',
  'members': [
    for (final id in p.memberIds) {'id': id},
  ],
  'skillMode': p.skillMode,
  'skillSet': p.skillSet,
  'updateMinutes': p.updateMinutes,
};

Map<String, dynamic> _agent(SuperTabAgent a) => {
  'id': a.id,
  'projectId': a.hasProjectId ? a.projectId : null,
  'name': a.name,
  'displayName': ?a.displayName,
  'machineId': a.machineId,
  'harnessId': a.harnessId,
  'contributorId': a.contributorId,
  'machineOwnerId': a.machineOwnerId,
  'role': ?a.role,
  'roleId': ?a.roleId,
  'limitedUntil': ?a.limitedUntil?.toIso8601String(),
  'downSince': ?a.downSince?.toIso8601String(),
  'avatar': ?_preset(a.avatar),
  'configuration': {
    for (final key in const ['engine', 'model', 'effort'])
      if (a.configuration[key] case final String value) key: value,
  },
};

Map<String, dynamic> _conversation(SuperTabConversation c) => {
  'id': c.id,
  'projectId': c.projectId,
  'number': ?c.number,
  'title': c.title,
  'leadId': ?c.leadId,
  'agentIds': c.agentIds,
  'archived': c.archived,
  'dormant': c.dormant,
  if (c.audience case final people?)
    'audience': {
      'people': [
        for (final id in people) {'id': id},
      ],
    },
  'brief': '',
  if (c.assignment case final work?)
    'assignment': {
      'id': work['id'],
      'agentId': work['agentId'],
      'status': work['status'],
    },
};
