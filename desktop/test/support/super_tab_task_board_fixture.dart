import 'super_tab_fixture.dart';

/// The instant the task board's fixture is "now": its groups were last active this long before it.
final taskBoardNow = DateTime.utc(2026, 10, 22, 12);

const taskBoardRepo = 'https://github.com/autonomous-ai/openharness/pull';

/// One workgroup as the Swarm carries it: [status] is its assignment's (null: no assignment yet), [ago] how long
/// before [taskBoardNow] it was last active (null: the backend did not say), [evidence] a check's evidence text.
Map<String, dynamic> taskGroup(
  int number,
  String title,
  String? status, {
  String agent = 'atlas',
  Duration? ago,
  String? result,
  String? evidence,
  bool archived = false,
  String project = 'lead',
}) => {
  ...conversationFixture('task-$number', title),
  'number': number,
  'projectId': project,
  'agentIds': [agent],
  'archived': archived,
  'checks': [
    if (evidence != null)
      {
        'id': 'c$number',
        'description': 'Tests pass',
        'independent': false,
        'evidence': evidence,
        'passedBy': agent,
      },
  ],
  if (ago != null)
    'lastActivityAt': taskBoardNow.subtract(ago).millisecondsSinceEpoch,
  'assignment': status == null
      ? null
      : {
          'id': 'attempt-$number',
          'agentId': agent,
          'status': status,
          'configuration': {'engine': 'codex'},
          'execution': {
            'machineId': 'm',
            'harnessId': 'native-$agent',
            'machineOwnerId': 'owner',
          },
          'result': result,
        },
};

/// A Swarm whose project "Harness" has [groups] beside its lead, and four agents on one machine.
void taskBoard(ConversationServer server, List<Map<String, dynamic>> groups) {
  server.state['agents'] = [
    for (final (id, name) in [
      ('atlas', 'Atlas'),
      ('sage', 'Sage'),
      ('nova', 'Nova'),
      ('finn', 'Finn'),
    ])
      {
        'id': id,
        'name': name,
        'displayName': name,
        'machineId': 'm',
        'harnessId': 'native-$id',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
  ];
  server.state['projects'] = [projectFixture('lead', 'Harness', 'lead')];
  server.state['conversations'] = [
    {...conversationFixture('lead', 'Lead'), 'projectId': 'lead'},
    ...groups,
  ];
}

/// The answer of the local GitHub reader for [urls]: each pull request by its number's entry in [states]
/// (state, then how many of its five checks have passed), or "not found" for one it does not know.
Map<String, dynamic> pullRequestRows(
  List<String> urls,
  Map<int, (String, int)> states,
) => {
  'rows': [
    for (final url in urls)
      if (states[int.parse(url.split('/').last)] case (
        final state,
        final passed,
      ))
        {
          'url': url,
          'status': 'found',
          'state': state,
          'title': 'PR ${url.split('/').last}',
          'mergeStateStatus': state == 'Open' ? 'CLEAN' : 'UNKNOWN',
          'checks': {
            'passed': passed,
            'failed': 0,
            'pending': 5 - passed,
            'total': 5,
          },
        }
      else
        {'url': url, 'status': 'unavailable'},
  ],
};
