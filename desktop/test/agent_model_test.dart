import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

void main() {
  test(
    'cached output stats survive renames and participate in roster equality',
    () {
      final raw = <String, dynamic>{
        'id': 'a',
        'name': 'Work',
        'outputStats': {
          'linesAdded': 124,
          'linesRemoved': 38,
          'pullRequestsCreated': 2,
          'updatedAt': '2026-09-23T00:00:00Z',
        },
      };
      final agent = Agent.fromJson(raw);
      expect(agent.outputStats?.linesAdded, 124);
      expect(agent.copyWith(name: 'Renamed').outputStats, agent.outputStats);
      expect(agent.hasMonitorStats, isTrue);
      expect(AppNotifier.agentsEqual([agent], [Agent.fromJson(raw)]), isTrue);
      expect(
        AppNotifier.agentsEqual(
          [agent],
          [
            Agent.fromJson({
              ...raw,
              'outputStats': {
                'linesAdded': 125,
                'linesRemoved': 38,
                'pullRequestsCreated': 2,
              },
            }),
          ],
        ),
        isFalse,
      );
      for (final invalid in [-1, 1.5, '12', 9007199254740992]) {
        final parsed = Agent.fromJson({
          'id': 'a',
          'outputStats': {
            'linesAdded': invalid,
            'linesRemoved': 38,
            'pullRequestsCreated': invalid,
          },
        });
        expect(parsed.outputStats, isNull);
        expect(parsed.hasMonitorStats, isFalse);
      }
    },
  );
  test('cached token usage survives rename/pause and participates in roster updates', () {
    final agent = Agent.fromJson({
      'id': 'remote-harness',
      'tokenUsage': {
        'totalTokens': 1234567,
        'updatedAt': '2026-09-22T16:00:00Z',
      },
    });
    expect(agent.tokensUsed, 1234567);
    expect(agent.tokensUpdatedAt, DateTime.utc(2026, 9, 22, 16));
    expect(
      agent.copyWith(name: 'Renamed', status: 'stopped').tokensUsed,
      1234567,
    );
    expect(
      AppNotifier.agentsEqual(
        [agent],
        [
          Agent.fromJson({
            'id': agent.id,
            'tokenUsage': {
              'totalTokens': 2345678,
              'updatedAt': '2026-09-22T16:00:00Z',
            },
          }),
        ],
      ),
      isFalse,
    );
    for (final value in [
      null,
      -1,
      1.5,
      '12',
      double.infinity,
      9007199254740992,
    ]) {
      expect(
        Agent.fromJson({
          'id': 'legacy',
          'tokenUsage': {'totalTokens': value},
        }).tokensUsed,
        isNull,
      );
    }
    expect(Agent.fromJson({'id': 'legacy'}).tokensUsed, isNull);
    expect(
      Agent.fromJson({
        'id': 'new',
        'tokenUsage': {'totalTokens': 0},
      }).tokensUsed,
      0,
    );
  });
  _dshTests();
  _cloneTests();
  test('uses explicit terminal availability from a new CLI', () {
    final dormantPane = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Agent',
      'status': 'offline',
      'terminal': {
        'available': true,
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%1'},
        ],
      },
    });
    final stalePane = Agent.fromJson({
      'id': 'agent-2',
      'name': 'Stale',
      'terminal': {
        'available': false,
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%2'},
        ],
      },
    });

    expect(dormantPane.terminalAvailable, isTrue);
    expect(stalePane.terminalAvailable, isFalse);
  });

  test('falls back to tmux runtime presence for an older CLI', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Legacy',
      'terminal': {
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%1'},
        ],
      },
    });

    expect(agent.terminalAvailable, isTrue);
    expect(agent.launchState, 'ready');
  });

  test('parses a sanitized asynchronous launch failure', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Failed agent',
      'launch': {
        'state': 'failed',
        'error': 'ENGINE_DID_NOT_START',
        'detail': 'Engine exited\nsee terminal',
      },
    });

    expect(agent.launchState, 'failed');
    expect(agent.launchError, 'ENGINE_DID_NOT_START');
    expect(agent.launchDetail, 'Engine exited see terminal');
  });

  group('web search on a Local model', () {
    Agent onGrid(Map<String, Object?> grid) => Agent.fromJson({
      'id': 'agent-1',
      'name': 'Local',
      'engine': 'claude',
      'grid': {'baseUrl': 'https://grid.example/grid-abc/relay', ...grid},
    });

    test('reads the status off the grid block', () {
      expect(
        onGrid({'model': 'qwen', 'webSearch': 'on'}).gridWebSearch,
        GridWebSearch.on,
      );
      expect(
        onGrid({'model': 'qwen', 'webSearch': 'unavailable'}).gridWebSearch,
        GridWebSearch.unavailable,
      );
      expect(
        onGrid({'model': 'qwen', 'webSearch': 'unsupported'}).gridWebSearch,
        GridWebSearch.unsupported,
      );
    });

    test('has nothing to say when the daemon said nothing, or said a word it does not know', () {
      // An older daemon, or a grid agent the daemon merely discovered: no field at all.
      expect(onGrid({'model': 'qwen'}).gridWebSearch, isNull);
      // A newer daemon with a fourth word: not printed verbatim, not guessed at.
      expect(
        onGrid({'model': 'qwen', 'webSearch': 'throttled'}).gridWebSearch,
        isNull,
      );
      expect(onGrid({'model': 'qwen', 'webSearch': 7}).gridWebSearch, isNull);
    });

    test('has nothing to say off a grid', () {
      final own = Agent.fromJson({
        'id': 'agent-2',
        'name': 'Own',
        'grid': null,
      });
      expect(own.gridModel, isNull);
      expect(own.gridWebSearch, isNull);
    });

    test('each degraded status is one sentence; on is none', () {
      expect(GridWebSearch.unavailable.sentence, 'Web search unavailable');
      expect(
        GridWebSearch.unsupported.sentence,
        'Web search not supported by this engine',
      );
      expect(GridWebSearch.on.sentence, isNull);
    });
  });
}

