import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../test/swarm/swarm_fixture.dart';

/// Swarm Home in the real shell on a simulator, a screenshot at each step:
/// the app opens on Swarm Home; Needs you opens one thing at a time, a tag
/// with Done, a decision answered with one tap and its Undo; the Swarm
/// switcher, and no Harness there; a
/// project on its project chat, its ⋮ menu at the top right; the Buddy chat
/// itself; Harness through an agent's notice and back with the terminal's
/// Swarm mark; and Swarm turned off, the terminal as it always was.
///
/// The Swarm is scripted here, in the app: a machine connection that never
/// dials answers the phone's Swarm requests (`super_tabs`, `action:
/// backend`) from it, as the daemon would forward them. Nothing reaches a
/// real account, machine, daemon or backend, and the switch is set in memory
/// only, so the simulator's saved settings are left as they were.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_home_journey_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Swarm Home, its switcher and a project, in the real shell', (
    tester,
  ) async {
    final swarm = _Swarm();
    final walk = _Walk(tester, binding, 'swarm-home');
    await _openShell(tester, swarm);
    final navigator = find
        .descendant(
          of: find.byType(PhoneShell),
          matching: find.byType(Navigator),
        )
        .first;
    // Back, as a page's own chevron does: the shell's navigator.
    Future<void> back() async {
      await tester.state<NavigatorState>(navigator).maybePop();
      await walk.wait(1200);
    }

    Future<void> switcher() async {
      await tester.tap(walk.key('swarm-title-button'));
      await walk.waitFor(walk.key('swarm-switch-$tab'));
    }

    // ① The app opens on Swarm Home: Needs you, one thing open; Buddies;
    // the projects, bold with something new. No terminal yet.
    await walk.waitFor(walk.key('swarm-need-decision:d1'));
    await walk.waitFor(walk.key('swarm-project-$tab-$project'));
    expect(find.byType(TerminalPage), findsNothing);
    expect(walk.key('swarm-need-row-mention:m1'), findsOneWidget);
    await walk.shot('home');

    // ② The tag opens in the decision's place, with Done.
    await tester.tap(walk.key('swarm-need-row-mention:m1'));
    await walk.waitFor(walk.key('swarm-done-m1'));
    expect(walk.key('swarm-option-d1-0'), findsNothing);
    await walk.shot('tag-open');

    // ③ The decision again: one tap holds the answer with Undo, then it
    // goes, and the next thing opens.
    await tester.tap(walk.key('swarm-need-row-decision:d1'));
    await walk.waitFor(walk.key('swarm-option-d1-0'));
    await tester.tap(walk.key('swarm-option-d1-0'));
    await walk.waitFor(walk.key('swarm-undo-d1'));
    await walk.shot('decision-held');
    await walk.waitGone(walk.key('swarm-need-decision:d1'));
    await walk.waitFor(walk.key('swarm-done-m1'));
    expect(swarm.answered, [0]);
    await walk.shot('decision-answered');

    // ④ Done on the tag: only the waiting work is left.
    await tester.tap(walk.key('swarm-done-m1'));
    await walk.waitGone(walk.key('swarm-need-mention:m1'));
    expect(swarm.done, ['m1']);
    await walk.shot('tag-done');

    // ⑤ The switcher: the Swarm ticked, Join or create, and no Harness.
    await switcher();
    expect(walk.key('swarm-switch-join'), findsOneWidget);
    expect(find.textContaining('Harness'), findsNothing);
    await walk.shot('switcher');
    await back();

    // ⑥ A project's row opens it on its project chat, its ⋮ menu at the
    // top right and nothing under the header.
    await tester.tap(walk.key('swarm-project-$tab-$project'));
    await walk.waitFor(walk.key('swarm-project-menu'));
    expect(find.byType(SwarmProjectPage), findsOneWidget);
    await walk.shot('project');

    // ⑥½ The menu: Buddy chat and the team's status, which opens the
    // project's work, then each agent, in a sheet over the chat.
    await tester.tap(walk.key('swarm-project-menu'));
    await walk.waitFor(walk.key('swarm-project-menu-status'));
    await walk.wait();
    await walk.shot('project-menu');
    await tester.tap(walk.key('swarm-project-menu-status'));
    await walk.waitFor(walk.key('swarm-team-close'));
    await walk.wait();
    await walk.shot('work');
    await tester.tap(walk.key('swarm-sheet-team'));
    await walk.wait();
    await walk.shot('team');
    await tester.tap(walk.key('swarm-team-close'));
    await walk.waitGone(walk.key('swarm-team-close'));

    // ⑦ The Buddy chat, from the menu: the person and their Buddy alone,
    // the PM's private line to them read as "River (PM) → you".
    await tester.tap(walk.key('swarm-project-menu'));
    await walk.waitFor(walk.key('swarm-project-menu-buddy-chat'));
    await tester.tap(walk.key('swarm-project-menu-buddy-chat'));
    await walk.waitFor(find.byType(SwarmConversationPage));
    await walk.waitFor(find.textContaining('Passkeys are ready'));
    await walk.waitFor(find.text('River (PM) → you'));
    FocusManager.instance.primaryFocus?.unfocus();
    await walk.shot('buddy-chat');
    await back();
    await back();
    await walk.waitFor(walk.key('swarm-title-button'));

    // ⑧ Open terminal from the project team: Harness at the root. Its Swarm mark goes back to Swarm Home.
    await _openTerminal(tester, walk);
    await walk.waitFor(walk.key('swarm-mark'));
    await walk.wait(1500);
    await walk.shot('harness');
    await tester.tap(walk.key('swarm-mark'));
    await walk.waitFor(walk.key('swarm-title-button'));
    expect(walk.key('tty-back'), findsNothing, reason: 'Home, not a page');
    await walk.shot('home-from-mark');

    // ⑨ Swarm off: the terminal, as it always was.
    experimentalFeaturesStore.value = const {};
    await walk.waitFor(find.byKey(const ValueKey('terminal-title')));
    expect(walk.key('swarm-title-button'), findsNothing);
    await walk.wait(1500);
    await walk.shot('swarm-off');
  }, timeout: const Timeout(Duration(minutes: 3)));

  testWidgets('Home is where it was left, after Harness and back', (
    tester,
  ) async {
    final walk = _Walk(tester, binding, 'swarm-home-kept');
    await _openShell(tester, _Swarm(more: 8));
    final list = find
        .descendant(
          of: find.byType(SwarmPage),
          matching: find.byType(Scrollable),
        )
        .first;
    double offset() => tester.state<ScrollableState>(list).position.pixels;

    // ① Home, scrolled down to its projects.
    await walk.waitFor(walk.key('swarm-home-buddy-$tab-$project'));
    await tester.drag(list, const Offset(0, -500));
    await walk.wait(1200);
    final scrolled = offset();
    expect(scrolled, greaterThan(0));
    await walk.shot('home-scrolled');

    // ② Harness, from the project team.
    await _openTerminal(tester, walk);
    await walk.waitFor(walk.key('swarm-mark'));
    await walk.wait(1500);
    await walk.shot('harness');

    // ③ Back to Home with the Swarm mark: scrolled where it was.
    await tester.tap(walk.key('swarm-mark'));
    await walk.waitFor(walk.key('swarm-title-button'));
    expect(offset(), scrolled);
    await walk.shot('home-back');
  }, timeout: const Timeout(Duration(minutes: 2)));
}

