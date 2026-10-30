// A Swarm project's GitHub access (docs/plans/2026-10-28-swarm-project-github-access.md): whether teammates' agents can
// push to its repository, shown where the project is, with how to let them.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_github.dart';
import 'package:harness/super_tabs/project_options.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/detail_dialog.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/super_tab_fixture.dart';

void main() {
  // Local Team account run, 2026-10-28 (group #646, item 8): the server names the reader's other projects the
  // repository is approved for; nothing else is read from it.
  test('reads the other projects a repository is approved for', () {
    final access = SuperTabProjectGitHub.fromJson({
      'state': 'not-approved',
      'repository': 'tuan-dev/notes-app',
      'canApprove': true,
      'approvedFor': ['Notes', 3, 'Docs'],
    });
    expect(access.approvedFor, ['Notes', 'Docs']);
    expect(
      SuperTabProjectGitHub.fromJson({'state': 'covered'}).approvedFor,
      isEmpty,
    );
  });

  late ConversationServer server;
  late List<String> asked;
  late Map<String, dynamic> answer;
  late List<String> launched;
  var refuseApprove = false;
  // A status read held until completed, or failing.
  Completer<void>? hold;
  Object? failure;

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
          await hold?.future;
          if (failure != null) throw failure!;
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
    hold = null;
    failure = null;
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
      expect(find.text('Set up GitHub for teammates'), findsOneWidget);
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
    'Project details explains it, links to GitHub\'s install page, copies the link, and reads again on return',
    (tester) async {
      final c = await mount(
        tester,
        (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
      );
      expect(find.textContaining("can't push to acme/app yet"), findsOneWidget);
      // Nothing to press to check again: coming back to the app reads it again (design 2026-10-30).
      expect(find.byKey(const Key('super-project-github-check')), findsNothing);
      expect(
        find.byKey(const Key('super-project-github-install')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('super-project-github-copy')));
      await tester.pumpAndSettle();
      expect(find.text('Link copied'), findsOneWidget);
      answer = {'state': 'covered', 'repository': 'acme/app'};
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(asked.last, endsWith('/github?refresh=1'));
      // A check mark, the app's own, not a ✓ typed into the sentence (Ken, 2026-10-28).
      expect(
        find.text(
          "Teammates' agents can push and open pull requests on acme/app.",
        ),
        findsOneWidget,
      );
      expect(find.textContaining('✓'), findsNothing);
      expect(find.byIcon(AppIcons.check), findsOneWidget);
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
        find.textContaining("can't push to acme/app from this project yet"),
        findsOneWidget,
      );
      // Approved one project at a time: nothing widens it to every project in one click (Scholes, 2026-10-28).
      expect(
        find.byKey(const Key('super-project-github-approve-swarm')),
        findsNothing,
      );
      await tester.tap(find.byKey(const Key('super-project-github-approve')));
      await tester.pumpAndSettle();
      expect(asked.last, endsWith('/github/approve project'));
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

  // Local Team account run, 2026-10-28 (group #646, item 8): a second project on an approved repository asked again with
  // no hint. It names the reader's other projects it is approved for, as the server says.
  testWidgets(
    'names the other projects the repository is approved for, and asks to approve it here too',
    (tester) async {
      Future<void> reads(List<String> approvedFor, String line) async {
        answer = {
          'state': 'not-approved',
          'repository': 'acme/app',
          'canApprove': true,
          'approvedFor': approvedFor,
        };
        final c = await mount(
          tester,
          (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
        );
        expect(
          find.text(
            "Teammates' agents can't push to acme/app from this project yet. $line",
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('super-project-github-approve')),
          findsOneWidget,
        );
        c.dispose();
      }

      await reads(['Notes'], "It's allowed for Notes. Allow it here too?");
      await reads([
        'Notes',
        'Docs',
      ], "It's allowed for Notes and Docs. Allow it here too?");
      await reads([
        'Notes',
        'Docs',
        'Site',
      ], "It's allowed for Notes, Docs and Site. Allow it here too?");
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
    expect(find.textContaining("can't allow repositories yet"), findsOneWidget);
    expect(find.byKey(const Key('super-project-github-approve')), findsNothing);
    c.dispose();
  });

  // 2026-10-28, a new Swarm: Project details showed no GitHub access at all while it was read, and after an approval
  // the sidebar kept saying teammates could not push for 5 minutes.
  testWidgets(
    'says it is checking while it reads, and that it could not when it fails, asking again soon',
    (tester) async {
      hold = Completer<void>();
      final c = controllerFor();
      await c.refresh();
      final project = c.snapshot!.projects.first;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProjectGitHubAccess(controller: c, projectId: project.id),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Checking…'), findsOneWidget);
      failure = const SuperTabFailure('NETWORK', 'offline');
      hold!.complete();
      await tester.pumpAndSettle();
      expect(
        find.text("Couldn't check GitHub access just now."),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('super-project-github-check')),
        findsOneWidget,
      );
      // Asked again after 30 seconds, not 5 minutes.
      final before = asked.length;
      await c.readGitHubAccess(project.id);
      expect(asked, hasLength(before));
      failure = null;
      await tester.tap(find.byKey(const Key('super-project-github-check')));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('installs Harness on GitHub there'),
        findsOneWidget,
      );
      c.dispose();
    },
  );

  // Design 2026-10-30 ("Swarm GitHub access flow"): the dialog the sidebar line opens says what is being allowed, waits
  // for GitHub in its own screen, and ends with a plain confirmation.
  testWidgets(
    'the dialog asks to allow it, waits for GitHub, and confirms when it is done',
    (tester) async {
      answer = {
        'state': 'not-approved',
        'repository': 'acme/app',
        'canApprove': true,
      };
      final c = controllerFor();
      await c.refresh();
      final project = c.snapshot!.projects.first;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showProjectGitHubAccess(context, c, project),
                child: const Text('open github'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open github'));
      await tester.pumpAndSettle();
      expect(
        find.text("Let teammates' agents push to ${project.name}"),
        findsOneWidget,
      );
      expect(find.text('acme/app'), findsOneWidget);
      expect(find.text('Push branches and open pull requests'), findsOneWidget);
      // Before GitHub has said anything about the reader, no claim either way.
      expect(
        find.textContaining('Anyone who can push to acme/app'),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('super-project-github-can-push')),
        findsNothing,
      );
      await tester.ensureVisible(
        find.byKey(const Key('super-project-github-approve')),
      );
      await tester.tap(find.byKey(const Key('super-project-github-approve')));
      // The waiting screen's spinner never settles.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(launched.last, contains('/login/oauth/authorize'));
      expect(find.text('Finish in GitHub'), findsOneWidget);
      expect(find.text("What GitHub's page means"), findsOneWidget);
      // Back in the app before finishing on GitHub: still waiting, not back at the question.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Finish in GitHub'), findsOneWidget);
      // Cancel goes back to the question; Continue opens GitHub again.
      await tester.ensureVisible(
        find.byKey(const Key('super-project-github-cancel')),
      );
      await tester.tap(find.byKey(const Key('super-project-github-cancel')));
      await tester.pumpAndSettle();
      expect(find.text('Finish in GitHub'), findsNothing);
      await tester.ensureVisible(
        find.byKey(const Key('super-project-github-approve')),
      );
      await tester.tap(find.byKey(const Key('super-project-github-approve')));
      // The waiting screen's spinner never settles.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // Back from GitHub, approved.
      answer = {'state': 'covered', 'repository': 'acme/app'};
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(
        find.text("Teammates' agents can push to ${project.name}"),
        findsOneWidget,
      );
      await tester.ensureVisible(
        find.byKey(const Key('super-project-github-done')),
      );
      await tester.tap(find.byKey(const Key('super-project-github-done')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('super-project-github-dialog')),
        findsNothing,
      );
      c.dispose();
    },
  );

  // Design 2026-10-30, 2a and 2b: "You can push" only once GitHub has said so, and someone GitHub refused is asked to send
  // it on rather than offered the same sign-in again.
  testWidgets(
    'the dialog says you can push once GitHub has, and asks someone it refused to send it on',
    (tester) async {
      Future<SuperTabController> open(Map<String, dynamic> you) async {
        answer = {
          'state': 'not-approved',
          'repository': 'acme/app',
          'canApprove': true,
          'you': you,
        };
        final c = controllerFor();
        await c.refresh();
        final project = c.snapshot!.projects.first;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (context) => TextButton(
                  onPressed: () => showProjectGitHubAccess(context, c, project),
                  child: const Text('open github'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open github'));
        await tester.pumpAndSettle();
        return c;
      }

      final able = await open({'canPush': true, 'githubLogin': 'olive'});
      expect(
        find.byKey(const Key('super-project-github-can-push')),
        findsOneWidget,
      );
      expect(
        find.textContaining('You have write access, so you can allow it.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Not now'));
      await tester.pumpAndSettle();
      able.dispose();
      final refused = await open({'canPush': false, 'githubLogin': 'olive'});
      expect(
        find.text('Someone with write access needs to allow this'),
        findsOneWidget,
      );
      expect(
        find.textContaining('(olive) can\'t push to acme/app'),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('super-project-github-approve')),
        findsNothing,
      );
      await tester.ensureVisible(
        find.byKey(const Key('super-project-github-ask')),
      );
      await tester.tap(find.byKey(const Key('super-project-github-ask')));
      await tester.pumpAndSettle();
      expect(find.text('Message copied'), findsOneWidget);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      refused.dispose();
      // Refused while waiting: back in the app, the wait ends on the ask, not on the question again.
      final waiting = await open({});
      await tester.ensureVisible(
        find.byKey(const Key('super-project-github-approve')),
      );
      await tester.tap(find.byKey(const Key('super-project-github-approve')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Finish in GitHub'), findsOneWidget);
      answer = {
        'state': 'not-approved',
        'repository': 'acme/app',
        'canApprove': true,
        'you': {'canPush': false, 'githubLogin': 'olive'},
      };
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(
        find.text('Someone with write access needs to allow this'),
        findsOneWidget,
      );
      waiting.dispose();
    },
  );

  testWidgets('shows nothing on a server without the route', (tester) async {
    failure = const SuperTabFailure('NOT_FOUND', 'Not found', statusCode: 404);
    final c = await mount(
      tester,
      (c, p) => ProjectGitHubAccess(controller: c, projectId: p.id),
    );
    expect(find.text('GitHub access'), findsNothing);
    expect(find.text('Checking…'), findsNothing);
    c.dispose();
  });

  testWidgets(
    'says to finish in the browser, and the sidebar asks again when the person is back',
    (tester) async {
      answer = {
        'state': 'not-approved',
        'repository': 'acme/app',
        'canApprove': true,
      };
      final c = await mount(
        tester,
        (c, p) => Column(
          children: [
            ProjectGitHubLine(controller: c, project: p),
            ProjectGitHubAccess(controller: c, projectId: p.id),
          ],
        ),
      );
      expect(
        find.byKey(const Key('super-project-github-waiting')),
        findsNothing,
      );
      await tester.tap(find.byKey(const Key('super-project-github-approve')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('super-project-github-waiting')),
        findsOneWidget,
      );
      // Approved in the browser; back in the app, both ask again at once.
      answer = {'state': 'covered', 'repository': 'acme/app'};
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(asked.last, endsWith('/github?refresh=1'));
      expect(find.text('Set up GitHub for teammates'), findsNothing);
      expect(find.textContaining("Teammates' agents can push"), findsOneWidget);
      expect(
        find.byKey(const Key('super-project-github-waiting')),
        findsNothing,
      );
      c.dispose();
    },
  );

  testWidgets(
    'Project details is titled by the project, with its repository, Product Manager and GitHub access in one column',
    (tester) async {
      answer = {'state': 'covered', 'repository': 'acme/app'};
      final c = await mount(
        tester,
        (c, p) => Builder(
          builder: (context) => TextButton(
            onPressed: () => showProjectAction(context, c, p, 'details'),
            child: const Text('open'),
          ),
        ),
      );
      final project = c.snapshot!.projects.first;
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      final dialog = find.byType(SuperTabDetailDialog);
      expect(dialog, findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(DesktopDialogHeader),
          matching: find.text(project.name),
        ),
        findsOneWidget,
      );
      // An empty description is quiet, not an instruction.
      expect(find.text('No description yet'), findsOneWidget);
      expect(find.textContaining('Discuss the project'), findsNothing);
      final values = [
        for (final label in ['Repository', 'Product Manager', 'GitHub access'])
          tester.getTopLeft(find.text(label)).dx,
      ];
      expect(values.toSet(), hasLength(1), reason: 'labels share one column');
      expect(find.byIcon(AppIcons.check), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Close'), findsNothing);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      expect(dialog, findsNothing);
      c.dispose();
    },
  );

  testWidgets('Project details shows a written description as it is', (
    tester,
  ) async {
    answer = {'state': 'covered', 'repository': 'acme/app'};
    final c = await mount(
      tester,
      (c, p) => Builder(
        builder: (context) => TextButton(
          onPressed: () => showProjectAction(context, c, p, 'details'),
          child: const Text('open'),
        ),
      ),
    );
    final project = c.snapshot!.projects.first;
    final lead = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == project.leadConversationId);
    lead['brief'] = 'hi';
    await c.refresh();
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('hi'), findsOneWidget);
    expect(find.text('No description yet'), findsNothing);
    c.dispose();
  });
}
