// Task #3211 (vie, 11-05): a project whose Product Manager started in a folder with no GitHub origin has no repository,
// so its agents elsewhere start in an empty folder. Its owner shares one from the project's details; one with no commit
// is refused in plain words, since other machines clone and branch from it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_options.dart';

import 'support/super_tab_fixture.dart';

void main() {
  late ConversationServer server;
  late List<Map<String, dynamic>> sent;
  late List<String> checked;
  int? branches;

  setUp(() {
    server = ConversationServer();
    sent = [];
    checked = [];
    branches = 1;
  });

  /// The Swarm's one project, its folder on the owner's Mac recorded with [repositoryUrl], read as [accountId].
  Future<SuperTabController> mount(
    WidgetTester tester, {
    String accountId = 'owner',
    String? repositoryUrl,
  }) async {
    server.state['projects'] = [
      {
        ...projectFixture('lead', 'Outreach', 'lead'),
        'repository': {
          'machineId': 'mac',
          'cwd': '/Users/vie/outreach',
          'repositoryUrl': repositoryUrl,
        },
      },
    ];
    final c = SuperTabController(
      tabId: 'tab',
      accountId: accountId,
      request: (method, path, {body}) async {
        if (body?['command'] case final Map<String, dynamic> command) {
          sent.add(command);
        }
        return server.request(method, path, body: body);
      },
      save: server.save,
      upload: server.upload,
      initial: const {},
      pollInterval: Duration.zero,
    );
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showProjectAction(
                context,
                c,
                c.snapshot!.projects.first,
                'details',
                branches: (url) async {
                  checked.add(url);
                  return branches;
                },
              ),
              child: const Text('Open details'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open details'));
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> share(WidgetTester tester, String address) async {
    await tester.enterText(find.byType(TextField), address);
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Share'));
    await tester.pumpAndSettle();
  }

  testWidgets('offers Share repository to the owner of a project with none, and to nobody else', (tester) async {
    await mount(tester);
    expect(find.text('/Users/vie/outreach'), findsOneWidget);
    expect(find.text('Share repository'), findsOneWidget);
  });

  testWidgets('offers nothing to another member', (tester) async {
    await mount(tester, accountId: 'peer');
    expect(find.text('Share repository'), findsNothing);
  });

  testWidgets('offers nothing once a repository is shared', (tester) async {
    await mount(tester, repositoryUrl: 'https://github.com/vie/outreach.git');
    expect(find.text('https://github.com/vie/outreach.git'), findsOneWidget);
    expect(find.text('Share repository'), findsNothing);
  });

  testWidgets('refuses a repository with no commit in plain words, and sends nothing', (tester) async {
    await mount(tester);
    await tester.tap(find.text('Share repository'));
    await tester.pumpAndSettle();
    branches = 0;
    await share(tester, 'vie/outreach');
    expect(checked, ['https://github.com/vie/outreach.git']);
    expect(find.text('vie/outreach has no commits yet. Add one, for example a README, then share it.'), findsOneWidget);
    expect(sent.where((c) => c['type'] == 'project.repository'), isEmpty);
  });

  testWidgets('refuses an address that is not GitHub before running git, and one this computer cannot reach', (tester) async {
    await mount(tester);
    await tester.tap(find.text('Share repository'));
    await tester.pumpAndSettle();
    await share(tester, 'https://gitlab.com/vie/outreach');
    expect(find.text('Enter a GitHub repository, such as https://github.com/owner/repository.'), findsOneWidget);
    expect(checked, isEmpty);
    branches = null;
    await share(tester, 'vie/outreach');
    expect(find.textContaining('can’t reach vie/outreach on GitHub'), findsOneWidget);
    expect(sent.where((c) => c['type'] == 'project.repository'), isEmpty);
  });

  testWidgets('shares a repository with a commit as the address any machine can use, and closes', (tester) async {
    await mount(tester);
    await tester.tap(find.text('Share repository'));
    await tester.pumpAndSettle();
    branches = 2;
    await share(tester, 'git@github.com:vie/outreach.git');
    expect(sent.where((c) => c['type'] == 'project.repository'), [
      {'type': 'project.repository', 'projectId': 'lead', 'repositoryUrl': 'git@github.com:vie/outreach.git'},
    ]);
    expect(find.widgetWithText(FilledButton, 'Share'), findsNothing);
  });
}
