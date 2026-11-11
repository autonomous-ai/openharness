import 'dart:convert';
import 'dart:io';

import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/instructions_link.dart';
import 'package:harness/ws/ws_conn.dart';

import 'super_tab_swarm.dart' show swarm;
import 'super_tab_fixture.dart';

/// Swarm v4's review data: lampOS's agents and real posts from the week of 26 October 2026, laid out the v4 way. The
/// first builder is the PM; each task is a thread in the channel; each agent has its own chat with its person.
ConversationServer swarmV4Server() {
  final server = swarm()..threads = true;
  final groups = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  Map<String, dynamic> agent(
    String id,
    String kind, {
    String owner = 'owner',
  }) => {
    'id': id,
    'projectId': 'lead',
    'name': id,
    'displayName': id,
    'machineId': 'host',
    'harnessId': 'session-$id',
    'contributorId': owner,
    'configuration': {'engine': id == 'reviewer-two' ? 'codex' : 'claude'},
    'kind': kind,
    'chatId': 'agent-chat-$id',
    'myAgent': owner == 'owner',
  };
  final mine = ['first builder', 'second', 'third', 'reviewer-two'];
  final others = ['seventh', 'friday', 'el', 'fourteen', 'thirteen', 'ten'];
  server.state['agents'] = [
    for (final id in mine) agent(id, id == 'first builder' ? 'pm' : 'regular'),
    for (final id in others) agent(id, 'regular', owner: 'teammate'),
  ];
  for (final id in mine) {
    groups.add({
      ...conversationFixture('agent-chat-$id', id),
      'kind': 'agent-chat',
      'agentIds': [id],
    });
  }
  final lead = groups.firstWhere((g) => g['id'] == 'lead');
  lead['leadId'] = 'first builder';
  lead['title'] = 'lampos';
  (server.state['projects'] as List).first['name'] = 'lampos';
  // Its tasks are this repository's GitHub issues (Swarm v4, 2026-11-09), read with gh: swarmV4GitHub below.
  (server.state['projects'] as List).first['repository'] = {
    'repositoryUrl': 'https://github.com/autonomous-ai/lampOS',
  };
  (server.state['projects'] as List).add(
    projectFixture('harness', 'openharness', 'harness-lead'),
  );
  groups.add({
    ...conversationFixture('harness-lead', 'openharness'),
    'projectId': 'harness',
  });

  String say(String chat, String who, String text, {String? thread}) {
    server.append(text, conversationId: chat);
    final message = server.messages.last;
    message['author'] = {
      'kind': who == 'Dee' ? 'person' : 'agent',
      'id': who == 'Dee' ? 'owner' : who,
      'name': who,
    };
    if (thread != null) {
      message['thread'] = thread;
      message['replyTo'] = thread;
    }
    return message['id'] as String;
  }

  // The channel: real lampOS posts, 28 October.
  say(
    'lead',
    'first builder',
    'Plan for today: the busy room first, then memory. Lists are three deep.',
  );
  say(
    'lead',
    'fourteen',
    '@ten Taking a read of #3931. The signature check is the part I want to try to break.',
  );
  say(
    'lead',
    'reviewer-two',
    '@second #3913 read posted: no source P1/P2, twenty fresh module passes and verified Linux. I am taking #3543 next.',
  );
  say(
    'lead',
    'friday',
    '@el Your 06c1 hold ran to 02:45. Is lamp-06c1 released? I have a short memory retest waiting, 60 min at most.',
  );
  final task = say(
    'lead',
    'first builder',
    '#2191 The voice declines in a busy room even when called by name and faced. @seventh yours: LAMP_NAMED_ALWAYS on in the product.',
  );
  say(
    'lead',
    'seventh',
    '@reviewer-lead Review, please: #4905 at f2a0313eee turns LAMP_NAMED_ALWAYS on in the product.',
    thread: task,
  );
  say(
    'lead',
    'first builder',
    'Changes asked at f2a0313ee. A played rerun on today\'s build first, on lamp-4ace at 18:00. I lift this with a READ-OK if desk talk isn\'t worse.',
    thread: task,
  );
  say(
    'lead',
    'seventh',
    'The sw2 sitting on lamp-52e6 is VOID, the kit\'s fault: the colleague clips never made the voice judge the room busy.',
    thread: task,
  );
  say(
    'lead',
    'first builder',
    'Lifting my HOLD. Reran on lamp-4ace, off at 18:16, on at 18:35. Desk talk left alone: 6/6 off, 6/6 on.',
    thread: task,
  );
  say('lead', 'seventh', 'Merged #4905 in train 549.', thread: task);
  final memory = say(
    'lead',
    'first builder',
    '#3923 A line\'s opening "Lamp" is missed by speech-to-text and the name detector. @thirteen yours. Measure first, per clip.',
  );
  say(
    'lead',
    'thirteen',
    'Measured 40 clips: the opening word is lost in 11, all under 180 ms of silence before it.',
    thread: memory,
  );
  say(
    'lead',
    'thirteen',
    '@reviewer-two Ready for a read: #3981 keeps 250 ms of audio before the first word.',
    thread: memory,
  );
  say(
    'lead',
    'friday',
    '@first builder Heads up on #3706: with #3564 landed, "ask once, then a seen yes" changes when a wipe is marked, so its test changes too.',
  );
  say(
    'lead',
    'seventh',
    '@eighth Taking the second read of #3879 at d0bf35bb2.',
  );

  // A person's own chats with their agents.
  say(
    'agent-chat-second',
    'Dee',
    'you own voice on lampos. privacy beats speed, every time.',
  );
  say('agent-chat-second', 'second', 'Written to agents/second.md and pushed.');
  say(
    'agent-chat-first builder',
    'Dee',
    'v2 is a lamp you can chat with at your desk. voice first, then camera and memory. ship by 20 nov.',
  );
  say(
    'agent-chat-first builder',
    'first builder',
    'Written to agents/first-builder.md. Six tasks are up; every list is three deep.',
  );
  return server;
}

