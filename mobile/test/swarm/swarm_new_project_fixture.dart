import 'dart:async';

import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// New project's Swarms as a test scripts them: their machines, projects and
/// commands (swarm_new_project_test.dart, swarm_new_project_shots_test.dart).

/// Half an hour after the fixture's parts last changed, as Home reads it: no
/// project is quiet. Every machine reading here is measured from it.
final newProjectNow = DateTime.fromMillisecondsSinceEpoch(
  0,
  isUtc: true,
).add(const Duration(minutes: 30, seconds: 1));

/// A reading [ago] before [newProjectNow], in epoch milliseconds.
int _at(Duration ago) => newProjectNow.subtract(ago).millisecondsSinceEpoch;

const harnessRepo = 'https://github.com/autonomous-ai/openharness';
const lampRepo = 'https://github.com/autonomous-ai/lampos';

/// A machine of the Swarm as the backend reads it, with its derived values
/// over it: [contributor]'s, reporting [ago], offering [engines], its Harness
/// able to start a Product Manager unless not [capable], [slots] agents free.
Map<String, dynamic> leadPool(
  String id, {
  String? name,
  String contributor = me,
  List<String> engines = const ['claude', 'codex'],
  bool capable = true,
  int slots = 2,
  Duration ago = const Duration(seconds: 5),
  Map<String, dynamic>? lead,
  List<Map<String, dynamic>> readiness = const [],
  List<Map<String, dynamic>> quotas = const [],
  String deviceType = 'Mac Studio',
  bool paused = false,
  Map<String, String>? suspended,
}) => {
  'machineId': id,
  'name': name ?? '$id.local',
  'contributorId': contributor,
  'engines': engines,
  'maxAgents': 4,
  'cwd': '/Users/someone/swarm',
  'paused': ?(paused ? true : null),
  'observation': {
    'receivedAt': _at(ago),
    'capabilities': [if (capable) 'leadStart'],
    'readiness': {'engines': readiness},
    'quotas': quotas,
    'resources': {'deviceType': deviceType},
  },
  'availableSlots': slots,
  'teamWork': {'allowed': true},
  'lead': ?lead,
  'suspendedEngines': ?suspended,
};

/// A project of the Swarm, its repository [repo].
Map<String, dynamic> swarmProject(
  String id,
  String name, {
  String? repo,
  String visibility = 'public',
}) => {
  'id': id,
  'name': name,
  'ownerId': me,
  'leadConversationId': id == project ? leadChat : 'lead-$id',
  'visibility': visibility,
  'members': <Object>[],
  'updateMinutes': 5,
  if (repo != null)
    'repository': {
      'machineId': 'mac-1',
      'cwd': '/Users/someone/swarm/$name',
      'repositoryUrl': repo,
    },
};

/// A snapshot of one Swarm with [machines], read by [me].
SuperTabSnapshot leadSnapshot(
  List<Map<String, dynamic>> machines, {
  bool paused = false,
  List<Map<String, dynamic>> people = const [],
}) => SuperTabSnapshot.fromJson({
  'version': 1,
  'id': tab,
  'name': 'Phone Swarm',
  'ownerId': me,
  'paused': paused,
  'projects': [swarmProject(project, 'Mobile', repo: harnessRepo)],
  'people': [person(me), ...people],
  'agents': <Object>[],
  'machines': machines,
  'conversations': <Object>[],
  'invitations': <Object>[],
});

/// One scripted Swarm the sheet creates projects in: its projects, its
/// person's role, its machines, and what each command answers. A project made
/// is in every read after it, with its chat.
class NewProjectSwarm {
  NewProjectSwarm({
    this.id = tab,
    this.name = 'Phone Swarm',
    this.role = 'owner',
    List<Map<String, dynamic>>? machines,
    List<Map<String, dynamic>>? projects,
  }) : machines = machines ?? [leadPool('mac-1', name: 'Studio.local')],
       projects =
           projects ??
           [
             swarmProject(project, 'Mobile', repo: harnessRepo),
             swarmProject('project-2', 'Lamp', repo: lampRepo),
           ];

