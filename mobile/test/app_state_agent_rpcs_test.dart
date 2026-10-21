import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/remote_media_download.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'viewer_app_fixture.dart';

/// What the phone asks of a machine about its agents — making one, opening a
/// conversation Harness did not start, stopping, renaming, restarting, moving
/// models — and what it tells the person when the answer is not a yes.
void main() {
  /// [pending] finishing, with the terminal it opens measured the way its
  /// panel would measure it — the open waits for that.
  Future<T> measured<T>(
    ViewerRig rig,
    String machineId,
    Future<T> pending,
  ) async {
    await settle();
    for (final pane in rig.app.panesFor(machineId)) {
      pane.session?.reportViewport(80, 24);
    }
    return pending;
  }

  Map<String, dynamic> created(Map<String, dynamic> payload, String id) => {
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': agentJson(id),
  };

  group('making an agent', () {
    test('asks for what was chosen, and opens what the machine made', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (p) => created(p, 'new');
      final attempt = AgentCreationAttempt();

      final error = await measured(
        rig,
        'm',
        rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          permissionMode: 'plan',
          prompt: '  fix the build  ',
          attempt: attempt,
        ),
      );

      expect(error, isNull);
      expect(attempt.agentId, 'new');
      final asked = rig.conn('m').payloadsOf('agent_create').single;
      expect(asked['engine'], 'claude');
      expect(asked['cwd'], '/work');
      expect(asked['prompt'], 'fix the build');
      expect(asked['permissionMode'], 'plan');
      expect(
        asked['bypassPermission'],
        isFalse,
        reason: 'an older machine reads only this, and plan is not "approve"',
      );
      expect(asked['creationId'], isA<String>());
      expect(rig.app.stateOf('m')!.agents.map((a) => a.id), ['new']);
      expect(rig.app.paneOfAgent('m', 'new')?.session, isNotNull);
      expect(rig.conn('m').opens.single['agentId'], 'new');
      expect(rig.app.projectHistory.recent('m'), contains('/work'));
    });

    test(
      'a folder the machine makes replaces the folder, never joins it',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (p) => created(p, 'new');

        await measured(
          rig,
          'm',
          rig.app.createAgent(
            'm',
            engine: 'codex',
            folder: '',
            projectFolder: const ProjectFolderRequest.newProject(),
          ),
        );

        final asked = rig.conn('m').payloadsOf('agent_create').single;
        expect(asked.containsKey('cwd'), isFalse);
        expect(asked['projectSource'], 'new');
        expect(asked.containsKey('prompt'), isFalse);
        expect(asked['bypassPermission'], isFalse);
      },
    );

    test('a terminal with no folder is sent no cwd at all, and the machine '
        'opens it at home', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (p) => created(p, 'shell');

      final error = await measured(
        rig,
        'm',
        rig.app.createAgent('m', engine: 'terminal', folder: null),
      );

      expect(error, isNull);
      final asked = rig.conn('m').payloadsOf('agent_create').single;
      expect(asked['engine'], 'terminal');
      // Absent, not empty: the CLI opens a terminal at home only when cwd is missing, and
      // refuses an empty one as INVALID_CWD.
      expect(asked.containsKey('cwd'), isFalse);
      expect(asked['bypassPermission'], isFalse);
      expect(asked.containsKey('permissionMode'), isFalse);
    });

    test('a given folder is sent as it is, an empty one too', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (p) =>
          p['cwd'] == '' ? throw refusal('INVALID_CWD') : created(p, 'shell');

      await measured(
        rig,
        'm',
        rig.app.createAgent('m', engine: 'terminal', folder: '/work'),
      );
      // An agent with no folder and nothing to make one is sent the empty cwd it always was, and
      // the machine refuses it — null is a terminal's, never "anywhere".
      await rig.app.createAgent('m', engine: 'claude', folder: '');

      final [terminal, agent] = rig.conn('m').payloadsOf('agent_create');
      expect(terminal['cwd'], '/work');
      expect(agent['cwd'], '');
    });

    test(
      'a Codex profile is sent only where the machine can take one',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);

        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '/work',
            codexHome: '/home/.codex-work',
          ),
          'Choose a Codex profile only for Codex',
        );
        expect(
          await rig.app.createAgent(
            'm',
            engine: 'codex',
            folder: '/work',
            codexHome: '/home/.codex-work',
          ),
          contains('Update the harness CLI'),
        );
        expect(rig.conn('m').payloadsOf('agent_create'), isEmpty);
      },
    );

    const selectedModel = GridModel(
      id: 'coder',
      node: 'server',
      grid: 'team-grid',
    );
    const launchModels = {
      'supportsModelLaunch': true,
      'localModelEngines': ['codex'],
      'grids': [
        {
          'name': 'team-grid',
          'models': [
            {'id': 'coder', 'node': 'server'},
          ],
        },
      ],
    };

    for (final (name, answer, engine, message) in [
      (
        'old CLI',
        {...launchModels, 'supportsModelLaunch': false},
        'codex',
        'Update Harness CLI',
      ),
      (
        'unsupported engine',
        launchModels,
        'cursor',
        'selected model is unavailable',
      ),
      (
        'stopped model',
        {...launchModels, 'grids': []},
        'codex',
        'selected model is unavailable',
      ),
      (
        'same id on another grid',
        {
          ...launchModels,
          'grids': [
            {
              'name': 'other-grid',
              'models': [
                {'id': 'coder'},
              ],
            },
          ],
        },
        'codex',
        'selected model is unavailable',
      ),
    ]) {
      test('model creation stops before launch for $name', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['grid_models_list'] = (_) => answer;
        final attempt = AgentCreationAttempt();
        expect(
          await rig.app.createAgent(
            'm',
            engine: engine,
            folder: '/work',
            model: selectedModel,
            attempt: attempt,
          ),
          contains(message),
        );
        expect(attempt.awaitingConfirmation, isFalse);
        expect(rig.conn('m').payloadsOf('agent_create'), isEmpty);
      });
    }

    test(
      'model verification timeout does not start on the subscription',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['grid_models_list'] = (_) =>
            throw const WsRequestTimeout('grid_models_list');
        expect(
          await rig.app.createAgent(
            'm',
            engine: 'codex',
            folder: '/work',
            model: selectedModel,
          ),
          contains('Could not verify models'),
        );
        expect(rig.conn('m').payloadsOf('agent_create'), isEmpty);
      },
    );

    test(
      'model creation sends its grid once; a lost receipt only checks status',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['grid_models_list'] = (_) => launchModels;
        rig.conn('m').answers['agent_create'] = (_) =>
            throw const WsRequestTimeout('agent_create');
        final attempt = AgentCreationAttempt();
        expect(
          await rig.app.createAgent(
            'm',
            engine: 'codex',
            folder: '/work',
            model: selectedModel,
            attempt: attempt,
          ),
          contains('Check status'),
        );
        final sent = rig.conn('m').payloadsOf('agent_create').single;
        expect(sent['gridModel'], 'coder');
        expect(sent['gridName'], 'team-grid');
        expect(attempt.awaitingConfirmation, isTrue);
        // Losing the model must not prevent asking whether the harness started.
        rig.conn('m').answers['grid_models_list'] = (_) =>
            throw const WsRequestTimeout('grid_models_list');
        rig.conn('m').answers['agent_create_status'] = (p) => created(p, 'new');
        expect(
          await measured(
            rig,
            'm',
            rig.app.createAgent(
              'm',
              engine: 'codex',
              folder: '/work',
              model: selectedModel,
              attempt: attempt,
            ),
          ),
          isNull,
        );
        expect(rig.conn('m').payloadsOf('grid_models_list'), hasLength(1));
        expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
        expect(rig.conn('m').payloadsOf('agent_create_status'), hasLength(1));
      },
    );

    test('a refusal before anything launched is said, and final', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw refusal('CWD_NOT_FOUND');
      final attempt = AgentCreationAttempt();

      final error = await rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/gone',
        attempt: attempt,
      );
      expect(error, contains('project folder is unavailable'));
      expect(attempt.awaitingConfirmation, isFalse);

      // The same attempt again answers the same, without asking the machine.
      expect(
        await rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/gone',
          attempt: attempt,
        ),
        error,
      );
      expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
    });

    for (final (code, says) in [
      ('TMUX_UNAVAILABLE', 'needs tmux'),
      ('UNSUPPORTED', 'Update the harness CLI'),
      ('PTY_HOST_UNAVAILABLE', 'could not open a terminal'),
      ('ENGINE_LAUNCH_REFUSED', 'cannot start on'),
      ('INVALID_ENGINE', 'Update the harness CLI on Machine m'),
    ]) {
      test('$code is worded for a person', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (_) => throw refusal(code);

        expect(
          await rig.app.createAgent('m', engine: 'claude', folder: '/work'),
          contains(says),
        );
      });
    }

    test('ENGINE_LAUNCH_REFUSED shows the machine\'s own sentence', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      const long =
          "CODEX_HOME names a network or device path, which Harness does not use for an engine home on Windows. Set it to a folder on this computer's drive, such as C:\\Users\\ann\\.codex.";
      rig.conn('m').answers['agent_create'] = (_) =>
          throw refusal('ENGINE_LAUNCH_REFUSED', detail: long);
      expect(
        await rig.app.createAgent('m', engine: 'codex', folder: '/work'),
        long,
      );
    });

    test('ENGINE_LAUNCH_REFUSED with an empty detail falls back', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw refusal('ENGINE_LAUNCH_REFUSED', detail: '');
      expect(
        await rig.app.createAgent('m', engine: 'codex', folder: '/work'),
        contains('cannot start on'),
      );
    });

    test('an engine refused with its own reason says it', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      // The sample's machine runs two engines, and says so.
      rig.conn('m').answers['agent_create'] = (_) => throw refusal(
        'INVALID_ENGINE',
        detail: 'The sample runs Claude Code and Codex.',
      );

      expect(
        await rig.app.createAgent('m', engine: 'cursor', folder: '/work'),
        'The sample runs Claude Code and Codex.',
      );
    });

    // Every refusal the CLI makes before a pane exists that the phone used to
    // read as a lost reply, with what the machine says and what the phone then
    // says. Machine m is the rig's machine's name.
    for (final (code, detail, says) in <(String, String?, String)>[
      ('INVALID_PROJECT_SOURCE', 'Choose a project.', 'Choose a project.'),
      (
        'INVALID_REPOSITORY',
        'Enter a GitHub URL or owner/repository.',
        'Enter a GitHub URL or owner/repository.',
      ),
      (
        'PROJECT_EXISTS',
        '“app” already exists. Select that folder from your projects.',
        '“app” already exists. Select that folder from your projects.',
      ),
      (
        'GRID_UNAVAILABLE',
        'The selected model is unavailable. Choose another model or refresh '
            'the list.',
        'Create harness failed: The selected model is unavailable. Choose '
            'another model or refresh the list.',
      ),
      (
        'INVALID_DSH',
        'blender is not installed on this machine',
        'This harness is not installed on Machine m. blender is not installed '
            'on this machine',
      ),
      (
        'PROMPT_UNSUPPORTED',
        'cursor cannot be started with a first message',
        'This engine cannot be opened with a first message on Machine m.',
      ),
      (
        'PROMPT_TOO_LONG',
        'prompt is longer than 2000 characters',
        'This first task is too long for Machine m. Shorten it and try again.',
      ),
      (
        'INVALID_PROMPT',
        'prompt must be a string',
        'Create harness failed: prompt must be a string',
      ),
      (
        'AGENT_UNSUPPORTED',
        null,
        'This engine cannot be opened as a named agent on Machine m.',
      ),
      (
        'INVALID_AGENT',
        'agent must be 1-64 letters, digits, `-` or `_`',
        'This engine cannot be opened as that named agent on Machine m.',
      ),
      (
        'INVALID_PERMISSION_MODE',
        'claude has no permission mode "yolo"',
        'This engine has no such permission mode on Machine m.',
      ),
      (
        'CODEX_CLI_TOO_OLD',
        'The codex CLI on this machine does not support --ask-for-approval, '
            'which Harness uses for this permission mode.',
        'The codex CLI on this machine does not support --ask-for-approval, '
            'which Harness uses for this permission mode.',
      ),
    ]) {
      test('$code is a refusal, said and final', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (_) =>
            throw refusal(code, detail: detail);
        final attempt = AgentCreationAttempt();

        final error = await rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        );

        expect(error, says);
        expect(error, isNot(contains('has not confirmed')));
        expect(
          attempt.awaitingConfirmation,
          isFalse,
          reason: 'nothing started, so there is nothing to check on',
        );
        // The same attempt again answers the same, without asking the machine.
        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '/work',
            attempt: attempt,
          ),
          says,
        );
        expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
        expect(rig.conn('m').payloadsOf('agent_create_status'), isEmpty);
      });

      test('$code in a failed receipt is said the same way', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (p) => {
          'creationId': p['creationId'],
          'state': 'failed',
          'failure': {'code': code, 'detail': ?detail},
        };
        final attempt = AgentCreationAttempt();

        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '/work',
            attempt: attempt,
          ),
          says,
        );
        expect(attempt.awaitingConfirmation, isFalse);
      });
    }

    // Making the folder itself, which only a receipt reports: the machine's
    // sentence names what to change.
    for (final code in [
      'PROJECT_PREPARATION_FAILED',
      'CLONE_FAILED',
      'CLONE_TIMEOUT',
      'GIT_PROJECT_UNAVAILABLE',
      'INVALID_BRANCH',
      'BRANCH_SWITCH_FAILED',
      'WORKTREE_FAILED',
      'GIT_UNAVAILABLE',
    ]) {
      test('$code says why the project folder was not made', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        String? detail = 'Check the URL and connection, then retry.';
        rig.conn('m').answers['agent_create'] = (p) => {
          'creationId': p['creationId'],
          'state': 'failed',
          'failure': {'code': code, 'detail': ?detail},
        };
        final request = ProjectFolderRequest.remote(
          GitHubRepository.parse('owner/app')!,
        );

        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '',
            projectFolder: request,
          ),
          'Check the URL and connection, then retry.',
        );
        detail = null;
        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '',
            projectFolder: request,
          ),
          'Could not prepare the project folder on Machine m.',
        );
      });
    }

    test(
      'a folder named after the task, taken on an older machine, says how to get a new one',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        // A machine that predates `projectNameMode` refuses the name the phone
        // made up, in words written for a name somebody typed.
        const taken =
            '“robot-talks-to-gemini” already exists. Select that folder from '
            'your projects.';
        rig.conn('m').answers['agent_create'] = (_) =>
            throw refusal('PROJECT_EXISTS', detail: taken);
        final attempt = AgentCreationAttempt();

        final error = await rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '',
          projectFolder: ProjectFolderRequest.forTask('Robot talks to Gemini'),
          prompt: 'Robot talks to Gemini',
          attempt: attempt,
        );

        expect(error, contains('named after this task already exists'));
        expect(error, contains('update Harness there'));
        expect(attempt.awaitingConfirmation, isFalse);
        expect(
          rig.conn('m').payloadsOf('agent_create').single['projectNameMode'],
          'suggested',
        );

        // The same, when the refusal arrives as the receipt.
        rig.conn('m').answers['agent_create'] = (p) => {
          'creationId': p['creationId'],
          'state': 'failed',
          'failure': {'code': 'PROJECT_EXISTS', 'detail': taken},
        };
        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '',
            projectFolder: ProjectFolderRequest.forTask(
              'Robot talks to Gemini',
            ),
            prompt: 'Robot talks to Gemini',
          ),
          error,
        );
      },
    );

    test('an old engine with no reason names the way out', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw refusal('CODEX_CLI_TOO_OLD');

      final error = await rig.app.createAgent(
        'm',
        engine: 'codex',
        folder: '/work',
        permissionMode: 'auto',
      );
      expect(error, contains('too old for Auto-approve'));
      expect(error, contains('Ask first under Approvals'));
    });

    // Nothing proves that these did not start a harness, so each is checked
    // rather than called final.
    for (final (name, failure) in <(String, Object)>[
      ('INTERNAL', refusal('INTERNAL')),
      ('CREATION_CONFLICT', refusal('CREATION_CONFLICT')),
      ('a code no machine sends yet', refusal('SOMETHING_NEW')),
      ('a timeout', const WsRequestTimeout('agent_create')),
      ('a dropped socket', StateError('socket closed')),
    ]) {
      test('$name leaves the harness unconfirmed', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (_) => throw failure;
        final attempt = AgentCreationAttempt();

        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '/work',
            attempt: attempt,
          ),
          'Machine m has not confirmed the new harness yet. '
          'Check status before creating another.',
        );
        expect(attempt.awaitingConfirmation, isTrue);
      });
    }

    test('a lost reply is checked, never sent twice', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw const WsRequestTimeout('agent_create');
      final attempt = AgentCreationAttempt();

      final first = await rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      expect(first, contains('has not confirmed the new harness yet'));
      expect(attempt.awaitingConfirmation, isTrue);

      rig.conn('m').answers['agent_create_status'] = (p) => created(p, 'new');
      final second = await measured(
        rig,
        'm',
        rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        ),
      );

      expect(second, isNull);
      expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
      final status = rig.conn('m').payloadsOf('agent_create_status').single;
      expect(
        status['creationId'],
        rig.conn('m').payloadsOf('agent_create').single['creationId'],
      );
      expect(attempt.agentId, 'new');
    });

    test(
      'a check on the same request cannot change what it asked for',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (_) =>
            throw const WsRequestTimeout('agent_create');
        final attempt = AgentCreationAttempt();
        await rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        );

        expect(
          await rig.app.createAgent(
            'm',
            engine: 'codex',
            folder: '/work',
            attempt: attempt,
          ),
          'Check the original request before changing its choices.',
        );
      },
    );

    test('Check status asks about the request as it was made', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw const WsRequestTimeout('agent_create');
      final attempt = AgentCreationAttempt();
      await rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );

      rig.conn('m').answers['agent_create_status'] = (p) => created(p, 'new');
      expect(
        await measured(rig, 'm', rig.app.checkAgentCreation(attempt)),
        isNull,
      );
      expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
      expect(rig.conn('m').payloadsOf('agent_create_status').single, {
        'creationId': rig
            .conn('m')
            .payloadsOf('agent_create')
            .single['creationId'],
      });
      expect(attempt.agentId, 'new');
    });

    test('Check status never makes a harness', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw refusal('CWD_NOT_FOUND');

      // Never sent: there is nothing to ask about, and asking must not send it.
      expect(
        await rig.app.checkAgentCreation(AgentCreationAttempt()),
        contains('never sent'),
      );
      expect(rig.conn('m').payloadsOf('agent_create'), isEmpty);
      expect(rig.conn('m').payloadsOf('agent_create_status'), isEmpty);

      // Refused for good: the answer stands, and the machine is not asked again.
      final refused = AgentCreationAttempt();
      final error = await rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/gone',
        attempt: refused,
      );
      expect(await rig.app.checkAgentCreation(refused), error);
      expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
      expect(rig.conn('m').payloadsOf('agent_create_status'), isEmpty);
    });

    test('two presses of one request share one answer', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      final reply = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['agent_create'] = (_) => reply.future;
      final attempt = AgentCreationAttempt();

      final first = rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      final second = rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      await settle();
      reply.complete(
        created(rig.conn('m').payloadsOf('agent_create').single, 'new'),
      );

      expect(await measured(rig, 'm', first), isNull);
      expect(await second, isNull);
      expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
    });

    for (final (state, extra, says) in <(String, Map<String, dynamic>, Object)>[
      ('missing', {}, contains('has no record of this request')),
      ('pending', {}, contains('still starting your harness')),
      ('unconfirmed', {}, contains('could not confirm')),
      ('unavailable', {}, contains('no longer available')),
      (
        'failed',
        {
          'failure': {'code': 'CWD_NOT_FOUND'},
        },
        contains('project folder is unavailable'),
      ),
      ('failed', {'failure': 'garbled'}, contains('has not confirmed')),
      ('something new', {}, contains('has not confirmed')),
    ]) {
      test('a status of "$state" is said as such', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (_) =>
            throw const WsRequestTimeout('agent_create');
        rig.conn('m').answers['agent_create_status'] = (p) => {
          'creationId': p['creationId'],
          'state': state,
          ...extra,
        };
        final attempt = AgentCreationAttempt();
        await rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        );

        expect(
          await rig.app.createAgent(
            'm',
            engine: 'claude',
            folder: '/work',
            attempt: attempt,
          ),
          says,
        );
      });
    }

    test('a machine too old to check says where to look instead', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw const WsRequestTimeout('agent_create');
      rig.conn('m').answers['agent_create_status'] = (_) =>
          throw refusal('UNSUPPORTED');
      final attempt = AgentCreationAttempt();
      await rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );

      expect(
        await rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        ),
        contains('cannot check this creation'),
      );
    });

    test('an answer about another request is not taken for this one', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) => {
        'creationId': 'someone-else',
        'state': 'created',
        'agent': agentJson('theirs'),
      };

      expect(
        await rig.app.createAgent('m', engine: 'claude', folder: '/work'),
        contains('has not confirmed'),
      );
      expect(rig.app.stateOf('m')!.agents, isEmpty);
    });

    test('a created answer with no usable agent is not a success', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (p) => {
        'creationId': p['creationId'],
        'state': 'created',
        'agent': {'name': 'no id'},
      };

      expect(
        await rig.app.createAgent('m', engine: 'claude', folder: '/work'),
        contains('has not confirmed'),
      );
    });

    test('an older machine\'s bare reply is a success', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) => {
        'agent': agentJson('old'),
      };

      expect(
        await measured(
          rig,
          'm',
          rig.app.createAgent('m', engine: 'claude', folder: '/work'),
        ),
        isNull,
      );
      expect(rig.app.stateOf('m')!.agents.single.id, 'old');
    });

    test('a machine the phone does not have is said', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);

      expect(
        await rig.app.createAgent('ghost', engine: 'claude', folder: '/work'),
        'Machine not found',
      );
    });
  });

  group('opening a conversation Harness did not start', () {
    test('asks the machine to resume it, in its own folder', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (p) => created(p, 'adopted');
      final attempt = AgentCreationAttempt();

      final error = await measured(
        rig,
        'm',
        rig.app.resumeConversation(
          'm',
          engine: 'claude',
          folder: '/work/app',
          sessionId: 's-ext',
          name: 'Fix login',
          attempt: attempt,
        ),
      );

      expect(error, isNull);
      expect(attempt.agentId, 'adopted');
      final asked = rig.conn('m').payloadsOf('agent_create').single;
      expect(asked['resumeSessionId'], 's-ext');
      expect(asked['cwd'], '/work/app');
      expect(asked['name'], 'Fix login');
      expect(asked['bypassPermission'], isTrue);
    });

    for (final (code, detail) in [
      ('SESSION_OPEN_ELSEWHERE', 'It is open in the Claude app.'),
      ('SESSION_IN_HARNESS', 'This conversation is already a harness here.'),
      ('SESSION_NOT_FOUND', 'This conversation is no longer on this machine.'),
      ('SESSION_FOLDER_GONE', 'The folder it ran in is gone: /work/app'),
      (
        'SESSION_BUSY_IN_TERMINAL',
        'Claude Code is working on it in a terminal.',
      ),
    ]) {
      test('$code says the machine\'s reason, once', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_create'] = (_) =>
            throw refusal(code, detail: detail);
        final attempt = AgentCreationAttempt();

        final error = await rig.app.resumeConversation(
          'm',
          engine: 'claude',
          folder: '/work/app',
          sessionId: 's-ext',
          attempt: attempt,
        );

        expect(error, detail);
        expect(
          attempt.awaitingConfirmation,
          isFalse,
          reason: 'a refusal is final, not a lost reply to check on',
        );
      });
    }

    test(
      'one open in a terminal is refused in words a phone can act on',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        // What a current daemon answers when nobody said how to take it over —
        // and a phone has no way to say.
        rig.conn('m').answers['agent_create'] = (_) => throw refusal(
          'SESSION_OPEN_IN_TERMINAL',
          detail: 'It is open in Claude Code in a terminal. Moving it here quits it there.',
        );
        final attempt = AgentCreationAttempt();

        final error = await rig.app.resumeConversation(
          'm',
          engine: 'claude',
          folder: '/work/app',
          sessionId: 's-ext',
          attempt: attempt,
        );

        expect(error, contains('open in a terminal'));
        expect(error, contains('Close it there'));
        expect(attempt.awaitingConfirmation, isFalse);
      },
    );

    test('a refusal with no reason still names the machine', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw refusal('INVALID_SESSION');

      expect(
        await rig.app.resumeConversation(
          'm',
          engine: 'claude',
          folder: '/work/app',
          sessionId: 'bad',
        ),
        'Could not open that conversation on Machine m.',
      );
    });

    test('a machine too old to resume one says to update it', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw refusal('UNSUPPORTED_ON_REMOTE');

      expect(
        await rig.app.resumeConversation(
          'm',
          engine: 'codex',
          folder: '/work/app',
          sessionId: 's-ext',
        ),
        contains('Update the harness CLI'),
      );
    });
  });

  group('stopping, renaming, restarting', () {
    /// The desktop's sentence for a restart nobody can vouch for either way.
    const restartUnconfirmed =
        'Could not confirm the restart. Check the terminal before restarting again.';

    test('a stop takes the agent off the phone and out of its tab', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');

      expect(await rig.app.deleteAgent('m', 'a'), isNull);

      expect(rig.conn('m').payloadsOf('agent_delete').single['agentId'], 'a');
      expect(rig.app.stateOf('m')!.agents.map((a) => a.id), ['b']);
      expect(rig.app.paneOfAgent('m', 'a'), isNull);
      expect(rig.app.stateOf('m')!.activeAgentId, isNot('a'));
    });

    test('a refused or failed stop says why and keeps the agent', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      rig.conn('m').answers['agent_delete'] = (_) => {'error': 'AGENT_BUSY'};
      expect(await rig.app.deleteAgent('m', 'a'), 'Delete failed: AGENT_BUSY');
      rig.conn('m').answers['agent_delete'] = (_) => throw StateError('gone');
      expect(await rig.app.deleteAgent('m', 'a'), startsWith('Delete failed'));
      expect(await rig.app.deleteAgent('ghost', 'a'), 'Machine not found');

      expect(rig.app.stateOf('m')!.agents.single.id, 'a');
    });

    test('a stop the machine says to ask again is asked again, then goes', () async {
      // IDENTITY_UNAVAILABLE: the conversation file changed under the machine's lookup.
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      rig.app.stopRetryDelays = const [Duration.zero, Duration.zero];
      var asked = 0;
      rig.conn('m').answers['agent_delete'] = (_) => ++asked == 1
          ? {'error': 'IDENTITY_UNAVAILABLE', 'held': true, 'retryable': true}
          : {'deleted': true};

      expect(await rig.app.deleteAgent('m', 'a'), isNull);

      expect(rig.conn('m').payloadsOf('agent_delete'), hasLength(2));
      expect(rig.app.stateOf('m')!.agents.map((a) => a.id), ['b']);
    });

    test('asks again at most twice, then says why', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.app.stopRetryDelays = const [Duration.zero, Duration.zero];
      rig.conn('m').answers['agent_delete'] = (_) =>
          {'error': 'IDENTITY_UNAVAILABLE', 'retryable': true};

      expect(
        await rig.app.deleteAgent('m', 'a'),
        'Delete failed: IDENTITY_UNAVAILABLE',
      );

      expect(rig.conn('m').payloadsOf('agent_delete'), hasLength(3));
      expect(rig.app.stateOf('m')!.agents.single.id, 'a');
    });

    test('a stop it could not confirm is not asked again', () async {
      // STOP_UNCONFIRMED asks for a look at the harness first, not another stop.
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.app.stopRetryDelays = const [Duration.zero, Duration.zero];
      rig.conn('m').answers['agent_delete'] = (_) => {'error': 'STOP_UNCONFIRMED'};

      expect(
        await rig.app.deleteAgent('m', 'a'),
        'Delete failed: STOP_UNCONFIRMED',
      );

      expect(rig.conn('m').payloadsOf('agent_delete'), hasLength(1));
    });

    test('a rename is trimmed, sent, and shown', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      expect(await rig.app.renameAgent('m', 'a', '  api  '), isNull);

      expect(rig.conn('m').payloadsOf('agent_update').single, {
        'agentId': 'a',
        'name': 'api',
      });
      expect(rig.app.stateOf('m')!.agents.single.name, 'api');
    });

    test('a rename that cannot be made says why', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      expect(
        await rig.app.renameAgent('m', 'a', '   '),
        'Name cannot be empty',
      );
      expect(await rig.app.renameAgent('ghost', 'a', 'x'), 'Machine not found');
      rig.conn('m').answers['agent_update'] = (_) => {'error': 'TAKEN'};
      expect(await rig.app.renameAgent('m', 'a', 'x'), 'Rename failed: TAKEN');
      rig.conn('m').answers['agent_update'] = (_) => throw StateError('down');
      expect(
        await rig.app.renameAgent('m', 'a', 'x'),
        startsWith('Rename failed'),
      );
      expect(rig.app.stateOf('m')!.agents.single.name, 'a');
    });

    test('opening an agent is told to its machine, once in a while', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      rig.app.touchAgent('m', 'a');
      rig.app.touchAgent('m', 'a');
      rig.app.touchAgent('ghost', 'a');
      await settle();

      expect(rig.conn('m').payloadsOf('agent_update'), [
        {'agentId': 'a', 'opened': true},
      ]);
    });

    test('a locked machine is not told', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.app.stateOf('m')!.needsLink = true;

      rig.app.touchAgent('m', 'a');
      await settle();

      expect(rig.conn('m').payloadsOf('agent_update'), isEmpty);
    });

    test('a machine that cannot hear the open keeps its order', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_update'] = (_) =>
          throw refusal('MISSING_UPDATE');

      rig.app.touchAgent('m', 'a');
      await settle();

      expect(rig.conn('m').payloadsOf('agent_update'), hasLength(1));
    });

    test(
      'a restart takes the machine\'s fresh agent, and whether it resumed',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_restart'] = (_) => {
          'agent': agentJson('a', name: 'relaunched'),
          'resumed': false,
        };

        final result = await rig.app.restartAgent('m', 'a');

        expect(result.error, isNull);
        expect(result.resumed, isFalse);
        expect(rig.app.stateOf('m')!.agents.single.name, 'relaunched');
      },
    );

    test('a restart that could not be done says why', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      expect(
        (await rig.app.restartAgent('ghost', 'a')).error,
        'Machine not found',
      );
      rig.conn('m').answers['agent_restart'] = (_) => {
        'error': 'AGENT_BUSY',
        'detail': 'Wait for it to finish.',
      };
      expect(
        (await rig.app.restartAgent('m', 'a')).error,
        'Wait for it to finish.',
      );
      rig.conn('m').answers['agent_restart'] = (_) => {'error': 'NOPE'};
      expect(
        (await rig.app.restartAgent('m', 'a')).error,
        'Restart failed: NOPE',
      );
      // No answer is not a refusal: the restart may have happened (see the tests below).
      rig.conn('m').answers['agent_restart'] = (_) => throw StateError('down');
      expect((await rig.app.restartAgent('m', 'a')).error, restartUnconfirmed);
      rig.conn('m').answers['agent_restart'] = (_) => {
        'agent': {'bad': true},
      };
      final odd = await rig.app.restartAgent('m', 'a');
      expect(odd.error, isNull);
      expect(odd.resumed, isTrue, reason: 'absent reads as resumed');
    });

    // ⚠️ The machine works through one connection's requests in order, so a second
    // `agent_restart` sent while the first runs is a second restart once the first is done — the
    // engine that just came back is replaced again.
    test('a second restart while one runs joins it, sending nothing', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final reply = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['agent_restart'] = (_) => reply.future;

      final first = rig.app.restartAgent('m', 'a');
      final second = rig.app.restartAgent('m', 'a');
      await settle();

      expect(rig.conn('m').payloadsOf('agent_restart'), hasLength(1));
      expect(identical(first, second), isTrue);

      reply.complete({'agent': agentJson('a'), 'resumed': false});
      final results = await Future.wait([first, second]);
      expect([for (final result in results) result.resumed], [false, false]);
      expect([for (final result in results) result.error], [null, null]);
      expect(rig.conn('m').payloadsOf('agent_restart'), hasLength(1));
    });

    test('a restart on its way is told, and is over once it answers', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      final reply = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['agent_restart'] = (_) => reply.future;
      var heard = 0;
      rig.app.addListener(() => heard++);

      final restart = rig.app.restartAgent('m', 'a');

      expect(rig.app.agentRestarting('m', 'a'), isTrue);
      expect(heard, isPositive, reason: 'the menu hears that it started');
      expect(rig.app.agentRestarting('m', 'b'), isFalse);
      expect(rig.app.agentRestarting('other', 'a'), isFalse);
      final before = heard;

      reply.complete({'resumed': true});
      await restart;
      await settle();

      expect(rig.app.agentRestarting('m', 'a'), isFalse);
      expect(heard, greaterThan(before), reason: 'and that it ended');
    });

    test('a machine that is not there is never restarting', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      final restart = rig.app.restartAgent('ghost', 'a');

      expect(rig.app.agentRestarting('ghost', 'a'), isFalse);
      expect((await restart).error, 'Machine not found');
    });

    test('a restart that ended — done, refused or unanswered — can be pressed '
        'again', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final answers = rig.conn('m').answers;

      answers['agent_restart'] = (_) => {'resumed': true};
      expect((await rig.app.restartAgent('m', 'a')).error, isNull);
      expect(rig.app.agentRestarting('m', 'a'), isFalse);

      answers['agent_restart'] = (_) => throw refusal('AGENT_BUSY');
      expect((await rig.app.restartAgent('m', 'a')).error, isNotNull);
      expect(rig.app.agentRestarting('m', 'a'), isFalse);

      answers['agent_restart'] = (_) =>
          throw const WsRequestTimeout('agent_restart');
      expect((await rig.app.restartAgent('m', 'a')).error, restartUnconfirmed);
      expect(rig.app.agentRestarting('m', 'a'), isFalse);

      answers['agent_restart'] = (_) => {'resumed': true};
      expect((await rig.app.restartAgent('m', 'a')).error, isNull);
      expect(
        rig.conn('m').payloadsOf('agent_restart'),
        hasLength(4),
        reason: 'each one sent, none joined to one already over',
      );
    });

    test('other agents, and the same agent on another machine, restart on '
        'their own', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
        'n': ['a'],
      });
      addTearDown(rig.app.dispose);
      final reply = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['agent_restart'] = (_) => reply.future;
      rig.conn('n').answers['agent_restart'] = (_) => reply.future;

      final restarts = [
        rig.app.restartAgent('m', 'a'),
        rig.app.restartAgent('m', 'b'),
        rig.app.restartAgent('n', 'a'),
      ];
      await settle();

      expect(
        [
          for (final asked in rig.conn('m').payloadsOf('agent_restart'))
            asked['agentId'],
        ],
        ['a', 'b'],
      );
      expect(rig.conn('n').payloadsOf('agent_restart'), hasLength(1));
      expect(rig.app.agentRestarting('m', 'b'), isTrue);
      expect(rig.app.agentRestarting('n', 'a'), isTrue);
      reply.complete({'resumed': true});
      await Future.wait(restarts);
    });

    test('a refused restart is told in the desktop\'s words, not as the '
        'socket\'s error', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      Future<String?> refusedWith(WsRequestFailure failure) async {
        rig.conn('m').answers['agent_restart'] = (_) => throw failure;
        return (await rig.app.restartAgent('m', 'a')).error;
      }

      expect(
        await refusedWith(refusal('AGENT_BUSY')),
        'Another operation is changing this harness. Wait for it to finish, then retry.',
      );
      expect(
        await refusedWith(refusal('UNSUPPORTED_ON_REMOTE')),
        'Update the harness CLI on this machine to restart a harness.',
      );
      expect(
        await refusedWith(refusal('UNSUPPORTED')),
        'Update the harness CLI on this machine to restart a harness.',
      );
      // The machine's own sentence, when it sends one.
      expect(
        await refusedWith(
          refusal(
            'CWD_NOT_FOUND',
            detail: 'The saved project folder is no longer available.',
          ),
        ),
        'The saved project folder is no longer available.',
      );
      expect(
        await refusedWith(refusal('NO_ACTIVE_PROCESS')),
        'Restart failed: NO_ACTIVE_PROCESS',
      );
    });

    test('a restart whose outcome is unknown is not called a failure', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      Future<String?> answeredWith(
        FutureOr<Map<String, dynamic>> Function(Map<String, dynamic>) answer,
      ) async {
        rig.conn('m').answers['agent_restart'] = answer;
        return (await rig.app.restartAgent('m', 'a')).error;
      }

      // The reply did not come in time: the machine may be restarting it still.
      expect(
        await answeredWith(
          (_) => throw const WsRequestTimeout('agent_restart'),
        ),
        restartUnconfirmed,
      );
      // The socket dropped under the request.
      expect(
        await answeredWith((_) => throw Exception('connection closed')),
        restartUnconfirmed,
      );
      // A relaunch the machine did not see come up, which may still have — the desktop's reading.
      expect(
        await answeredWith(
          (_) => throw refusal(
            'RESTART_FAILED',
            detail: 'claude did not come back up after restart',
          ),
        ),
        restartUnconfirmed,
      );
      expect(
        await answeredWith((_) => throw refusal('INTERNAL')),
        restartUnconfirmed,
      );
      expect(
        await answeredWith((_) => throw refusal('CREATION_STORAGE_FAILED')),
        restartUnconfirmed,
      );
      expect(
        await answeredWith((_) => {'error': 'RESTART_FAILED'}),
        restartUnconfirmed,
      );
    });

    // Getting the new engine up can take the machine longer than the 20s a request waits by
    // default — and a phone that gave up there said the restart had failed while it still ran.
    test('a restart waits longer than a request usually does', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await rig.app.restartAgent('m', 'a');

      expect(
        rig.conn('m').timeouts['agent_restart'],
        greaterThan(const Duration(seconds: 30)),
      );
    });

    test('a restart that answers after the app let go is harmless', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      final reply = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['agent_restart'] = (_) => reply.future;

      final restart = rig.app.restartAgent('m', 'a');
      await settle();
      rig.app.dispose();
      reply.complete({'agent': agentJson('a', name: 'late'), 'resumed': true});

      expect((await restart).error, isNull);
    });
  });

  group('resuming stopped work', () {
    Map<String, dynamic> stopped(String id) =>
        agentJson(id, status: 'stopped', terminal: false, sessionId: 's-$id');

    Future<ViewerRig> withStopped() async {
      final rig = await signedInWith({'m': []});
      await push(rig, 'm', 'agent_synced', {'agent': stopped('a')});
      return rig;
    }

    test('an agent that already has a terminal is simply openable', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      expect((await rig.app.resumeAgent('m', 'a')).error, isNull);
      expect(rig.conn('m').payloadsOf('agent_resume'), isEmpty);
    });

    test(
      'an agent that is not there, or not stopped, is refused here',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        await push(rig, 'm', 'agent_synced', {
          'agent': agentJson('a', terminal: false),
        });

        expect((await rig.app.resumeAgent('m', 'ghost')).error, isNotNull);
        expect((await rig.app.resumeAgent('m', 'a')).error, isNotNull);
        expect(rig.conn('m').payloadsOf('agent_resume'), isEmpty);
      },
    );

    for (final (code, detail, says) in [
      ('UNSUPPORTED', null, 'Update the harness CLI'),
      ('AGENT_BUSY', null, 'Another operation'),
      ('RESUME_UNAVAILABLE', null, 'Could not open this harness'),
      ('RESUME_UNAVAILABLE', 'Its folder is gone.', 'Its folder is gone.'),
    ]) {
      test('a refused resume ($code) is said and final', () async {
        final rig = await withStopped();
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_resume'] = (_) =>
            throw refusal(code, detail: detail);

        expect((await rig.app.resumeAgent('m', 'a')).error, contains(says));
        // Final: the next tap asks again from the top, not for a status.
        await rig.app.resumeAgent('m', 'a');
        expect(rig.conn('m').payloadsOf('agent_resume'), hasLength(2));
      });
    }

    test('a resume the machine never received is sent again, under the same receipt', () async {
      final rig = await withStopped();
      addTearDown(rig.app.dispose);
      // The socket was down: the request never left the phone.
      rig.conn('m').answers['agent_resume'] = (_) =>
          throw StateError('WS disconnected');
      expect((await rig.app.resumeAgent('m', 'a')).error, isNotNull);
      final receipt = rig
          .conn('m')
          .payloadsOf('agent_resume')
          .single['creationId'];

      // So the machine has no record of it — and never will.
      rig.conn('m').answers['agent_create_status'] = (p) => {
        'creationId': p['creationId'],
        'state': 'missing',
      };
      rig.conn('m').answers['agent_resume'] = (p) => {
        'creationId': p['creationId'],
        'state': 'created',
        'agent': agentJson('a', sessionId: 's-a'),
      };

      final retried = await rig.app.resumeAgent('m', 'a');

      expect(retried.error, isNull);
      final resumes = rig.conn('m').payloadsOf('agent_resume');
      expect(resumes, hasLength(2));
      expect(resumes.last, {'creationId': receipt, 'agentId': 'a'});
      expect(rig.app.stateOf('m')!.agents.single.terminalAvailable, isTrue);
    });

    test(
      'a replayed resume that is still lost is checked again next time',
      () async {
        final rig = await withStopped();
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_resume'] = (_) =>
            throw StateError('WS disconnected');
        await rig.app.resumeAgent('m', 'a');
        rig.conn('m').answers['agent_create_status'] = (p) => {
          'creationId': p['creationId'],
          'state': 'missing',
        };

        expect((await rig.app.resumeAgent('m', 'a')).error, isNotNull);
        await rig.app.resumeAgent('m', 'a');

        expect(rig.conn('m').payloadsOf('agent_create_status'), hasLength(2));
        expect(
          {
            for (final p in rig.conn('m').payloadsOf('agent_resume'))
              p['creationId'],
          },
          hasLength(1),
          reason: 'one intent, however many times it is sent',
        );
      },
    );

    test('an INTERNAL answer leaves it to be checked', () async {
      final rig = await withStopped();
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_resume'] = (_) => throw refusal('INTERNAL');

      expect(
        (await rig.app.resumeAgent('m', 'a')).error,
        contains('has not confirmed'),
      );
      await rig.app.resumeAgent('m', 'a');
      expect(rig.conn('m').payloadsOf('agent_create_status'), hasLength(1));
    });

    for (final (state, extra, says) in <(String, Map<String, dynamic>, String)>[
      ('pending', {}, 'still resuming'),
      ('unavailable', {}, 'no longer available'),
      (
        'failed',
        {
          'failure': {'code': 'AGENT_BUSY'},
        },
        'Another operation',
      ),
      ('failed', {}, 'has not confirmed'),
      ('odd', {}, 'has not confirmed'),
    ]) {
      test('a resume answered "$state" is said as such', () async {
        final rig = await withStopped();
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_resume'] = (p) => {
          'creationId': p['creationId'],
          'state': state,
          ...extra,
        };

        expect((await rig.app.resumeAgent('m', 'a')).error, contains(says));
      });
    }

    test(
      'a resume about another receipt, or another agent, is not success',
      () async {
        final rig = await withStopped();
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agent_resume'] = (_) => {
          'creationId': 'other',
          'state': 'created',
        };
        expect((await rig.app.resumeAgent('m', 'a')).error, isNotNull);

        rig.conn('m').answers['agent_create_status'] = (p) => {
          'creationId': p['creationId'],
          'state': 'created',
          'agent': agentJson('b'),
        };
        expect((await rig.app.resumeAgent('m', 'a')).error, isNotNull);
      },
    );

    test('a resume still launching is not yet a success', () async {
      final rig = await withStopped();
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_resume'] = (p) => {
        'creationId': p['creationId'],
        'state': 'created',
        'agent': {
          ...agentJson('a', sessionId: 's-a'),
          'launch': {'state': 'starting'},
        },
      };

      expect((await rig.app.resumeAgent('m', 'a')).error, isNotNull);
    });

    test('a resume after sign-out changes nothing on the phone', () async {
      final rig = await withStopped();
      addTearDown(rig.app.dispose);
      final reply = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['agent_resume'] = (_) => reply.future;

      final resuming = rig.app.resumeAgent('m', 'a');
      await settle();
      await rig.app.logout();
      reply.complete({
        'creationId': rig
            .conn('m')
            .payloadsOf('agent_resume')
            .single['creationId'],
        'state': 'created',
        'agent': agentJson('a', sessionId: 's-a'),
      });

      expect((await resuming).error, isNull);
      expect(rig.app.machineStates, isEmpty);
    });
  });

  group('models on a grid', () {
    test('reads every grid the machine is signed into', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['grid_models_list'] = (_) => {
        'gridName': 'mine',
        'models': [
          {'id': 'qwen', 'node': 'mac'},
          {'id': ''},
          'junk',
        ],
        'grids': [
          {
            'name': 'mine',
            'own': true,
            'models': [
              {'id': 'qwen', 'node': 'mac'},
            ],
          },
          {'name': '', 'models': []},
          {
            'name': 'team',
            'models': [
              {'id': 'llama'},
            ],
          },
        ],
        'localModelEngines': ['Claude', 'codex', 3],
        'gridCli': 'managed',
      };

      final models = await rig.app.gridModels('m');

      expect(models.reachable, isTrue);
      expect(models.gridName, 'mine');
      expect(models.models.map((m) => m.id), ['qwen']);
      expect(models.grids.map((g) => g.name), ['mine', 'team']);
      expect(models.grids.last.models.single.grid, 'team');
      expect(models.localModelEngines, {'claude', 'codex'});
      expect(models.gridCli, GridCli.managed);
    });

    test(
      'a machine that cannot answer is unreachable, not grid-less',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['grid_models_list'] = (_) =>
            throw const WsRequestTimeout('grid_models_list');

        final models = await rig.app.gridModels('m');

        expect(models.reachable, isFalse);
      },
    );

    test('moving an agent sends only the model, and says a refusal', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      expect(
        await rig.app.retargetAgentToGridModel(
          'm',
          'a',
          'qwen',
          gridName: 'team',
        ),
        isNull,
      );
      expect(await rig.app.clearAgentGrid('m', 'a'), isNull);
      expect(rig.conn('m').payloadsOf('agent_retarget'), [
        {'agentId': 'a', 'gridModel': 'qwen', 'gridName': 'team'},
        {'agentId': 'a', 'clearGrid': true},
      ]);

      rig.conn('m').answers['agent_retarget'] = (_) =>
          throw refusal('AGENT_BUSY');
      expect(
        await rig.app.retargetAgentToGridModel('m', 'a', 'qwen'),
        contains('still responding'),
      );

      rig.conn('m').answers['agent_retarget'] = (_) =>
          throw refusal('ENGINE_LAUNCH_REFUSED', detail: 'Use another engine.');
      expect(
        await rig.app.retargetAgentToGridModel('m', 'a', 'qwen'),
        'Use another engine.',
      );
      rig.conn('m').answers['agent_retarget'] = (_) =>
          throw refusal('PTY_HOST_UNAVAILABLE', detail: 'harness-pty is not installed');
      expect(
        await rig.app.clearAgentGrid('m', 'a'),
        "This machine's terminals did not answer. Run harness start there, then try again.",
      );

      // Silence is not a refusal: the machine may have done it.
      rig.conn('m').answers['agent_retarget'] = (_) => throw StateError('down');
      expect(await rig.app.clearAgentGrid('m', 'a'), isNull);
    });
  });

  group('asking a machine about itself', () {
    test(
      'engines are probed once, shared while in flight, and again on demand',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        final reply = Completer<Map<String, dynamic>>();
        rig.conn('m').answers['engines_probe'] = (_) => reply.future;

        final first = rig.app.probeEngines('m');
        final second = rig.app.probeEngines('m');
        await settle();
        expect(rig.conn('m').payloadsOf('engines_probe'), hasLength(1));
        reply.complete({
          'engines': [
            {'engine': 'codex', 'installed': true, 'supportsCodexHome': true},
            'junk',
          ],
        });
        await first;
        await second;

        final engines = rig.app.stateOf('m')!.engines;
        expect(engines.loaded, isTrue);
        expect(engines['codex']?.supportsCodexHome, isTrue);

        await rig.app.probeEngines('m');
        expect(rig.conn('m').payloadsOf('engines_probe'), hasLength(1));
        rig.conn('m').answers['engines_probe'] = (_) => {'engines': []};
        await rig.app.probeEngines('m', force: true);
        expect(rig.conn('m').payloadsOf('engines_probe'), hasLength(2));
        await rig.app.probeEngines('ghost');
      },
    );

    test('a machine that cannot say leaves every engine unknown', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      rig.conn('m').answers['engines_probe'] = (_) =>
          throw refusal('UNSUPPORTED', detail: 'Update Harness there.');
      await rig.app.probeEngines('m');
      expect(rig.app.stateOf('m')!.engines.error, 'Update Harness there.');

      rig.conn('m').answers['engines_probe'] = (_) => throw refusal('NOPE');
      await rig.app.probeEngines('m', force: true);
      expect(rig.app.stateOf('m')!.engines.error, 'NOPE');

      rig.conn('m').answers['engines_probe'] = (_) => {'engines': 'what'};
      await rig.app.probeEngines('m', force: true);
      expect(rig.app.stateOf('m')!.engines.error, contains('could not report'));
    });

    test('what was said in its sessions, only where it is connected', () async {
      final rig = await signedInWith({
        'm': ['a'],
        'n': ['b'],
      });
      addTearDown(rig.app.dispose);
      rig.app.stateOf('n')!.needsLink = true;
      rig.conn('m').answers['session_search'] = (_) => {
        'hits': [
          {
            'agentId': 'a',
            'sessionId': 's-a',
            'snippet': 'the \u0002build\u0003 broke',
          },
        ],
      };

      expect(rig.app.searchableMachineIds, ['m']);
      final hits = await rig.app.searchSessions(
        'm',
        'build',
        when: (
          from: DateTime(2026, 9, 1),
          to: DateTime(2026, 9, 2),
          phrase: 'x',
        ),
      );
      expect(hits!.single.agentId, 'a');
      final asked = rig.conn('m').payloadsOf('session_search').single;
      expect(asked['from'], DateTime(2026, 9, 1).millisecondsSinceEpoch);
      expect(asked['limit'], 30);

      expect(await rig.app.searchSessions('n', 'build'), isNull);
      rig.conn('m').answers['session_search'] = (_) => {'error': 'OLD'};
      expect(await rig.app.searchSessions('m', 'build'), isNull);
      rig.conn('m').answers['session_search'] = (_) =>
          throw const WsRequestTimeout('session_search');
      expect(await rig.app.searchSessions('m', 'build'), isNull);
    });

    test(
      'folders, Git and Codex profiles are read there, failing softly',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        final conn = rig.conn('m');
        conn.answers['fs_list_dir'] = (p) => {'path': p['path'] ?? '~'};
        conn.answers['git_project_info'] = (p) => {'isGit': true};
        conn.answers['codex_profiles_list'] = (p) => {'profiles': []};
        conn.answers['codex_profile_link'] = (p) => {
          'profile': {'path': p['path']},
        };

        expect(await rig.app.listRemoteFolder('m', null), {'path': '~'});
        expect(await rig.app.listRemoteFolder('m', '/w'), {'path': '/w'});
        expect(await rig.app.readGitProject('m', '/w'), {'isGit': true});
        expect(await rig.app.readGitProject('ghost', '/w'), {
          'error': 'UNAVAILABLE',
        });
        expect(await rig.app.listCodexProfiles('m', observedPaths: {'/c'}), {
          'profiles': [],
        });
        expect(conn.payloadsOf('codex_profiles_list').single['observedPaths'], [
          '/c',
        ]);
        expect((await rig.app.linkCodexProfile('m', '/c'))['profile'], {
          'path': '/c',
        });

        for (final type in [
          'fs_list_dir',
          'git_project_info',
          'codex_profiles_list',
          'codex_profile_link',
        ]) {
          conn.answers[type] = (_) => throw StateError('down');
        }
        expect(await rig.app.listRemoteFolder('m', '/w'), {
          'error': 'UNREACHABLE',
        });
        expect(await rig.app.readGitProject('m', '/w'), {
          'error': 'UNAVAILABLE',
        });
        expect(await rig.app.listCodexProfiles('m'), {'error': 'UNREACHABLE'});
        expect(await rig.app.linkCodexProfile('m', '/c'), {
          'error': 'UNREACHABLE',
        });
      },
    );

    test(
      'a model subscription reading asks only its selected computer',
      () async {
        final rig = await signedInWith({'m': [], 'n': []});
        addTearDown(rig.app.dispose);
        await rig.app.readRemoteUsage(machineId: 'n');
        expect(rig.conn('m').asked, isNot(contains('usage_read')));
        expect(rig.conn('n').asked, contains('usage_read'));
      },
    );

    test(
      'usage is read from each connected machine, and silence adds nothing',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
          'n': ['b'],
          'o': ['c'],
        });
        addTearDown(rig.app.dispose);
        rig.app.stateOf('o')!.connectionStatus = ConnectionStatus.reconnecting;
        rig.conn('m').answers['usage_read'] = (_) => {
          'providers': [
            {
              'provider': 'claude',
              'outcome': 'answered',
              'httpStatus': 200,
              'body': {
                'five_hour': {'utilization': 12, 'resets_at': null},
              },
            },
          ],
        };
        rig.conn('n').answers['usage_read'] = (_) =>
            throw const WsRequestTimeout('usage_read');

        final usage = await rig.app.readRemoteUsage();

        expect(usage.map((u) => u.machineName), ['Machine m']);
        expect(rig.conn('o').asked, isNot(contains('usage_read')));
      },
    );
  });

  group('media from a machine', () {
    Future<ViewerRig> previewing() async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await settle();
      return rig;
    }

    test('a chunk is asked for by path and offset', () async {
      final rig = await previewing();
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agent_read_file'] = (p) => {'ok': p['offset']};

      final chunk = await rig.app.readRemoteMediaChunk(
        'm',
        'a',
        '/w/shot.png',
        offset: 5,
        revision: 'r1',
      );

      expect(chunk, {'ok': 5});
      expect(rig.conn('m').payloadsOf('agent_read_file').single, {
        'agentId': 'a',
        'path': '/w/shot.png',
        'media': true,
        'offset': 5,
        'revision': 'r1',
      });
    });

    test('a machine that cannot serve one says why, in a sentence', () async {
      final rig = await previewing();
      addTearDown(rig.app.dispose);
      Future<String> reason() async {
        try {
          await rig.app.readRemoteMediaChunk('m', 'a', '/x', offset: 0);
          return 'no error';
        } on RemoteMediaException catch (error) {
          return error.message;
        }
      }

      for (final (code, says) in [
        ('MEDIA_NOT_FOUND', 'no longer available'),
        ('MEDIA_TOO_LARGE', '512 MB'),
        ('MEDIA_CHANGED', 'changed while downloading'),
        ('MEDIA_UNSUPPORTED', 'not a supported'),
        ('MEDIA_INVALID_REQUEST', 'outside the folders'),
        ('AGENT_NOT_FOUND', 'harness is no longer available'),
        ('NOT_TEXT', 'Update the Harness CLI'),
        ('WHATEVER', 'could not read this file'),
      ]) {
        rig.conn('m').answers['agent_read_file'] = (_) => throw refusal(code);
        expect(await reason(), contains(says), reason: code);
      }
      rig.conn('m').answers['agent_read_file'] = (_) => throw StateError('x');
      expect(await reason(), contains('interrupted'));

      rig.conn('m').ready = false;
      expect(await reason(), contains('disconnected'));
      rig.app.stateOf('m')!.mediaPreviewAvailable = false;
      expect(await reason(), contains('Update the Harness CLI'));
      rig.app.stateOf('m')!.needsLink = true;
      expect(await reason(), contains('disconnected'));
    });
  });

  group('the machine itself', () {
    test('a rename goes to the account and shows at once', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      expect(await rig.app.renameMachine('m', '  Studio  '), isNull);
      expect(rig.api.renamed, ['m=Studio']);
      expect(rig.app.machines.single.displayName, 'Studio');

      expect(await rig.app.renameMachine('m', ' '), 'Name cannot be empty');
      expect(
        await rig.app.renameMachine('ghost', 'x'),
        'This computer is no longer on your account.',
      );
      rig.api.renameFailure = StateError('403');
      expect(
        await rig.app.renameMachine('m', 'x'),
        startsWith('Rename failed'),
      );
    });

    test('a delete takes it and its terminals off the phone', () async {
      final rig = await signedInWith({
        'm': ['a'],
        'n': ['b'],
      });
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');

      rig.api.deleteFailure = StateError('403');
      expect(
        await rig.app.deleteMachine('m'),
        startsWith('Could not remove it'),
      );
      rig.api.deleteFailure = null;
      expect(
        await rig.app.deleteMachine('ghost'),
        'This computer is no longer on your account.',
      );

      expect(await rig.app.deleteMachine('m'), isNull);
      expect(rig.api.deleted, ['m']);
      expect(rig.app.stateOf('m'), isNull);
      expect(rig.app.panesFor('m'), isEmpty);
      expect(rig.app.machines.map((m) => m.machineId), ['n']);
    });
  });
}
