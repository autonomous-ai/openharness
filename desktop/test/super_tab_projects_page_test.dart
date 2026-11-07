import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart' show SuperTabProject;
import 'package:harness/super_tabs/projects_page.dart';
import 'package:harness/widgets/swarm_search_field.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// The Projects page as GitHub lists an org's repositories (task #4662, anh Dee 11-07 21:15): a title with the count,
/// Find a project and Sort, then one bordered list, a row per project with its name and visibility, its purpose, its
/// Lead, members, open work, repository and last update, and a grey sparkline of 4 weeks of shipped tasks.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  final now = DateTime.utc(2026, 11, 7, 14);

  Map<String, dynamic> agent(String id, String projectId, {String? kind}) => {
    'id': id,
    'projectId': projectId,
    'name': id,
    'displayName': id[0].toUpperCase() + id.substring(1),
    'machineId': 'host',
    'harnessId': 'session-$id',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude'},
    'kind': ?kind,
  };

  Map<String, dynamic> pulse({int working = 0, int toDo = 0}) => {
    'pmId': null,
    'asks': {'count': 0, 'oldestAt': null, 'personId': null, 'list': []},
    'working': {'count': working, 'crew': 0, 'agentIds': <String>[]},
    'nextUp': {'count': toDo, 'conversationIds': <String>[]},
    'lost': {'count': 0, 'since': null, 'conversationIds': <String>[]},
    'held': {'count': 0, 'withoutReason': 0, 'list': []},
    'idleSince': null,
    'process': null,
    'redAt': {'asks': null, 'idle': null, 'lost': null, 'held': null},
    'limits': {'askMinutes': 5, 'idleMinutes': 10, 'lostMinutes': 10},
  };

  List<int> days(Map<int, int> shipped) => [
    for (var i = 0; i < 28; i++) shipped[i] ?? 0,
  ];

  /// web-project (the harness: Lead River, six members, busy, updated 2 minutes ago), api (Lead Faye, one member, a
  /// purpose, updated an hour ago) and docs (private, nothing else, updated yesterday).
  void projects(ConversationServer server) {
    final groups = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    (server.state['projects'] as List)
      ..first.addAll({
        'about':
            'The harness for coding agents and beyond. All your agents, all '
            'your machines, one command center.',
        'repository': {
          'repositoryUrl': 'https://github.com/autonomous-ai/openharness.git',
        },
      })
      ..addAll(<Map<String, dynamic>>[
        {
          ...projectFixture('api', 'api', 'api-lead'),
          'about': 'The open-source operating system for physical AI.',
          'repository': {
            'repositoryUrl': 'https://github.com/autonomous-ai/lampOS',
          },
        },
        projectFixture('docs', 'docs', 'docs-lead', visibility: 'private'),
      ]);
    groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'river';
    groups.addAll(<Map<String, dynamic>>[
      {
        ...conversationFixture('api-lead', 'api'),
        'projectId': 'api',
        'leadId': 'faye',
        'lastMessageSequence': 90,
      },
      {
        ...conversationFixture('docs-lead', 'docs'),
        'projectId': 'docs',
        'lastMessageSequence': 40,
      },
    ]);
    server.state['agents'] = [
      agent('river', 'lead', kind: 'pm'),
      for (final name in ['kai', 'sage', 'vetch', 'jules', 'quinn', 'lark'])
        agent(name, 'lead'),
      agent('faye', 'api', kind: 'pm'),
      agent('nico', 'api'),
      // A Buddy is nobody's member.
      {
        ...agent('buddy', 'lead', kind: 'buddy'),
        'buddyOf': {'personId': 'owner'},
      },
    ];
    server.state['pulse'] = {
      'lead': pulse(working: 12, toDo: 3),
      'api': pulse(working: 1),
      'docs': pulse(),
    };
    server.projectActivity = {
      'through': '2026-11-07',
      'projects': [
        {
          'projectId': 'lead',
          'shipped': days({20: 3, 27: 5}),
          'updatedAt': now
              .subtract(const Duration(minutes: 2))
              .millisecondsSinceEpoch,
        },
        {
          'projectId': 'api',
          'shipped': days({}),
          'updatedAt': now
              .subtract(const Duration(hours: 1))
              .millisecondsSinceEpoch,
        },
        {
          'projectId': 'docs',
          'shipped': days({3: 1}),
          'updatedAt': now
              .subtract(const Duration(hours: 30))
              .millisecondsSinceEpoch,
        },
      ],
    };
  }

  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    void Function(ConversationServer server)? setup,
    List<SuperTabProject>? opened,
    List<String>? repositories,
    VoidCallback? onNewProject,
    Brightness brightness = Brightness.light,
    Size size = const Size(1140, 800),
  }) async {
    final server = swarm();
    setup?.call(server);
    final c = server.controller(account: 'owner');
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await withClock(Clock.fixed(now), () async {
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabProjectsPage(
              controller: c,
              onOpen: (project) => opened?.add(project),
              onNewProject: onNewProject,
              onOpenRepository: (url) => repositories?.add(url),
            ),
          ),
        ),
      );
      // The activity read answers, then the rows draw it.
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();
    });
    addTearDown(() => tester.pumpWidget(const SizedBox()));
    return (c, server);
  }

  List<String> rowOrder(WidgetTester tester) {
    final rows = find.byWidgetPredicate(
      (w) =>
          w.key is ValueKey<String> &&
          (w.key! as ValueKey<String>).value.startsWith('super-group-'),
    );
    final found = [
      for (final e in rows.evaluate())
        (
          (e.widget.key! as ValueKey<String>).value,
          tester.getTopLeft(find.byWidget(e.widget)).dy,
        ),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    return [for (final (k, _) in found) k];
  }

  String line(WidgetTester tester, String row) => [
    for (final text in tester.widgetList<Text>(
      find.descendant(
        of: key('super-project-meta-$row'),
        matching: find.byType(Text),
      ),
    ))
      text.data ?? text.textSpan!.toPlainText(),
  ].join(' | ');

  testWidgets('the title says Projects and its count; New project is the one '
      'blue button', (tester) async {
    var created = 0;
    await show(tester, setup: projects, onNewProject: () => created++);
    expect(find.text('Projects'), findsOneWidget);
    expect(key('super-projects-count'), findsOneWidget);
    expect(tester.widget<Text>(key('super-projects-count')).data, '3');
    expect(find.byType(FilledButton), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'New project'));
    expect(created, 1);
  });

  testWidgets('every project is a row in one bordered list, newest activity '
      'first', (tester) async {
    await show(tester, setup: projects);
    expect(rowOrder(tester), [
      'super-group-lead',
      'super-group-api-lead',
      'super-group-docs-lead',
    ]);
    final list = tester.widget<DecoratedBox>(key('super-projects-list'));
    final box = list.decoration as BoxDecoration;
    expect(box.borderRadius, BorderRadius.circular(12));
    expect(box.border, isNotNull);
  });

  testWidgets('a row: name 16 semibold and its visibility; the purpose; one '
      'quiet line of Lead, members, work, repository and update', (
    tester,
  ) async {
    await show(tester, setup: projects);
    final name = tester
        .widget<Text>(
          find.descendant(
            of: key('super-group-lead'),
            matching: find.text('web-project'),
          ),
        )
        .style!;
    expect(name.fontSize, 16);
    expect(name.fontWeight, grid.AppFont.semibold);
    expect(
      find.descendant(
        of: key('super-group-lead'),
        matching: find.text('Public'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: key('super-group-docs-lead'),
        matching: find.text('Private'),
      ),
      findsOneWidget,
    );
    final purpose = tester.widget<Text>(key('super-project-about-lead'));
    expect(purpose.maxLines, 2);
    expect(purpose.data, startsWith('The harness for coding agents'));
    // The Lead's face is a rounded square; four members, then +2 for the rest.
    expect(
      line(tester, 'lead'),
      'River | +2 | 12 working · 3 to do | openharness | Updated 2 minutes ago',
    );
    expect(key('super-project-lead-face-lead'), findsOneWidget);
    expect(key('super-project-member-faces-lead'), findsOneWidget);
    expect(
      find.descendant(
        of: key('super-project-member-faces-lead'),
        matching: find.byKey(const ValueKey('super-project-member-face')),
      ),
      findsNWidgets(4),
    );
    final meta = tester
        .widget<Text>(
          find.descendant(
            of: key('super-project-meta-lead'),
            matching: find.text('12 working · 3 to do'),
          ),
        )
        .style!;
    expect(meta.fontSize, 12);
    expect(meta.color, grid.AppPalette.textFaint);
  });

  // anh Dee 11-07, rule 7: nothing says None or No description; an empty value isn't drawn.
  testWidgets('empty values are left out: zero counts, no purpose, no '
      'members, no repository', (tester) async {
    await show(tester, setup: projects);
    expect(
      line(tester, 'api-lead'),
      'Faye | 1 working | lampOS | Updated 1 hour ago',
    );
    expect(key('super-project-about-docs-lead'), findsNothing);
    expect(line(tester, 'docs-lead'), 'Updated yesterday');
    for (final none in ['None', 'No description', '0 working', '0 to do']) {
      expect(find.textContaining(none), findsNothing, reason: none);
    }
  });

  testWidgets('each row has a grey 4-week sparkline of tasks shipped', (
    tester,
  ) async {
    final (_, server) = await show(tester, setup: projects);
    expect(server.projectActivityReads, 1);
    for (final row in ['lead', 'api-lead', 'docs-lead']) {
      expect(
        find.descendant(
          of: key('super-group-$row'),
          matching: find.byType(SuperTabSparkline),
        ),
        findsOneWidget,
        reason: row,
      );
    }
    final spark = tester.widget<SuperTabSparkline>(
      find.descendant(
        of: key('super-group-lead'),
        matching: find.byType(SuperTabSparkline),
      ),
    );
    expect(spark.values, hasLength(28));
    expect(spark.values.last, 5);
    expect(spark.color, grid.AppPalette.textFaint);
  });

  testWidgets('a server without the activity read draws rows without '
      'sparkline or Updated', (tester) async {
    await show(
      tester,
      setup: (server) {
        projects(server);
        server.projectActivity = null;
      },
    );
    expect(find.byType(SuperTabSparkline), findsNothing);
    expect(find.textContaining('Updated'), findsNothing);
    expect(rowOrder(tester), hasLength(3));
  });

  testWidgets('Find a project matches name and purpose', (tester) async {
    await show(tester, setup: projects);
    expect(
      tester.widget<SwarmSearchField>(find.byType(SwarmSearchField)).hintText,
      'Find a project',
    );
    await tester.enterText(find.byType(TextField), 'physical');
    await tester.pump();
    expect(rowOrder(tester), ['super-group-api-lead']);
    await tester.enterText(find.byType(TextField), 'DOCS');
    await tester.pump();
    expect(rowOrder(tester), ['super-group-docs-lead']);
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    expect(rowOrder(tester), hasLength(3));
  });

  testWidgets('Sort: Recent, Name or Most work', (tester) async {
    await show(tester, setup: projects);
    expect(find.text('Sort: Recent'), findsOneWidget);
    await tester.tap(key('super-projects-sort'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-projects-sort-name'));
    await tester.pumpAndSettle();
    expect(find.text('Sort: Name'), findsOneWidget);
    expect(rowOrder(tester), [
      'super-group-api-lead',
      'super-group-docs-lead',
      'super-group-lead',
    ]);
    await tester.tap(key('super-projects-sort'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-projects-sort-work'));
    await tester.pumpAndSettle();
    expect(find.text('Sort: Most work'), findsOneWidget);
    expect(rowOrder(tester), [
      'super-group-lead',
      'super-group-api-lead',
      'super-group-docs-lead',
    ]);
  });

  testWidgets('a row opens its project; the repository opens GitHub', (
    tester,
  ) async {
    final opened = <SuperTabProject>[], repositories = <String>[];
    await show(
      tester,
      setup: projects,
      opened: opened,
      repositories: repositories,
    );
    await tester.tap(key('super-group-docs-lead'));
    expect([for (final p in opened) p.id], ['docs']);
    final repository = key('super-project-repository-lead');
    expect(
      tester
          .widget<Tooltip>(
            find.ancestor(of: repository, matching: find.byType(Tooltip)).first,
          )
          .message,
      'autonomous-ai/openharness',
    );
    await tester.tap(repository);
    expect(repositories, ['https://github.com/autonomous-ai/openharness.git']);
    expect([for (final p in opened) p.id], ['docs']);
  });

  testWidgets('a reader who may not make one has no New project', (
    tester,
  ) async {
    await show(tester, setup: projects);
    expect(find.text('New project'), findsNothing);
  });

  // Rule 7: an empty Swarm shows the title and only the action that fills it.
  testWidgets('a Swarm with no projects shows only its title and New '
      'project', (tester) async {
    await show(
      tester,
      setup: (server) => server.state['projects'] = <Map<String, dynamic>>[],
      onNewProject: () {},
    );
    expect(
      [for (final t in tester.widgetList<Text>(find.byType(Text))) t.data],
      ['Projects', 'New project'],
    );
  });

  testWidgets('the list is at most 900 wide and fits 880 and 1440, light and '
      'dark, without overflow', (tester) async {
    for (final brightness in Brightness.values) {
      for (final width in [880.0 - 300, 1440.0 - 300]) {
        await show(
          tester,
          setup: projects,
          brightness: brightness,
          size: Size(width, 800),
        );
        expect(tester.takeException(), isNull);
        expect(
          tester.getSize(key('super-projects-list')).width,
          lessThanOrEqualTo(900),
        );
        await tester.pumpWidget(const SizedBox());
      }
    }
  });
}