/// The real shell on [swarm], Swarm on, with one machine of the account
/// connected and its one agent listed; its notifier.
Future<AppNotifier> _openShell(WidgetTester tester, _Swarm swarm) async {
  const machine = Machine(
    machineId: 'mac-1',
    authMode: MachineAuthMode.remote,
    name: 'Studio Mac',
  );
  final agents = [
    <String, dynamic>{
      'id': 'harness-agent-builder',
      'name': 'passkeys',
      'sessionId': 'session-review',
      'engine': 'claude',
      'status': 'active',
      'terminal': {'available': true},
      'project': {'name': 'harness', 'cwd': '/srv/harness'},
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    },
  ];
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(storage: _Memory()),
    configStore: null,
    connectionForTest: (machineId) =>
        _ScriptedConn(machineId, agents, swarm.fake),
  );
  addTearDown(notifier.dispose);
  notifier
    ..currentUser = const CurrentUserProfile(id: me, email: 'sam@example.com')
    ..machines = [machine];
  notifier.machineStates[machine.machineId] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [for (final json in agents) Agent.fromJson(json)];
  // In memory only: the value, not the store's write.
  experimentalFeaturesStore.value = {PhoneExperiment.swarm};
  addTearDown(() => experimentalFeaturesStore.value = const {});

  await tester.pumpWidget(_phone(PhoneShell(notifier: notifier)));
  return notifier;
}

