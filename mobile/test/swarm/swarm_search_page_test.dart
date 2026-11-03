import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show buildAppTheme;
import 'package:harness_mobile/swarm/swarm_agents.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_search_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart' show SwarmComputers;

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// The person's agents as a test sets them.
class _Agents extends ChangeNotifier implements SwarmAgents {
  @override
  int? working = 1;

  @override
  List<SwarmAgentRef> agents = [
    (
      machineId: 'mac-1',
      agentId: 'one',
      name: 'Wren',
      machine: 'Studio',
      engine: 'claude',
      working: true,
      waiting: false,
    ),
    (
      machineId: 'mac-2',
      agentId: 'two',
      name: 'Ivy',
      machine: 'Mac mini',
      engine: null,
      working: false,
      waiting: true,
    ),
  ];

  final opened = <String>[];

  void keep(int count) {
    agents = agents.take(count).toList();
    notifyListeners();
  }

  @override
  void openList(BuildContext context) {}

  @override
  void open(BuildContext context, SwarmAgentRef agent) =>
      opened.add(agent.agentId);
}

/// Computers that also have the person's agents, as the app's do.
class _AgentComputers extends FakeComputers implements SwarmAgentsSource {
  _AgentComputers() : super(const []);

  @override
  final _Agents agents = _Agents();
}