/// What `gh` answers for lampOS's issues in these tests, as GitHub's GraphQL does: three open tasks (one nobody has, one for
/// the seventh builder, one the first builder is on), and #5759's text with its newest two comments, signed by their agents as
/// lampOS's builders sign them, and one before them. Every other call fails as an unknown issue does, and every call while
/// [signedOut] says so fails as a `gh` that is not signed in does.
SwarmGitHub swarmV4GitHub({
  List<List<String>>? calls,
  bool Function()? signedOut,
  // The checks at the head of #5770, first builder's pull request for #5759.
  String firstBuilderChecks = 'SUCCESS',
}) => SwarmGitHub(
  run: (arguments) async {
    calls?.add(arguments);
    if (signedOut?.call() ?? false) {
      return ProcessResult(
        0,
        4,
        '',
        'To get started with GitHub CLI, please run:  gh auth login',
      );
    }
    final query = arguments
        .firstWhere((a) => a.startsWith('query='), orElse: () => '')
        .substring(6);
    const url = 'https://github.com/autonomous-ai/lampOS/issues';
    Map<String, Object?> issue(int number, String title, String updated) => {
      'number': number,
      'title': title,
      'url': '$url/$number',
      'createdAt': '2026-11-09T01:00:00Z',
      'updatedAt': updated,
    };
    Map<String, Object?> label(String name, String color) => {
      'name': name,
      'color': color,
    };
    Map<String, Object?> comment(int n, String who, String body, String at) => {
      'author': {'login': who},
      'body': body,
      'createdAt': at,
      'url': '$url/5759#issuecomment-$n',
    };
    ProcessResult answer(Object? data) =>
        ProcessResult(1, 0, jsonEncode({'data': data}), '');
    if (query.contains('issues(first:')) {
      return answer({
        'repository': {
          'issues': {
            'pageInfo': {'hasNextPage': false, 'endCursor': null},
            'nodes': [
              {
                ...issue(
                  5754,
                  'No bathroom-break reminder skill ships',
                  '2026-11-09T06:05:08Z',
                ),
                'labels': {
                  'nodes': [label('builder:seventh', '0e8a16')],
                },
                'author': {'login': 'deehw'},
                'comments': {'totalCount': 6},
              },
              {
                ...issue(
                  5759,
                  'The two update rows were scored down for #5539 and #5476',
                  '2026-11-09T07:20:06Z',
                ),
                'labels': {
                  'nodes': [
                    label('status:taken', 'fbca04'),
                    label('builder:first builder', '1d76db'),
                  ],
                },
                'author': {'login': '69tc'},
                'comments': {'totalCount': 3},
              },
              {
                ...issue(
                  5760,
                  'Play your music through Spotify by voice',
                  '2026-11-09T05:00:00Z',
                ),
                'labels': {'nodes': <Object?>[]},
                'author': {'login': 'deehw'},
                'comments': {'totalCount': 0},
              },
            ],
          },
        },
      });
    }
    // One open pull request, for 5759: green, with a READ-OK on its head from a reader other than its builder.
    if (query.contains('pullRequests(')) {
      return answer({
        'repository': {
          'defaultBranchRef': {'name': 'main'},
          'pullRequests': {
            'nodes': [
              {
                'number': 5770,
                'title': 'Score the update rows again',
                'url': 'https://github.com/autonomous-ai/lampOS/pull/5770',
                'isDraft': false,
                'headRefName': 'first-builder/5759',
                'headRefOid': 'f6edb44a1b2c3d4e5f60718293a4b5c6d7e8f901',
                'baseRefName': 'main',
                'body': 'Closes #5759',
                'mergeable': 'MERGEABLE',
                'labels': {
                  'nodes': [
                    {'name': 'builder:first builder'},
                  ],
                },
                'closingIssuesReferences': {
                  'nodes': [
                    {'number': 5759},
                  ],
                },
                'commits': {
                  'nodes': [
                    {
                      'commit': {
                        'statusCheckRollup': {'state': firstBuilderChecks},
                      },
                    },
                  ],
                },
                'comments': {
                  'nodes': [
                    {
                      'body': 'Migrate, 10:05 GMT+7: READ-OK f6edb44',
                      'createdAt': '2026-11-09T03:05:00Z',
                      'authorAssociation': 'MEMBER',
                      'author': {'login': '69tc'},
                    },
                  ],
                },
              },
              // No task's, as most of lampOS's builder pull requests are: its CI check failed.
              {
                'number': 5771,
                'title': 'Bump gh in CI to 2.62',
                'url': 'https://github.com/autonomous-ai/lampOS/pull/5771',
                'isDraft': false,
                'headRefName': 'seventh/ci-gh',
                'headRefOid': 'a1b2c3d4e5f60718293a4b5c6d7e8f9011223344',
                'baseRefName': 'main',
                'body':
                    'The runners carry gh 2.40, which lacks --json for runs.',
                'mergeable': 'MERGEABLE',
                'updatedAt': '2026-11-09T07:10:00Z',
                'labels': {
                  'nodes': [
                    {'name': 'builder:seventh'},
                  ],
                },
                'closingIssuesReferences': {'nodes': <Object?>[]},
                'commits': {
                  'nodes': [
                    {
                      'commit': {
                        'statusCheckRollup': {'state': 'FAILURE'},
                      },
                    },
                  ],
                },
                'comments': {'nodes': <Object?>[]},
              },
              // Green, and nobody has read it yet.
              {
                'number': 5772,
                'title': 'Say the update rows out loud',
                'url': 'https://github.com/autonomous-ai/lampOS/pull/5772',
                'isDraft': false,
                'headRefName': 'eighth/rows-say',
                'headRefOid': 'b2c3d4e5f60718293a4b5c6d7e8f901122334455',
                'baseRefName': 'main',
                'body': 'The rows are said once they are scored.',
                'mergeable': 'MERGEABLE',
                'updatedAt': '2026-11-09T07:00:00Z',
                'labels': {
                  'nodes': [
                    {'name': 'builder:eighth'},
                  ],
                },
                'closingIssuesReferences': {'nodes': <Object?>[]},
                'commits': {
                  'nodes': [
                    {
                      'commit': {
                        'statusCheckRollup': {'state': 'SUCCESS'},
                      },
                    },
                  ],
                },
                'comments': {'nodes': <Object?>[]},
              },
              // Harness's train, carrying #5770: its checks run on the combined change.
              {
                'number': 5773,
                'title': 'Train: #5770',
                'url': 'https://github.com/autonomous-ai/lampOS/pull/5773',
                'isDraft': false,
                'headRefName': 'harness-train/1794363575848',
                'headRefOid': 'c3d4e5f60718293a4b5c6d7e8f90112233445566',
                'baseRefName': 'main',
                'body': "Harness's train into main, built to c3d4e5f60718293a4b5c6d7e8f90112233445566.",
                'mergeable': 'MERGEABLE',
                'updatedAt': '2026-11-09T07:20:00Z',
                'labels': {'nodes': <Object?>[]},
                'closingIssuesReferences': {'nodes': <Object?>[]},
                'commits': {
                  'nodes': [
                    {
                      'commit': {
                        'statusCheckRollup': {'state': 'PENDING'},
                      },
                    },
                  ],
                },
                'comments': {'nodes': <Object?>[]},
              },
            ],
          },
        },
      });
    }
    // #5770's own chat, as GitHub's pullRequest answers it: its text, a READ-OK, and a review that is one line comment.
    if (query.contains('pullRequest(number:') &&
        arguments.contains('number=5770')) {
      return answer({
        'repository': {
          'pullRequest': {
            'number': 5770,
            'title': 'Score the update rows again',
            'url': 'https://github.com/autonomous-ai/lampOS/pull/5770',
            'createdAt': '2026-11-09T02:40:00Z',
            'updatedAt': '2026-11-09T03:05:00Z',
            'author': {'login': '69tc'},
            'labels': {
              'nodes': [
                {'name': 'builder:first builder', 'color': '1d76db'},
              ],
            },
            'body': 'Closes #5759\n\nScores both rows again from the lamp\'s readings.',
            'state': 'OPEN',
            'mergedAt': null,
            'headRefName': 'first-builder/5759',
            'comments': {
              'totalCount': 1,
              'pageInfo': {'hasPreviousPage': false, 'startCursor': 'p1'},
              'nodes': [
                {
                  'author': {'login': '69tc'},
                  'body': 'Migrate, 10:05 GMT+7: READ-OK f6edb44',
                  'createdAt': '2026-11-09T03:05:00Z',
                  'url': 'https://github.com/autonomous-ai/lampOS/pull/5770#issuecomment-9',
                },
              ],
            },
            'reviews': {
              'nodes': [
                {
                  'state': 'COMMENTED',
                  'submittedAt': '2026-11-09T02:50:00Z',
                  'body': '',
                  'url': 'https://github.com/autonomous-ai/lampOS/pull/5770#pullrequestreview-1',
                  'author': {'login': 'deehw'},
                  'comments': {
                    'nodes': [
                      {
                        'body':
                            'First builder, 09:50: keep the old row name too.',
                        'createdAt': '2026-11-09T02:50:00Z',
                        'url': 'https://github.com/autonomous-ai/lampOS/pull/5770#discussion_r1',
                        'author': {'login': 'deehw'},
                        'path': 'rows.py',
                        'line': 40,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (query.contains(r'before:$before')) {
      return answer({
        'repository': {
          'issue': {
            'comments': {
              'pageInfo': {'hasPreviousPage': false, 'startCursor': 'c0'},
              'nodes': [
                comment(
                  0,
                  'deehw',
                  'Opened by deehw, 09:0x GMT+7: the rows need a lamp check.',
                  '2026-11-09T01:30:00Z',
                ),
              ],
            },
          },
        },
      });
    }
    if (query.contains('body state') && arguments.contains('number=5759')) {
      return answer({
        'repository': {
          'issue': {
            ...issue(
              5759,
              'The two update rows were scored down for #5539 and #5476',
              '2026-11-09T07:20:06Z',
            ),
            'body': 'Score both rows again once a lamp shows the fix.',
            'labels': {
              'nodes': [
                label('status:taken', 'fbca04'),
                label('builder:first builder', '1d76db'),
              ],
            },
            'author': {'login': '69tc'},
            'state': 'OPEN',
            'comments': {
              'totalCount': 3,
              'pageInfo': {'hasPreviousPage': true, 'startCursor': 'c1'},
              'nodes': [
                comment(
                  1,
                  '69tc',
                  'Migrate, 09:3x GMT+7, taken by Migrate. The first step: what each row still lacks.',
                  '2026-11-09T02:11:20Z',
                ),
                comment(
                  2,
                  'deehw',
                  'First builder, 09:4x: I\'m taking this one.',
                  '2026-11-09T02:27:00Z',
                ),
              ],
            },
          },
        },
      });
    }
    return ProcessResult(
      3,
      1,
      '',
      'GraphQL: Could not resolve to an Issue with the number of 0.',
    );
  },
);

/// An agent's computer, as it answers the instructions link in these tests (Swarm v4): the files it holds, by agent
/// id and name, and every request it was sent. A computer changes a file by itself (`files[...] = ...`), as its agent does.
class SwarmV4Computer {
  SwarmV4Computer({Map<String, String>? files}) : files = files ?? {};

  /// `harnessId/name` -> the file's text.
  final Map<String, String> files;

  /// Every instructions request it was sent. What its Swarm service was asked is in [asked].
  final requests =
      <(String machineId, String type, Map<String, Object?> payload)>[];

  /// What its Swarm service was asked (`super_tabs`): Harness's text for an agent, beside each read.
  final asked = <Map<String, Object?>>[];

  /// What Harness adds to an agent's instructions at every start, as its Swarm service's `basics` answers it. Null is a
  /// computer that says none: one from before it answers `INVALID_REQUEST`.
  String? basics;

  /// A code to refuse every request with (`UNSUPPORTED`, `OFFLINE`, ...) until it is null again.
  String? refuse;

  /// A code the app's own gate refuses with before anything is sent (`UPDATE_HERE`), until it is null again.
  String? gate;

  /// The next save is applied but its answer never comes, as when a link drops after the computer wrote the file.
  bool loseNextReply = false;

  /// What else instructs the agent, in its folder and its person's own on it, as a read's answer carries it (`shared`,
  /// `personal`, `skipped`, `personalSkipped`), and beside the code of a refused read. Null is a computer that sends none (an older one).
  /// Objects, so a test can send what the app does not understand.
  Object? shared, personal, skipped, personalSkipped;

  /// Called as a read arrives, and the read is not answered until what it returns completes: a computer slow to answer.
  Future<void> Function()? hold;

  static String versionOf(String? text) =>
      text == null ? '' : 'v${text.hashCode}';

  late final link = SwarmInstructionsLink(gate: (_) => gate, (
    machineId,
    type,
    payload,
  ) async {
    if (type == 'super_tabs') {
      asked.add(payload);
      if (refuse case final code?) {
        throw WsRequestFailure(responseType: 'super_tabs_result', code: code);
      }
      return basics == null
          ? {'error': 'INVALID_REQUEST'}
          : {'ok': true, 'text': basics};
    }
    requests.add((machineId, type, payload));
    final around = {
      if (type == 'agent_instructions_read') ...{
        'shared': ?shared,
        'personal': ?personal,
        'skipped': ?skipped,
        'personalSkipped': ?personalSkipped,
      },
    };
    if (type == 'agent_instructions_read') await hold?.call();
    if (refuse case final code?) {
      throw WsRequestFailure(
        responseType: '${type}_result',
        code: code,
        payload: {'error': code, ...around},
      );
    }
    final key = '${payload['agentId']}/${payload['name']}';
    final text = files[key];
    if (type == 'agent_instructions_read') {
      return {'text': text, 'version': versionOf(text), ...around};
    }
    if (payload['version'] != versionOf(text)) {
      throw WsRequestFailure(responseType: '${type}_result', code: 'CHANGED');
    }
    final next = payload['text'] as String;
    files[key] = next;
    if (loseNextReply) {
      loseNextReply = false;
      throw const WsRequestTimeout('agent_instructions_write');
    }
    return {'version': versionOf(next)};
  });
}