/// Open an agent explicitly from the project's team; Home keeps its scroll.
Future<void> _openTerminal(WidgetTester tester, _Walk walk) async {
  // Each tap past its page's transition: mid-slide, a page is off to the
  // right, and the one sliding out still answers its finder.
  Future<void> tap(String key) async {
    await walk.waitFor(walk.key(key));
    await walk.wait(900);
    await tester.tap(walk.key(key));
  }

  await walk.waitFor(walk.key('swarm-title-button'));
  await tester.scrollUntilVisible(
    walk.key('swarm-project-$tab-$project'),
    200,
    scrollable: find
        .descendant(
          of: find.byType(SwarmPage),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  await tap('swarm-project-$tab-$project');
  await tap('swarm-project-menu');
  await tap('swarm-project-menu-status');
  await tap('swarm-sheet-team');
  await tap('swarm-open-terminal-agent-builder');
}

/// One Swarm, "Phone Swarm", as the backend would send it: Mobile app (River
/// its Product Manager, Nova waiting on the person, Kai working, Atlas
/// down), Website (Cleo), a decision and a tag for the person, and their
/// Buddy Wren in Mobile app with its chat. A decision answered and a tag done
/// leave.
/// [more] projects besides, for a Home taller than the screen.
class _Swarm {
  _Swarm({int more = 0}) {
    const web = 'project-2';
    const webLead = 'group-lead-web';
    Map<String, dynamic> inWeb(Map<String, dynamic> row) => {
      ...row,
      'projectId': web,
    };
    Map<String, dynamic> projectRow(String id, String name, String lead) => {
      'id': id,
      'name': name,
      'ownerId': me,
      'leadConversationId': lead,
      'visibility': 'public',
      'members': <Object>[],
      'updateMinutes': 5,
    };
    Map<String, dynamic> derived() => {
      'decisionsWaiting': answered.isEmpty ? 1 : 0,
      'mentionsWaiting': done.isEmpty ? 1 : 0,
    };
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      derived: derived(),
      head: headData(
        projects: [
          projectRow(project, 'Mobile app', leadChat),
          projectRow(web, 'Website', webLead),
          for (var i = 1; i <= more; i++)
            projectRow('project-more-$i', 'Project $i', 'lead-more-$i'),
        ],
      ),
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        agent('agent-builder', displayName: 'Nova'),
        agent('agent-kai', displayName: 'Kai'),
        {
          ...agent('agent-atlas', displayName: 'Atlas'),
          'downSince': '2026-10-27T01:00:00.000Z',
        },
        inWeb(agent('agent-cleo', name: 'Lead', displayName: 'Cleo')),
        buddyData('agent-wren', displayName: 'Wren'),
      ],
      groups: [
        groupData(
          'g1',
          title: 'Sign in with passkeys',
          number: 4,
          agentIds: ['agent-lead', 'agent-builder'],
          status: 'needs_human',
          lastMessageSequence: 9,
        ),
        groupData(
          'g-kai',
          title: 'Offline drafts',
          number: 6,
          agentIds: ['agent-kai'],
          status: 'working',
          workerId: 'agent-kai',
          lastMessageSequence: 20,
        ),
        groupData(
          'g-atlas',
          title: 'Search page',
          number: 5,
          agentIds: ['agent-atlas'],
          lastMessageSequence: 3,
        ),
        buddyChatData('buddy-me', agentIds: ['agent-wren']),
        inWeb(
          groupData(
            webLead,
            title: 'Website',
            agentIds: ['agent-cleo'],
            leadId: 'agent-cleo',
          ),
        ),
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived());
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        if (answered.isEmpty)
          {
            'id': 'd1',
            'projectName': 'Mobile app',
            'conversationId': 'g1',
            'conversationTitle': 'Sign in with passkeys',
            'askerName': 'River',
            'question':
                'Turn passkeys on for everyone, or behind a flag for the '
                'first week?',
            'options': ['Behind a flag', 'On for everyone'],
            'recommended': 0,
          },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [
        if (done.isEmpty)
          {
            'id': 'm1',
            'projectName': 'Mobile app',
            'conversationId': 'g1',
            'conversationTitle': 'Sign in with passkeys',
            'messageId': 'msg-1',
            'leadName': 'River',
            'text': 'Can you check the copy on the sign-in sheet?',
          },
      ],
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body?['command'] as Map<String, dynamic>? ?? const {};
      switch (command['type']) {
        case 'decision.answer':
          answered.add(command['choice'] as int);
        case 'mention.done':
          done.add(command['mentionId'] as String);
      }
      return {'result': <String, dynamic>{}};
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/conversations/buddy-me/messages'] = (_) => {
      'messages': [
        _message('pm-1', 'buddy-me', 1, me, 'How close are passkeys?'),
        _message(
          'pm-2',
          'buddy-me',
          2,
          'agent-lead',
          'Passkeys are ready behind a flag. Nova is waiting on one '
              'decision from you, and Atlas is down on Search page.',
        ),
      ],
      'next': null,
    };
  }

  final fake = FakeSwarm();
  final answered = <int>[];
  final done = <String>[];

  static Map<String, dynamic> _message(
    String id,
    String conversationId,
    int sequence,
    String authorId,
    String text,
  ) => {
    'id': id,
    'conversationId': conversationId,
    'text': text,
    'sequence': sequence,
    'author': authorId == me
        ? {'kind': 'person', 'id': me, 'name': 'Sam'}
        : {'kind': 'agent', 'id': authorId, 'name': 'River'},
    'createdAt': '2026-10-27T0$sequence:00:00.000Z',
  };
}