  final String id, name;
  String role;
  List<Map<String, dynamic>> machines;
  final List<Map<String, dynamic>> projects;
  Map<String, dynamic>? policy;

  /// When each project's chat last changed, by project; else the earlier in
  /// [projects], the more recent.
  final activity = <String, int>{};

  /// Its reads fail, as a Swarm that does not answer.
  bool unreadable = false;

  /// The person's access to it is taken away: every read is refused.
  bool revoked = false;

  static Never _refused() => throw const SuperTabFailure(
    'FORBIDDEN',
    'You no longer have access to this Swarm.',
    statusCode: 403,
  );

  /// Answers a command in place of the Swarm when it returns non-null:
  /// throws to refuse it, or a future to hold its answer.
  FutureOr<Object?>? Function(Map<String, dynamic> command)? answer;

  /// Every command body sent, with its operation id.
  final sent = <Map<String, dynamic>>[];

  List<Map<String, dynamic>> commands(String type) => [
    for (final body in sent)
      if ((body['command'] as Map)['type'] == type) body,
  ];

  Map<String, dynamic> _load() {
    if (revoked) _refused();
    if (unreadable) {
      throw const SuperTabFailure(
        'SERVER_ERROR',
        'Could not read this Swarm.',
        statusCode: 503,
      );
    }
    return {
      ...firstLoad(
        tabId: id,
        head: headData(id: id, name: name, projects: projects),
        machines: machines,
      ),
      'members': [part(me, 1, person(me, role: role))],
      // Each project's chat, its Product Manager's in Mobile.
      'groups': [
        for (final (i, p) in projects.indexed)
          {
            ...part(p['leadConversationId'] as String, 1, {
              ...groupData(
                p['leadConversationId'] as String,
                title: p['name'] as String,
                agentIds: [if (p['id'] == project) 'agent-lead'],
                leadId: p['id'] == project ? 'agent-lead' : null,
              ),
              'projectId': p['id'],
            }),
            'changedAt': activity[p['id']] ?? 1000 - i,
          },
      ],
    };
  }

  void install(FakeSwarm fake) {
    fake.routes['/api/super-tabs/$id/parts'] = (_) => _load();
    // Every change read loads afresh: what changed is all here.
    fake.routes['/api/super-tabs/$id/changes'] = (_) =>
        revoked ? _refused() : {'reload': true};
    fake.routes['/api/super-tabs/$id/routing-policy'] = (_) => {
      'policy': policy,
    };
    fake.routes['/api/super-tabs/$id/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$id/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$id/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    fake.routes['/api/super-tabs/$id/commands'] = (body) async {
      sent.add(body!);
      final command = body['command'] as Map<String, dynamic>;
      if (answer?.call(command) case final answered?) {
        final value = await answered;
        if (value != null) return value;
      }
      final operation = body['operationId'] as String;
      switch (command['type']) {
        case 'project.create':
          final made = 'p-$operation';
          if (!projects.any((p) => p['id'] == made)) {
            projects.add({
              ...swarmProject(made, command['name'] as String),
              'leadConversationId': 'project-$made',
              'visibility': command['visibility'],
            });
          }
          return {
            'result': {'projectId': made, 'conversationId': 'project-$made'},
          };
        case 'project.rename':
          final named = projects.firstWhere(
            (p) => p['id'] == command['projectId'],
          );
          named['name'] = command['name'];
          return {'result': <String, dynamic>{}};
        case 'lead.start':
          return {
            'result': {'startId': operation, 'machineId': command['machineId']},
          };
        default:
          return {'result': <String, dynamic>{}};
      }
    };
  }
}

/// The backend of [swarms], listed in order.
FakeSwarm newProjectBackend(List<NewProjectSwarm> swarms) {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      for (final s in swarms) {'id': s.id, 'name': s.name, 'ownerId': me},
    ],
    'next': null,
  };
  for (final s in swarms) {
    s.install(fake);
  }
  return fake;
}
