import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppPalette;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_agent_state.dart';
import 'package:harness_mobile/swarm/swarm_agents.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's computers, with what each of their harnesses does as a test
/// sets it ([activities], told of by [tell]).
class _Computers extends ChangeNotifier
    implements SwarmComputers, SwarmAgentsSource {
  @override
  List<SwarmComputer>? get computers => const [
    (name: 'Mac Studio', away: false),
  ];

  @override
  List<SwarmOwnComputer> get own => const [];

  @override
  bool get rechecking => false;

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) async => throw UnimplementedError();

  @override
  Future<void> recheck() async {}

  @override
  void add(BuildContext context) {}

  @override
  final _Agents agents = _Agents();
}

class _Agents extends ChangeNotifier implements SwarmAgents {
  final activities = <String, SwarmHarnessActivity>{};

  @override
  int? get working => activities.length;

  @override
  SwarmHarnessActivity? activityOf(String machineId, String harnessId) =>
      activities['$machineId/$harnessId'];

  void tell() => notifyListeners();

  @override
  void openList(BuildContext context) {}
}

/// What an agent is doing, in a word or two, on Your Team, and its Pause and
/// Resume one long press away, as Desktop's left pane has them (Swarm v4,
/// `agent_state.dart` `rowOf`, `project_sidebar.dart` `_agentRow`).
void main() {
  group('swarmAgentState: the first of Desktop\'s states the phone can '
      'read', () {
    final now = DateTime.utc(2026, 11, 12, 8);
    final soon = DateTime.utc(2026, 11, 12, 9, 5);

    /// [me]'s agent, with the fields a test sets.
    SuperTabAgent of([Map<String, dynamic> fields = const {}]) =>
        SuperTabAgent.fromJson({...agent('a-ada'), ...fields});

    String? state(
      SuperTabAgent agent, {
      SwarmHarnessActivity? activity,
      String reader = me,
    }) => swarmAgentState(agent, activity: activity, me: reader, now: now);

    String two(int n) => n.toString().padLeft(2, '0');
    final limited =
        'limited until ${two(soon.toLocal().hour)}:${two(soon.toLocal().minute)}';

    test('nothing for one it knows nothing of', () {
      expect(state(of()), isNull);
    });

    test('working while a turn runs on its computer', () {
      expect(state(of(), activity: SwarmHarnessActivity.working), 'working');
    });

    test('needs you, to its person, with a question on its screen or its '
        'machine alerting a prompt; waiting on its person to anyone else', () {
      expect(
        state(of(), activity: SwarmHarnessActivity.needsInput),
        'needs you',
      );
      expect(
        state(
          of({
            'alerting': ['prompt'],
          }),
        ),
        'needs you',
      );
      expect(
        state(
          of({
            'alerting': ['prompt'],
          }),
          reader: 'person-other',
        ),
        'waiting on its person',
      );
      expect(
        state(
          of({
            'alerting': ['bell'],
          }),
        ),
        isNull,
        reason: 'only a prompt waits on someone',
      );
    });

    test('limited until its quota is back, then nothing again', () {
      expect(state(of({'limitedUntil': soon.toIso8601String()})), limited);
      expect(
        state(
          of({'limitedUntil': now.toIso8601String()}),
          activity: SwarmHarnessActivity.working,
        ),
        'working',
        reason: 'a limit over holds nothing back',
      );
    });

    test("in Desktop's order: offline, needs you, paused, limited, "
        'working', () {
      final all = {
        'downSince': '2026-11-12T07:00:00.000Z',
        'alerting': ['prompt'],
        'pausedAt': '2026-11-12T07:00:00.000Z',
        'limitedUntil': soon.toIso8601String(),
      };
      const working = SwarmHarnessActivity.working;
      expect(state(of(all), activity: working), 'offline');
      expect(
        state(of({...all, 'downSince': null}), activity: working),
        'needs you',
      );
      expect(
        state(
          of({...all, 'downSince': null, 'alerting': <String>[]}),
          activity: working,
        ),
        'paused',
        reason: 'a paused agent with its turn still running is paused',
      );
      expect(
        state(of({'limitedUntil': soon.toIso8601String()}), activity: working),
        limited,
      );
    });
  });

  group('swarmMayPauseAgent: as backend agent.pause allows it', () {
    /// A read of a Swarm owned by [owner], with [agents], [me] in it as
    /// [role].
    Future<SwarmReader> read(
      List<Map<String, dynamic>> agents, {
      String role = 'owner',
      String owner = me,
    }) async {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          head: headData(ownerId: owner),
          agents: agents,
        ),
        'members': [part(me, 1, person(me, role: role))],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: fake.request,
      );
      addTearDown(reader.dispose);
      await reader.refresh();
      return reader;
    }

    Map<String, dynamic> theirs(String id, {String? machineOwner}) => {
      ...agent(id),
      'contributorId': 'person-other',
      'machineOwnerId': machineOwner ?? 'person-other',
    };

    test("its person, its machine's owner and the Swarm's owner", () async {
      final reader = await read(owner: 'person-other', [
        agent('a-mine'),
        theirs('a-on-my-mac', machineOwner: me),
        theirs('a-theirs'),
      ]);

      expect(swarmMayPauseAgent(reader, 'a-mine'), isTrue);
      expect(swarmMayPauseAgent(reader, 'a-on-my-mac'), isTrue);
      expect(swarmMayPauseAgent(reader, 'a-theirs'), isFalse);
      expect(swarmMayPauseAgent(reader, 'a-gone'), isFalse);

      final owned = await read([theirs('a-theirs')]);
      expect(swarmMayPauseAgent(owned, 'a-theirs'), isTrue);
    });

    test('never a viewer, nor on a Product Manager', () async {
      final viewer = await read(role: 'viewer', [agent('a-mine')]);
      expect(swarmMayPauseAgent(viewer, 'a-mine'), isFalse);

      final pm = await read([
        {...agent('a-pm'), 'kind': 'pm'},
      ]);
      expect(swarmMayPauseAgent(pm, 'a-pm'), isFalse);
    });
  });

  group('Your Team on Home', () {
    late FakeSwarm fake;
    late SwarmHost host;
    late _Computers computers;

    /// One of [me]'s agents on the Mac Studio, with its own chat.
    Map<String, dynamic> mine(
      String id,
      String name, [
      Map<String, dynamic> fields = const {},
    ]) => {
      ...agent(id, displayName: name, machineId: 'mac-studio'),
      'chatId': 'chat-$id',
      ...fields,
    };

    var cursor = 2;

    /// The Swarm read again: [agents] changed, and [me] as [role] if set.
    void next({List<Map<String, dynamic>> agents = const [], String? role}) {
      final at = cursor++;
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c$at'),
        'agents': [for (final a in agents) part(a['id'] as String, at, a)],
        if (role != null) 'members': [part(me, at, person(me, role: role))],
      };
    }

    Future<void> pump(
      WidgetTester tester,
      List<Map<String, dynamic>> agents, {
      String role = 'owner',
    }) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      cursor = 2;
      fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          agents: agents,
          machines: [
            {'machineId': 'mac-studio', 'name': 'Mac Studio'},
          ],
          groups: [
            for (final a in agents)
              {
                ...groupData(
                  a['chatId'] as String,
                  title: 'Chat',
                  kind: 'agent-chat',
                  agentIds: [a['id'] as String],
                  audience: [me],
                ),
                'projectId': null,
              },
          ],
        ),
        'members': [part(me, 1, person(me, role: role))],
      };
      next();
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => {'result': {}};
      computers = _Computers();
      addTearDown(computers.agents.dispose);
      addTearDown(computers.dispose);
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        computers: computers,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          onGenerateRoute: (_) =>
              CupertinoPageRoute<void>(builder: (_) => const SwarmPage()),
        ),
      );
      await tester.pumpAndSettle();
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder row(String id) => key('swarm-agent-$tab-$id');
    String? stateOf(WidgetTester tester, String id) {
      final state = find.descendant(
        of: row(id),
        matching: key('swarm-agent-state'),
      );
      return state.evaluate().isEmpty ? null : tester.widget<Text>(state).data;
    }

    Future<void> readAgain(WidgetTester tester) async {
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
    }

    testWidgets('each row says what its agent does, in grey at its end; '
        'nothing for one the phone knows nothing of', (tester) async {
      await pump(tester, [
        mine('a-ada', 'Ada', {'pausedAt': '2026-11-12T07:00:00.000Z'}),
        mine('a-bo', 'Bo', {
          'alerting': ['prompt'],
        }),
        mine('a-cy', 'Cy'),
        mine('a-di', 'Di', {'downSince': '2026-11-12T07:00:00.000Z'}),
        mine('a-ed', 'Ed'),
      ]);
      computers.agents.activities['mac-studio/harness-a-cy'] =
          SwarmHarnessActivity.working;
      computers.agents.tell();
      await tester.pump();

      expect(stateOf(tester, 'a-ada'), 'paused');
      expect(stateOf(tester, 'a-bo'), 'needs you');
      expect(stateOf(tester, 'a-cy'), 'working');
      expect(stateOf(tester, 'a-di'), 'offline');
      expect(stateOf(tester, 'a-ed'), isNull);
      final word = tester.widget<Text>(
        find.descendant(of: row('a-ada'), matching: key('swarm-agent-state')),
      );
      expect(word.style?.color, AppPalette.textFaint);
      expect(word.style?.fontSize, 13);
      expect(
        tester.getTopLeft(key('swarm-agent-state').first).dx,
        greaterThan(
          tester
              .getTopRight(
                find.descendant(of: row('a-ada'), matching: find.text('Ada')),
              )
              .dx,
        ),
        reason: 'after its name, as Desktop\'s row detail',
      );
    });

    testWidgets('a row follows what its computer says, without the Swarm '
        'read again', (tester) async {
      await pump(tester, [mine('a-ada', 'Ada')]);
      expect(stateOf(tester, 'a-ada'), isNull);

      computers.agents.activities['mac-studio/harness-a-ada'] =
          SwarmHarnessActivity.working;
      computers.agents.tell();
      await tester.pump();
      expect(stateOf(tester, 'a-ada'), 'working');

      computers.agents.activities['mac-studio/harness-a-ada'] =
          SwarmHarnessActivity.needsInput;
      computers.agents.tell();
      await tester.pump();
      expect(stateOf(tester, 'a-ada'), 'needs you');
    });

    testWidgets('a long press gives Pause, which sends agent.pause and says '
        'paused; then Resume', (tester) async {
      await pump(tester, [mine('a-ada', 'Ada')]);

      await tester.longPress(row('a-ada'));
      await tester.pumpAndSettle();
      expect(find.text('Ada'), findsNWidgets(2), reason: 'the sheet is its');
      expect(find.text('Resume'), findsNothing);
      next(
        agents: [
          mine('a-ada', 'Ada', {'pausedAt': '2026-11-12T08:00:00.000Z'}),
        ],
      );
      await tester.tap(find.text('Pause'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {'type': 'agent.pause', 'agentId': 'a-ada', 'paused': true},
      ]);
      expect(find.text('Pause'), findsNothing, reason: 'the sheet is gone');
      expect(stateOf(tester, 'a-ada'), 'paused');

      await tester.longPress(row('a-ada'));
      await tester.pumpAndSettle();
      expect(find.text('Pause'), findsNothing);
      next(agents: [mine('a-ada', 'Ada')]);
      await tester.tap(find.text('Resume'));
      await tester.pumpAndSettle();

      expect(fake.commands.last, {
        'type': 'agent.pause',
        'agentId': 'a-ada',
        'paused': false,
      });
      expect(stateOf(tester, 'a-ada'), isNull);
    });

    testWidgets('no menu for a viewer: a long press is a tap, its chat', (
      tester,
    ) async {
      await pump(tester, role: 'viewer', [mine('a-ada', 'Ada')]);
      await tester.longPress(row('a-ada'));
      await tester.pumpAndSettle();

      expect(find.text('Pause'), findsNothing);
      expect(
        tester
            .widget<SwarmConversationPage>(find.byType(SwarmConversationPage))
            .conversationId,
        'chat-a-ada',
      );
      expect(fake.commands, isEmpty);
    });

    testWidgets('no menu on a Product Manager, which gives the work', (
      tester,
    ) async {
      await pump(tester, [
        mine('a-pm', 'Pia', {'kind': 'pm'}),
      ]);
      await tester.longPress(row('a-pm'));
      await tester.pumpAndSettle();
      expect(find.text('Pause'), findsNothing);
      expect(fake.commands, isEmpty);
    });

    testWidgets('a refusal says why at the foot of the screen, and the row '
        'stays as it was', (tester) async {
      await pump(tester, [mine('a-ada', 'Ada')]);
      fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure(
            'FORBIDDEN',
            "Only its person, its machine's owner or the Swarm's owner can "
                'pause it.',
            statusCode: 403,
          );

      await tester.longPress(row('a-ada'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pause'));
      await tester.pumpAndSettle();

      expect(key('swarm-agent-pause-failed'), findsOneWidget);
      expect(
        find.text(
          "Only its person, its machine's owner or the Swarm's owner can "
          'pause it.',
        ),
        findsOneWidget,
      );
      expect(stateOf(tester, 'a-ada'), isNull);
    });

    testWidgets('a call lost on the way says so', (tester) async {
      await pump(tester, [mine('a-ada', 'Ada')]);
      fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw StateError('socket closed');

      await tester.longPress(row('a-ada'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pause'));
      await tester.pumpAndSettle();

      expect(
        find.text('Could not reach this Swarm. Try again.'),
        findsOneWidget,
      );
    });

    testWidgets('the menu goes once the reader may no longer pause: made a '
        'viewer while it is open', (tester) async {
      await pump(tester, [mine('a-ada', 'Ada')]);
      await tester.longPress(row('a-ada'));
      await tester.pumpAndSettle();
      expect(find.text('Pause'), findsOneWidget);

      next(role: 'viewer');
      await readAgain(tester);

      expect(find.text('Pause'), findsNothing);
      expect(fake.commands, isEmpty);
    });

    testWidgets('the menu says Resume when the agent is paused while it is '
        'open', (tester) async {
      await pump(tester, [mine('a-ada', 'Ada')]);
      await tester.longPress(row('a-ada'));
      await tester.pumpAndSettle();

      next(
        agents: [
          mine('a-ada', 'Ada', {'pausedAt': '2026-11-12T08:00:00.000Z'}),
        ],
      );
      await readAgain(tester);

      expect(find.text('Pause'), findsNothing);
      expect(find.text('Resume'), findsOneWidget);
    });
  });
}