/// The app's own theme, as `app_shell.dart` builds it, around [home].
Widget _phone(Widget home) {
  final brightness = grid.AppTheme.palette.value.brightness;
  grid.AppTheme.brightness.value = brightness;
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    builder: (context, child) => grid.BrightnessScope(child: child!),
    home: home,
  );
}

/// An account machine that never dials: it lists [_agents], and answers the
/// phone's Swarm requests (`super_tabs`, `action: backend`) from [_swarm] as
/// the daemon answers them (cli/src/superTabs/service.ts): the value, or the
/// refusal's code, words and status. Everything else gets nothing.
class _ScriptedConn extends WsConn {
  _ScriptedConn(String machineId, this._agents, this._swarm)
    : super(
        wsBaseUrl: 'ws://journey.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<Map<String, dynamic>> _agents;
  final FakeSwarm _swarm;

  @override
  bool get isReady => true;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<void> connect() async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agents_list') return {'agents': _agents};
    if (type != 'super_tabs' || payload['action'] != 'backend') return {};
    try {
      final value = await _swarm.request(
        payload['method'] as String,
        payload['path'] as String,
        body: payload['body'] as Map<String, dynamic>?,
      );
      return {'ok': true, 'value': value};
    } on SuperTabFailure catch (failure) {
      return {
        'error': failure.code,
        'detail': failure.message,
        'status': failure.statusCode,
      };
    }
  }
}

/// A walk's waits and its numbered screenshots, `<name>-NN-<step>`.
class _Walk {
  _Walk(this.tester, this.binding, this.name);

  final WidgetTester tester;
  final IntegrationTestWidgetsFlutterBinding binding;
  final String name;
  var _step = 0;

  Future<void> wait([int ms = 600]) async {
    for (var elapsed = 0; elapsed < ms; elapsed += 100) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> shot(String step) async {
    // Past any page transition.
    await wait(900);
    _step++;
    await binding.takeScreenshot(
      '$name-${_step.toString().padLeft(2, '0')}-$step',
    );
  }

  Future<void> waitFor(Finder finder, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      if (finder.evaluate().isNotEmpty) return;
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('never appeared: $finder');
  }

  Future<void> waitGone(Finder finder, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      if (finder.evaluate().isEmpty) return;
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('never went: $finder');
  }

  Finder key(String value) => find.byKey(ValueKey(value));
}

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
