// A Swarm project's GitHub access (docs/plans/2026-10-28-swarm-project-github-access.md): whether teammates' agents can
// push to its repository, shown where the project is, with how to let them.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_github.dart';

import 'support/super_tab_fixture.dart';

void main() {
  late ConversationServer server;
  late List<String> asked;
  late Map<String, dynamic> answer;
  late List<String> launched;
  var refuseApprove = false;

  SuperTabController controllerFor({bool teammates = true}) {
    if (teammates) {
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
    }
    return SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) async {
        if (path.endsWith('/github/approve')) {
          asked.add('$method $path ${body?['scope']}');
          if (refuseApprove) {
            throw const SuperTabFailure(
              'GITHUB_APPROVAL_NOT_CONFIGURED',
              'This Harness server cannot approve repositories yet.',
            );
          }
          return {
            'authorizeUrl': 'https://github.com/login/oauth/authorize?state=s',
            'installUrl':
                'https://github.com/apps/harness/installations/new?state=s',
          };
        }
        if (path.contains('/github')) {
          asked.add(path);
          return answer;
        }
        return server.request(method, path, body: body);
      },
      save: server.save,
      upload: server.upload,
      initial: const {},
      pollInterval: Duration.zero,
    );
  }

  setUp(() {
    // Copy link writes the clipboard: answered here, as the platform would.
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async => null,
        );
    launched = [];
    refuseApprove = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          (call) async {
            if (call.method == 'launch') {
              launched.add((call.arguments as Map)['url'] as String);
            }
            return true;
          },
        );
    server = ConversationServer();
    asked = [];
    answer = {
      'state': 'not-installed',
      'repository': 'acme/app',
      'installUrl': 'https://github.com/apps/harness/installations/new',
    };
  });

  Future<SuperTabController> mount(
    WidgetTester tester,
    Widget Function(SuperTabController c, SuperTabProject p) child, {
    bool teammates = true,
  }) async {
    final c = controllerFor(teammates: teammates);
    await c.refresh();
    final project = c.snapshot!.projects.first;
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: child(c, project))),
    );
    await tester.pumpAndSettle();
    return c;
  }

  testWidgets(
    'the sidebar says when teammates cannot push there, once the Swarm has another person in it',
    (tester) async {
      final c = await mount(
        tester,
        (c, p) => ProjectGitHubLine(controller: c, project: p),
      );
      expect(find.text("Teammates can't push here yet"), findsOneWidget);
      expect(asked, hasLength(1));
      // Read again only after 5 minutes, whatever rebuilds meanwhile.
      await tester.pump();
      expect(asked, hasLength(1));
      c.dispose();
    },
  );

  testWidgets('nothing is asked or shown in a Swarm of one, or when covered', (
    tester,
  ) async {
    final alone = await mount(
      tester,
      (c, p) => ProjectGitHubLine(controller: c, project: p),
      teammates: false,
    );
    expect(asked, isEmpty);
    expect(find.byType(InkWell), findsNothing);
    alone.dispose();
    answer = {'state': 'covered', 'repository': 'acme/app'};
    final covered = await mount(
      tester,
      (c, p) => ProjectGitHubLine(controller: c, project: p),
    );
    expect(find.byType(InkWell), findsNothing);
    covered.dispose();
  });

  testWidgets(
    'Project details explains it, links to GitHub\'s install page, copies the link, and checks again',
    (tester) async {
      final c = await mount(
        tester,
        (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
      );
      expect(find.textContaining("can't push to acme/app yet"), findsOneWidget);
      expect(
        find.byKey(const Key('super-project-github-install')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('super-project-github-copy')));
      await tester.pumpAndSettle();
      expect(find.text('Link copied'), findsOneWidget);
      answer = {'state': 'covered', 'repository': 'acme/app'};
      await tester.tap(find.byKey(const Key('super-project-github-check')));
      await tester.pumpAndSettle();
      expect(asked.last, endsWith('/github?refresh=1'));
      expect(find.textContaining("GitHub ✓"), findsOneWidget);
      expect(
        find.byKey(const Key('super-project-github-install')),
        findsNothing,
      );
      c.dispose();
    },
  );

  testWidgets(
    'says plainly when a project is not on GitHub, has no repository, or GitHub did not answer',
    (tester) async {
      for (final (state, words) in [
        ('not-github', "isn't on GitHub"),
        ('no-repository', 'no repository address yet'),
        ('unknown', "Couldn't reach GitHub"),
      ]) {
        answer = {'state': state, 'repository': 'acme/app'};
        final c = await mount(
          tester,
          (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
        );
        expect(find.textContaining(words), findsOneWidget, reason: state);
        c.dispose();
      }
      answer = {'state': 'unavailable'};
      final none = await mount(
        tester,
        (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
      );
      expect(find.text('GitHub access'), findsNothing);
      none.dispose();
    },
  );

  testWidgets(
    'installs with a link that also approves, and asks someone who can push to approve an installed repository',
    (tester) async {
      final c = await mount(
        tester,
        (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
      );
      await tester.tap(find.byKey(const Key('super-project-github-install')));
      await tester.pumpAndSettle();
      expect(asked.last, endsWith('/github/approve project'));
      expect(launched.last, contains('/installations/new?state='));
      c.dispose();
      answer = {
        'state': 'not-approved',
        'repository': 'acme/app',
        'canApprove': true,
      };
      final approving = await mount(
        tester,
        (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
      );
      expect(
        find.textContaining("can't use acme/app in this project yet"),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const Key('super-project-github-approve-swarm')),
      );
      await tester.pumpAndSettle();
      expect(asked.last, endsWith('/github/approve swarm'));
      expect(launched.last, contains('/login/oauth/authorize'));
      refuseApprove = true;
      await tester.tap(find.byKey(const Key('super-project-github-approve')));
      await tester.pumpAndSettle();
      expect(
        find.text('This Harness server cannot approve repositories yet.'),
        findsOneWidget,
      );
      approving.dispose();
    },
  );

  testWidgets('says so when the server cannot approve, without the buttons', (
    tester,
  ) async {
    answer = {
      'state': 'not-approved',
      'repository': 'acme/app',
      'canApprove': false,
    };
    final c = await mount(
      tester,
      (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
    );
    expect(
      find.textContaining("can't approve repositories yet"),
      findsOneWidget,
    );
    expect(find.byKey(const Key('super-project-github-approve')), findsNothing);
    c.dispose();
  });
}