// ── domain-specific harness fields ────────────────────────────────────────────

void _dshTests() {
  test('parses the harness, viewer and verdict off an agent frame', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Board',
      'engine': 'claude',
      'dsh': 'autonomous/autonomous-circuit',
      'dshName': 'Autonomous Circuit',
      'viewerUrl': 'http://127.0.0.1:4179/?workspace=1',
      'verdict': {
        'ready': false,
        'summary': '2 errors, 1 warning',
        'errors': 2,
        'warnings': 1,
        'artifact': 'boards/main.board.json',
        'updatedAt': '2026-09-14T20:00:00Z',
      },
    });
    expect(agent.engine, 'claude');
    expect(agent.dsh, 'autonomous/autonomous-circuit');
    expect(agent.dshName, 'Autonomous Circuit');
    expect(agent.identityEngine, 'autonomous/autonomous-circuit');
    expect(agent.identityDisplayName, 'Autonomous Circuit');
    expect(agent.viewerUrl, 'http://127.0.0.1:4179/?workspace=1');
    final verdict = agent.verdict!;
    expect(verdict.ready, isFalse);
    expect(verdict.summary, '2 errors, 1 warning');
    expect(verdict.errors, 2);
    expect(verdict.warnings, 1);
    expect(verdict.artifact, 'boards/main.board.json');
    expect(verdict.updatedAt, DateTime.utc(2026, 9, 14, 20));
    expect(agent.copyWith(name: 'Renamed').verdict, verdict);
    expect(
      agent.copyWith(name: 'Renamed').dsh,
      'autonomous/autonomous-circuit',
    );
  });

  test('a plain engine agent has none of them and draws as its engine', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'a',
      'engine': 'codex',
    });
    expect(agent.dsh, isNull);
    expect(agent.viewerUrl, isNull);
    expect(agent.verdict, isNull);
    expect(agent.identityEngine, 'codex');
  });

  test(
    'refuses a harness id, viewer URL or verdict outside the spec shape',
    () {
      Agent parse(Map<String, dynamic> extra) =>
          Agent.fromJson({'id': 'agent-1', 'name': 'a', ...extra});
      // The id is owner/name; a bare word, a deeper path, or an upper-case one is not.
      expect(parse({'dsh': 'circuit'}).dsh, isNull);
      expect(parse({'dsh': 'a/b/c'}).dsh, isNull);
      expect(parse({'dsh': 'Autonomous/Circuit'}).dsh, isNull);
      expect(parse({'dsh': 'autonomous/../etc'}).dsh, isNull);
      // The viewer URL lands in a webview: http(s) with a host, no whitespace, no control bytes.
      expect(parse({'viewerUrl': 'file:///etc/passwd'}).viewerUrl, isNull);
      expect(parse({'viewerUrl': 'javascript:alert(1)'}).viewerUrl, isNull);
      expect(
        parse({'viewerUrl': 'http://127.0.0.1:4179/a b'}).viewerUrl,
        isNull,
      );
      expect(parse({'viewerUrl': 'http://\n127.0.0.1/'}).viewerUrl, isNull);
      expect(
        parse({'viewerUrl': 'https://viewer.local/x'}).viewerUrl,
        'https://viewer.local/x',
      );
      // A verdict without the one required fact is no verdict; counts never go negative or absurd.
      expect(
        parse({
          'verdict': {'summary': 'x'},
        }).verdict,
        isNull,
      );
      expect(parse({'verdict': 'ready'}).verdict, isNull);
      final odd = parse({
        'verdict': {
          'ready': true,
          'errors': -3,
          'warnings': 1e9,
          'summary': 'ok\u0000\u0001',
        },
      }).verdict!;
      expect(odd.errors, 0);
      expect(odd.warnings, 9999);
      expect(odd.summary, 'ok');
      expect(odd.updatedAt, isNull);
    },
  );
}