/// Search (Slack's, Tony 2026-11-03), from Home's search field or a pull at
/// its top: Recent · Projects · Chats · Agents. Over a scripted backend: one
/// Swarm whose person reads Mobile, Web, Team (private, theirs) and Điện
/// thoại, not Secret (private, another's); Mobile has their Buddy chat with
/// Wren and another person's; Web their archived Buddy chat. A second Swarm,
/// Lab, has a Mobile too.
void main() {
  const web = 'project-2', team = 'project-3', secret = 'project-4';
  const phone = 'project-5';
  const webLead = 'group-lead-web', teamLead = 'group-lead-team';
  const secretLead = 'group-lead-secret', phoneLead = 'group-lead-phone';
  const buddyChat = 'buddy-me';
  const other = 'person-other';
  const lab = 'tab-2';

  Map<String, dynamic> projectRow(
    String id,
    String name,
    String lead, {
    bool private = false,
    String owner = me,
    List<String> members = const [],
  }) => {
    'id': id,
    'name': name,
    'ownerId': owner,
    'leadConversationId': lead,
    'visibility': private ? 'private' : 'public',
    'members': [
      for (final member in members) {'id': member, 'generation': 'gen-$member'},
    ],
    'updateMinutes': 5,
  };

  Map<String, dynamic> inProject(String id, Map<String, dynamic> row) => {
    ...row,
    'projectId': id,
  };

  final readable = [
    projectRow(project, 'Mobile', leadChat),
    projectRow(web, 'Web', webLead),
    projectRow(
      team,
      'Team',
      teamLead,
      private: true,
      owner: other,
      members: [me],
    ),
    projectRow(secret, 'Secret', secretLead, private: true, owner: other),
    projectRow(phone, 'Điện thoại', phoneLead),
  ];

  void serve(
    FakeSwarm fake, {
    String tabId = tab,
    String name = 'Phone Swarm',
    List<Map<String, dynamic>>? projects,
  }) {
    fake.routes['/api/super-tabs/$tabId/parts'] = (_) => {
      ...firstLoad(
        tabId: tabId,
        head: headData(id: tabId, name: name, projects: projects ?? readable),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          buddyData('agent-wren', displayName: 'Wren'),
          buddyData('agent-ivy', owner: other, displayName: 'Ivy'),
        ],
        groups: [
          inProject(web, groupData(webLead, title: 'Web')),
          inProject(team, groupData(teamLead, title: 'Team')),
          inProject(secret, groupData(secretLead, title: 'Secret')),
          inProject(phone, groupData(phoneLead, title: 'Điện thoại')),
          buddyChatData(buddyChat, agentIds: ['agent-wren']),
          buddyChatData('buddy-other', owner: other, agentIds: ['agent-ivy']),
          inProject(web, {...buddyChatData('buddy-me-web'), 'archived': true}),
        ],
      ),
      'members': [
        part(me, 1, person(me)),
        part(other, 1, person(other, role: 'collaborator')),
      ],
    };
    fake.routes['/api/super-tabs/$tabId/changes'] = (_) =>
        changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tabId/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tabId/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tabId/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    for (final chat in [leadChat, webLead, teamLead, phoneLead, buddyChat]) {
      fake.routes['/api/super-tabs/$tabId/conversations/$chat/messages'] = (
        _,
      ) => {'messages': <Object>[], 'next': null};
    }
  }

  FakeSwarm backend({bool twoSwarms = false}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        if (twoSwarms) {'id': lab, 'name': 'Lab Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    serve(fake);
    if (twoSwarms) {
      serve(
        fake,
        tabId: lab,
        name: 'Lab Swarm',
        projects: [projectRow(project, 'Mobile', leadChat)],
      );
    }
    return fake;
  }

  /// Swarm on, on an iPhone's screen, 390 points wide: Home at the root of
  /// its stack, or Search itself with [search].
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    SwarmComputers? computers,
    bool search = false,
    bool settle = true,
    ThemeData? theme,
  }) async {
    tester.view.physicalSize = const Size(390, 844) * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
      computers: computers,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme,
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        onGenerateRoute: (_) => CupertinoPageRoute<void>(
          builder: (_) => search ? const SwarmSearchPage() : const SwarmPage(),
        ),
      ),
    );
    settle ? await tester.pumpAndSettle() : await tester.pump();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder hit(String value) => key('swarm-search-hit-$value');
  Finder chip(SwarmSearchKind kind) => key('swarm-search-kind-${kind.name}');
  Finder inside(Finder of, Finder matching) =>
      find.descendant(of: of, matching: matching);
  double y(WidgetTester tester, Finder finder) => tester.getTopLeft(finder).dy;
  final field = inside(key('swarm-search-field'), find.byType(EditableText));

  Future<void> openSearch(WidgetTester tester) async {
    await tester.tap(key('swarm-home-search'));
    await tester.pumpAndSettle();
  }

  Future<void> type(WidgetTester tester, String text) async {
    await tester.enterText(field, text);
    await tester.pumpAndSettle();
  }

  /// A tap on [kind]'s chip, the row scrolled to it first as a thumb would.
  Future<void> choose(WidgetTester tester, SwarmSearchKind kind) async {
    await tester.ensureVisible(chip(kind));
    await tester.pumpAndSettle();
    await tester.tap(chip(kind));
    await tester.pumpAndSettle();
  }

  /// Whether [kind]'s chip is the open one, as a screen reader hears it.
  void expectOpen(WidgetTester tester, SwarmSearchKind kind) {
    for (final each in SwarmSearchKind.values) {
      if (chip(each).evaluate().isEmpty) continue;
      expect(
        tester.getSemantics(chip(each)),
        isSemantics(isButton: true, isSelected: each == kind),
        reason: each.name,
      );
    }
  }

  /// The open page's rows, top to bottom.
  List<String> rows(WidgetTester tester) {
    final found = find.byWidgetPredicate(
      (w) =>
          w.key is ValueKey<String> &&
          (w.key! as ValueKey<String>).value.startsWith('swarm-search-hit-'),
    );
    final hits = found.evaluate().toList()
      ..sort(
        (a, b) => (a.renderObject! as RenderBox)
            .localToGlobal(Offset.zero)
            .dy
            .compareTo(
              (b.renderObject! as RenderBox).localToGlobal(Offset.zero).dy,
            ),
      );
    return [
      for (final element in hits)
        (element.widget.key! as ValueKey<String>).value.substring(
          'swarm-search-hit-'.length,
        ),
    ];
  }

  group('the ways in', () {
    testWidgets("the top bar's Search opens it, its field focused for typing, "
        'with Recent, Projects and Chats; no Agents without the agents', (
      tester,
    ) async {
      await pump(tester, backend());

      await openSearch(tester);

      expect(find.byType(SwarmSearchPage), findsOneWidget);
      expect(tester.widget<EditableText>(field).focusNode.hasFocus, isTrue);
      expect(find.text('Search chats, projects, agents'), findsOneWidget);
      for (final kind in [
        SwarmSearchKind.recent,
        SwarmSearchKind.projects,
        SwarmSearchKind.chats,
      ]) {
        expect(chip(kind), findsOneWidget);
      }
      expect(chip(SwarmSearchKind.agents), findsNothing);
      expectOpen(tester, SwarmSearchKind.recent);
    });

    testWidgets('a pull down at the top of Home opens it', (tester) async {
      await pump(tester, backend());
      final gesture = await tester.startGesture(
        tester.getTopLeft(key('swarm-home-list')) + const Offset(195, 40),
      );
      for (var i = 0; i < 15; i++) {
        await gesture.moveBy(const Offset(0, 10));
        await tester.pump();
      }
      await gesture.up();
      await tester.pumpAndSettle();

      expect(find.byType(SwarmSearchPage), findsOneWidget);
    });

    testWidgets('back comes back to Home', (tester) async {
      await pump(tester, backend());
      await openSearch(tester);

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmSearchPage), findsNothing);
      expect(key('swarm-home-search'), findsOneWidget);
    });

    testWidgets('Home has no search field: Search is a button on its top bar, '
        'before the avatar, heard as Search (Tony, 2026-11-03)', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await pump(tester, backend());

      expect(key('swarm-search-pill'), findsNothing);
      expect(find.text('Search chats, projects, agents'), findsNothing);
      expect(
        tester.getSemantics(key('swarm-home-search')),
        isSemantics(label: 'Search', isButton: true, hasTapAction: true),
      );
      expect(
        tester.getCenter(key('swarm-home-search')).dy,
        closeTo(tester.getCenter(key('swarm-you-button')).dy, .01),
        reason: 'on the top bar',
      );
      expect(
        tester.getTopLeft(key('swarm-home-search')).dx,
        lessThan(tester.getTopLeft(key('swarm-you-button')).dx),
        reason: 'the avatar last',
      );
      expect(
        tester.getBottomLeft(key('swarm-home-search')).dy,
        lessThanOrEqualTo(tester.getTopLeft(key('swarm-home-list')).dy),
        reason: 'over the list, not in it',
      );
      handle.dispose();
    });
  });

  group('its field', () {
    testWidgets("takes none of the app's field look, focused or not: no "
        'outline, which the pill cut to two blue arcs, and no fill of its '
        'own', (tester) async {
      for (final brightness in Brightness.values) {
        await pump(
          tester,
          backend(),
          search: true,
          theme: buildAppTheme(brightness: brightness),
        );
        final decorator = tester.widget<InputDecorator>(
          inside(key('swarm-search-field'), find.byType(InputDecorator)),
        );

        expect(decorator.isFocused, isTrue, reason: 'it opens focused');
        final decoration = decorator.decoration;
        expect(
          decoration.focusedBorder,
          InputBorder.none,
          reason: '$brightness',
        );
        expect(
          decoration.enabledBorder,
          InputBorder.none,
          reason: '$brightness',
        );
        expect(decoration.border, InputBorder.none, reason: '$brightness');
        expect(decoration.filled, isFalse, reason: '$brightness');
      }
    });
  });

  group('what it finds', () {
    testWidgets('Projects: each the person reads, by Swarm; never a private '
        "one of someone else's", (tester) async {
      await pump(tester, backend(twoSwarms: true), search: true);

      await choose(tester, SwarmSearchKind.projects);

      expect(rows(tester), [
        'project-$tab-$project',
        'project-$tab-$web',
        'project-$tab-$team',
        'project-$tab-$phone',
        'project-$lab-$project',
      ]);
      expect(
        inside(hit('project-$lab-$project'), find.text('Lab Swarm')),
        findsOneWidget,
        reason: 'which Mobile it is',
      );
      expect(find.text('#Secret'), findsNothing);
    });

    testWidgets("Chats: the person's own Buddy chat, by its Buddy and "
        "project; not another's, nor one archived", (tester) async {
      await pump(tester, backend(), search: true);

      await choose(tester, SwarmSearchKind.chats);

      expect(rows(tester), ['chat-$tab-$buddyChat']);
      expect(
        inside(hit('chat-$tab-$buddyChat'), find.text('Wren · Mobile')),
        findsOneWidget,
      );
    });

    testWidgets('Recent before anything is typed: what moved, last first', (
      tester,
    ) async {
      await pump(tester, backend(), search: true);

      final recent = rows(tester);

      expect(recent, isNotEmpty);
      expect(recent, isNot(contains('project-$tab-$secret')));
      expect(recent.length, lessThanOrEqualTo(swarmSearchRecent));
    });

    testWidgets('typed: Recent becomes All and lists every kind, what starts '
        'with it first, then a word starting with it', (tester) async {
      await pump(tester, backend(), search: true);

      await type(tester, 'mo');

      expect(inside(chip(SwarmSearchKind.recent), find.text('All')), findsOne);
      expect(rows(tester), ['project-$tab-$project', 'chat-$tab-$buddyChat']);
    });

    testWidgets('case and accents aside', (tester) async {
      await pump(tester, backend(), search: true);

      await type(tester, 'DIEN');

      expect(rows(tester), ['project-$tab-$phone']);
      expect(find.text('#Điện thoại'), findsOneWidget);
    });

    testWidgets("a Swarm's name finds what is in it", (tester) async {
      await pump(tester, backend(twoSwarms: true), search: true);

      await type(tester, 'lab');

      expect(rows(tester), ['project-$lab-$project', 'chat-$lab-$buddyChat']);
    });

    testWidgets('nothing matches says so; Clear empties the field and the '
        'list comes back', (tester) async {
      await pump(tester, backend(), search: true);
      final before = rows(tester);

      await type(tester, 'zzz');

      expect(rows(tester), isEmpty);
      expect(find.text('Nothing matches “zzz”.'), findsOneWidget);

      await tester.tap(key('swarm-search-clear'));
      await tester.pumpAndSettle();

      expect(tester.widget<EditableText>(field).controller.text, isEmpty);
      expect(key('swarm-search-clear'), findsNothing);
      expect(rows(tester), before);
      expect(
        inside(chip(SwarmSearchKind.recent), find.text('Recent')),
        findsOne,
      );
    });
  });

  group('chips and pages', () {
    testWidgets('a tap on a chip turns to its page; a sideways swipe turns '
        'it too, and the chip follows', (tester) async {
      await pump(tester, backend(), search: true);

      await choose(tester, SwarmSearchKind.chats);

      expectOpen(tester, SwarmSearchKind.chats);
      expect(key('swarm-search-page-chats'), findsOneWidget);

      await tester.fling(key('swarm-search-pages'), const Offset(300, 0), 1000);
      await tester.pumpAndSettle();

      expectOpen(tester, SwarmSearchKind.projects);
      expect(rows(tester), contains('project-$tab-$web'));
    });

    testWidgets('what is typed holds on every page', (tester) async {
      await pump(tester, backend(), search: true);
      await type(tester, 'web');

      await choose(tester, SwarmSearchKind.projects);
      expect(rows(tester), ['project-$tab-$web']);

      await choose(tester, SwarmSearchKind.chats);
      expect(rows(tester), isEmpty);
      expect(find.text('Nothing matches “web”.'), findsOneWidget);
    });
  });

  group('opening', () {
    testWidgets('a project opens over Search, and back finds Search as it '
        'was left', (tester) async {
      await pump(tester, backend());
      await openSearch(tester);
      await type(tester, 'web');

      await tester.tap(hit('project-$tab-$web'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmProjectPage), findsOneWidget);

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmSearchPage), findsOneWidget);
      expect(tester.widget<EditableText>(field).controller.text, 'web');
      expect(rows(tester), ['project-$tab-$web']);
    });

    testWidgets('their Buddy chat opens it', (tester) async {
      await pump(tester, backend());
      await openSearch(tester);
      await choose(tester, SwarmSearchKind.chats);

      await tester.tap(hit('chat-$tab-$buddyChat'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmConversationPage), findsOneWidget);
    });
  });

  group('agents', () {
    testWidgets('with the computers\' agents: an Agents chip, each agent by '
        'its computer and engine, and a tap opens it', (tester) async {
      final computers = _AgentComputers();
      addTearDown(computers.dispose);
      await pump(tester, backend(), computers: computers, search: true);

      await choose(tester, SwarmSearchKind.agents);

      expect(rows(tester), ['agent-mac-1-one', 'agent-mac-2-two']);
      expect(
        inside(hit('agent-mac-1-one'), find.text('Studio · claude')),
        findsOne,
      );
      expect(inside(hit('agent-mac-2-two'), find.text('Mac mini')), findsOne);

      await tester.tap(hit('agent-mac-2-two'));
      expect(computers.agents.opened, ['two']);
    });

    testWidgets('a swipe on to Agents brings its chip into sight on a '
        'narrow phone', (tester) async {
      final computers = _AgentComputers();
      addTearDown(computers.dispose);
      await pump(tester, backend(), computers: computers, search: true);
      // Recent to Agents by swipes alone: the chips never touched.
      for (var i = 0; i < 3; i++) {
        await tester.fling(
          key('swarm-search-pages'),
          const Offset(-300, 0),
          1000,
        );
        await tester.pumpAndSettle();
      }

      expectOpen(tester, SwarmSearchKind.agents);
      expect(rows(tester), ['agent-mac-1-one', 'agent-mac-2-two']);
      final agents = tester.getRect(chip(SwarmSearchKind.agents));
      expect(agents.left, greaterThanOrEqualTo(0));
      expect(agents.right, lessThanOrEqualTo(390));
    });

    testWidgets('typed, an agent is found by name or by its computer', (
      tester,
    ) async {
      final computers = _AgentComputers();
      addTearDown(computers.dispose);
      await pump(tester, backend(), computers: computers, search: true);

      await type(tester, 'ivy');
      expect(rows(tester), ['agent-mac-2-two']);

      await type(tester, 'studio');
      expect(rows(tester), ['agent-mac-1-one']);
    });

    testWidgets('an agent gone from the computers goes from the list', (
      tester,
    ) async {
      final computers = _AgentComputers();
      addTearDown(computers.dispose);
      await pump(tester, backend(), computers: computers, search: true);
      await choose(tester, SwarmSearchKind.agents);

      computers.agents.keep(1);
      await tester.pumpAndSettle();

      expect(rows(tester), ['agent-mac-1-one']);
    });
  });

  group('while it reads, and when it cannot', () {
    testWidgets('while the Swarms are read: a skeleton, never "nothing"', (
      tester,
    ) async {
      final fake = backend();
      final held = Completer<Object?>();
      fake.routes['/api/super-tabs/list'] = (_) => held.future;
      await pump(tester, fake, search: true, settle: false);
      await tester.pump();

      expect(key('swarm-search-loading'), findsOneWidget);
      expect(key('swarm-search-none'), findsNothing);

      held.complete({
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      });
      await tester.pumpAndSettle();

      expect(key('swarm-search-loading'), findsNothing);
      expect(rows(tester), isNotEmpty);
    });

    testWidgets('a Swarm that could not be read: said, over what the others '
        'have', (tester) async {
      final fake = backend(twoSwarms: true);
      fake.routes['/api/super-tabs/$lab/parts'] = (_) =>
          throw SuperTabFailure('INTERNAL', 'down', statusCode: 500);
      await pump(tester, fake, search: true);

      await choose(tester, SwarmSearchKind.projects);

      expect(find.text('Some Swarms could not be read.'), findsOneWidget);
      expect(rows(tester), contains('project-$tab-$web'));
      expect(rows(tester), isNot(contains('project-$lab-$project')));
    });
  });

  testWidgets('with the keyboard up: the field and chips stay on the screen, '
      'the results end at the keyboard, and dragging them puts it away', (
    tester,
  ) async {
    await pump(tester, backend(), search: true);
    const keyboard = 336.0;
    tester.view.viewInsets = const FakeViewPadding(bottom: keyboard * 3);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull, reason: 'no overflow');
    expect(y(tester, key('swarm-search-field')), greaterThanOrEqualTo(0));
    expect(
      tester.getBottomLeft(chip(SwarmSearchKind.recent)).dy,
      lessThan(844 - keyboard),
    );
    expect(
      tester.getBottomLeft(key('swarm-search-pages')).dy,
      closeTo(844 - keyboard, 0.5),
      reason: 'once, not two keyboards up',
    );
    expect(tester.widget<EditableText>(field).focusNode.hasFocus, isTrue);

    await tester.drag(key('swarm-search-page-recent'), const Offset(0, -80));
    await tester.pumpAndSettle();

    expect(tester.widget<EditableText>(field).focusNode.hasFocus, isFalse);
  });

  group('swarmSearchFind', () {
    SwarmSearchHit h(
      String key,
      String title, {
      SwarmSearchKind kind = SwarmSearchKind.projects,
      String detail = 'Phone Swarm',
      int? at,
    }) => SwarmSearchHit(
      kind: kind,
      key: key,
      title: title,
      detail: detail,
      at: at == null ? null : DateTime(2026, 11, 3, 9, at),
      open: (_) {},
    );

    List<String> keys(List<SwarmSearchHit> hits) => [
      for (final hit in hits) hit.key,
    ];

    test('nothing typed: Recent is what moved, last first, at most '
        '$swarmSearchRecent; any other kind all of it, as listed', () {
      final hits = [
        for (var i = 0; i < 15; i++) h('p$i', '#p$i', at: i),
        h('never', '#never'),
        h('chat', 'Wren · p1', kind: SwarmSearchKind.chats, at: 30),
      ];

      final recent = keys(swarmSearchFind(hits, SwarmSearchKind.recent, ' '));
      expect(recent, hasLength(swarmSearchRecent));
      expect(recent.take(3), ['chat', 'p14', 'p13']);
      expect(recent, isNot(contains('never')));

      expect(keys(swarmSearchFind(hits, SwarmSearchKind.projects, '')), [
        for (var i = 0; i < 15; i++) 'p$i',
        'never',
      ]);
      expect(keys(swarmSearchFind(hits, SwarmSearchKind.chats, '')), ['chat']);
    });

    test('typed: starts with it, then a word starts with it, then holds it, '
        'then where it is; the catalog order within each', () {
      final hits = [
        h('where', '#alpha', detail: 'Web Swarm'),
        h('holds', '#cobweb'),
        h('word', 'Wren · web'),
        h('starts', '#web'),
        h('starts-too', '#Website'),
        h('none', '#other'),
      ];

      expect(keys(swarmSearchFind(hits, SwarmSearchKind.recent, 'web')), [
        'starts',
        'starts-too',
        'word',
        'holds',
        'where',
      ]);
    });

    test('a # typed or not finds a project alike', () {
      final hits = [h('mobile', '#Mobile')];

      expect(keys(swarmSearchFind(hits, SwarmSearchKind.projects, '#mo')), [
        'mobile',
      ]);
      expect(keys(swarmSearchFind(hits, SwarmSearchKind.projects, 'MO')), [
        'mobile',
      ]);
    });

    test('typed on a kind: only that kind', () {
      final hits = [
        h('project', '#web'),
        h('chat', 'Wren · web', kind: SwarmSearchKind.chats),
      ];

      expect(keys(swarmSearchFind(hits, SwarmSearchKind.chats, 'web')), [
        'chat',
      ]);
    });
  });
}