/// What Clone (⌘⇧N) reads off the frame to open another of the same agent.
void _cloneTests() {
  test('parses the launch choices off an agent frame', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'a',
      'engine': 'claude',
      'permissionMode': 'readOnly',
      'bypassPermission': false,
      'namedAgent': 'reviewer',
    });
    expect(agent.permissionMode, 'readOnly');
    expect(agent.bypassPermission, isFalse);
    expect(agent.namedAgent, 'reviewer');
    expect(agent.canClone, isTrue);
  });

  test('an older daemon leaves them null, which is not the same as false', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'a',
      'engine': 'claude',
    });
    expect(agent.permissionMode, isNull);
    expect(agent.bypassPermission, isNull);
    expect(agent.namedAgent, isNull);
    expect(agent.canClone, isTrue);
  });

  test('refuses a mode or named agent outside the flag-value shape', () {
    Agent parse(Map<String, dynamic> extra) => Agent.fromJson({
      'id': 'agent-1',
      'name': 'a',
      'engine': 'claude',
      ...extra,
    });
    expect(parse({'permissionMode': 'read only'}).permissionMode, isNull);
    expect(parse({'permissionMode': '--dangerous'}).permissionMode, isNull);
    expect(parse({'namedAgent': '../etc/passwd'}).namedAgent, isNull);
    expect(parse({'namedAgent': 'a b'}).namedAgent, isNull);
    expect(parse({'bypassPermission': 'true'}).bypassPermission, isNull);
  });

  test('a grid agent, or one with no engine, cannot be cloned', () {
    expect(
      Agent.fromJson({
        'id': 'agent-1',
        'name': 'a',
        'engine': 'claude',
        'grid': {'model': 'DeepSeek-V4'},
      }).canClone,
      isFalse,
    );
    expect(Agent.fromJson({'id': 'agent-1', 'name': 'a'}).canClone, isFalse);
  });
}
