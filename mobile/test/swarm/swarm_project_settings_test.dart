import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_settings.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';

import '../support/real_fonts.dart';
import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Project settings…, Sharing and the lock of a private project on the
/// phone, as the desktop's project menu has them (task 37): Rename project
/// and Sharing for the project's owner who may write, Project details for
/// everyone who reads it, and never Delete Project.
void main() {
  late FakeSwarm swarm;
  late SwarmHost host;
  late ValueNotifier<String?> account;
  late String name, owner, visibility, role, brief;
  late List<({String id, String generation})> members;
  late String? leadId, coordinatorName;
  late Map<String, dynamic>? repository;
  var version = 1;

  /// What the next command answers instead of the server, once.
  FutureOr<Object?> Function()? answer;

  Map<String, dynamic> projectData() => {
    'id': project,
    'name': name,
    'ownerId': owner,
    'leadConversationId': leadChat,
    'visibility': visibility,
    'members': [
      for (final m in members) {'id': m.id, 'generation': m.generation},
    ],
    'updateMinutes': 5,
    'coordinatorName': ?coordinatorName,
    'repository': ?repository,
  };

  Map<String, dynamic> leadChatData() => {
    ...groupData(
      leadChat,
      title: 'Mobile',
      agentIds: ['agent-lead'],
      leadId: leadId,
    ),
    'brief': brief,
  };

  List<Map<String, dynamic>> people(int at) => [
    part(me, at, person(me, role: role)),
    part('diego', at, person('diego', role: 'collaborator')),
    // Shown by the name they set for the Swarm.
    part('ken', at, {
      ...person('ken', role: 'collaborator'),
      'name': 'Ken Tran',
    }),
  ];

  /// Moves the Swarm on: the next change read carries the project and its
  /// people as they are now.
  Map<String, dynamic> changed() {
    version++;
    return {
      ...changes(cursor: 'c$version', lastChangedAt: 100 + version),
      'head': part('head', version, headData(projects: [projectData()])),
      'members': people(version),
      'groups': [part(leadChat, version, leadChatData())],
    };
  }

  Future<void> pump(
    WidgetTester tester, {
    String ownerId = me,
    String myRole = 'owner',
    String projectVisibility = 'public',
    List<({String id, String generation})> projectMembers = const [],
    String description = '',
    String? lead = 'agent-lead',
    String? coordinator,
    Map<String, dynamic>? repo,
  }) async {
    name = 'Mobile';
    owner = ownerId;
    role = myRole;
    visibility = projectVisibility;
    members = [...projectMembers];
    brief = description;
    leadId = lead;
    coordinatorName = coordinator;
    repository = repo;
    version = 1;
    answer = null;
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(head: headData(projects: [projectData()])),
      'groups': [part(leadChat, 1, leadChatData())],
      'members': people(1),
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changed();
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] = (
      _,
    ) => {'messages': <Object>[], 'next': null};
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      if (answer case final once?) {
        answer = null;
        return once();
      }
      switch (command['type']) {
        case 'project.rename':
          name = command['name'] as String;
        case 'project.sharing':
          visibility = command['visibility'] as String;
          members = [
            for (final id in command['memberIds'] as List)
              (id: id as String, generation: 'gen-$id'),
          ];
      }
      return {'ok': true};
    };
    account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmProjectPage(
          swarmId: tab,
          projectId: project,
          tabs: SwarmProjectTab.homeC,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  SwarmReader reader() => host.session!.inbox.reader(tab)!;
  Finder key(String value) => find.byKey(ValueKey(value));
  final sharingRow = key('swarm-project-menu-sharing');
  final settingsRow = key('swarm-project-menu-settings');

  List<Map<String, dynamic>> sent(String type) => [
    for (final c in swarm.commands)
      if (c['type'] == type) c,
  ];

  /// Lets a write and the read after it land.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
  }

  /// The Swarm read again, with what the test changed.
  Future<void> moveOn(WidgetTester tester) async {
    await reader().refresh();
    await tester.pumpAndSettle();
  }

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(key('swarm-project-menu'));
    await tester.pumpAndSettle();
  }

  Future<void> openSettings(WidgetTester tester) async {
    await openMenu(tester);
    await tester.tap(settingsRow);
    await tester.pumpAndSettle();
  }

  Future<void> openRename(WidgetTester tester) async {
    await openSettings(tester);
    await tester.tap(find.text('Rename project'));
    await tester.pumpAndSettle();
    expect(key('swarm-project-name'), findsOneWidget);
  }

  Future<void> openDetails(WidgetTester tester) async {
    await openSettings(tester);
    await tester.tap(find.text('Project details'));
    await tester.pumpAndSettle();
  }

  Future<void> openSharing(WidgetTester tester) async {
    await openMenu(tester);
    await tester.tap(sharingRow);
    await tester.pumpAndSettle();
    expect(key('swarm-sharing-close'), findsOneWidget);
  }

  bool? ticked(WidgetTester tester, String id) =>
      tester.widget<Checkbox>(key('swarm-sharing-person-$id-check')).value;

  bool tickable(WidgetTester tester, String id) =>
      tester
          .widget<Checkbox>(key('swarm-sharing-person-$id-check'))
          .onChanged !=
      null;

  /// The phones the menu must fit: a common one and the narrowest, 320
  /// points (iPhone SE, 1st generation), each with its status bar.
  const phones = [
    ('a phone', Size(390, 844), 47.0),
    ('a 320-point phone', Size(320, 568), 20.0),
  ];

  /// Opens the menu of its owner who may write on a phone of [size], with
  /// [top] for its status bar: all eight rows, the most it ever has, each a
  /// finger tall, inside the panel and the panel on the screen, with nothing
  /// to scroll; with [across], each label whole inside the panel too.
  Future<void> menuFits(
    WidgetTester tester,
    Size size,
    double top, {
    required bool across,
  }) async {
    addTearDown(tester.view.reset);
    tester.view
      ..physicalSize = size * 3
      ..devicePixelRatio = 3
      ..padding = FakeViewPadding(top: top * 3);
    await pump(tester);
    await openMenu(tester);
    expect(tester.takeException(), isNull);

    final rows = [
      for (final row in [
        'terminal',
        'status',
        'leaderboard',
        'work',
        'team',
        'sharing',
        'notifications',
        'settings',
      ])
        key('swarm-project-menu-$row'),
    ];
    for (final row in rows) {
      expect(row, findsOneWidget);
    }
    // The menu's panel: the nearest Material over a row.
    final panelFinder = find
        .ancestor(of: settingsRow, matching: find.byType(Material))
        .first;
    final panel = tester.getRect(panelFinder);
    expect(panel.top, greaterThanOrEqualTo(top));
    expect(panel.bottom, lessThanOrEqualTo(size.height));
    if (across) {
      expect(panel.left, greaterThanOrEqualTo(0));
      expect(panel.right, lessThanOrEqualTo(size.width));
    }
    for (final row in rows) {
      final rect = tester.getRect(row);
      expect(rect.top, greaterThanOrEqualTo(panel.top));
      expect(rect.bottom, lessThanOrEqualTo(panel.bottom));
      expect(rect.height, greaterThanOrEqualTo(minTouchTarget));
      if (!across) continue;
      // Each label whole, never cut at the panel's edge.
      for (final text
          in find.descendant(of: row, matching: find.byType(Text)).evaluate()) {
        final box = text.renderObject! as RenderBox;
        final rect = box.localToGlobal(Offset.zero) & box.size;
        expect(rect.left, greaterThanOrEqualTo(panel.left));
        expect(rect.right, lessThanOrEqualTo(panel.right));
      }
    }
    final list = tester.state<ScrollableState>(
      find.descendant(of: panelFinder, matching: find.byType(Scrollable)).first,
    );
    expect(list.position.maxScrollExtent, 0, reason: 'nothing to scroll');
  }

  group('the menu', () {
    testWidgets('its owner who may write gets Sharing above Notifications '
        'and Project settings… last; never Delete Project', (tester) async {
      await pump(tester);
      await openMenu(tester);

      expect(
        find.descendant(of: sharingRow, matching: find.text('Sharing')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: settingsRow,
          matching: find.text('Project settings…'),
        ),
        findsOneWidget,
      );
      final notifications = key('swarm-project-menu-notifications');
      final team = tester.getTopLeft(key('swarm-project-menu-team')).dy;
      final sharing = tester.getTopLeft(sharingRow).dy;
      expect(team, lessThan(sharing));
      expect(sharing, lessThan(tester.getTopLeft(notifications).dy));
      expect(
        tester.getTopLeft(notifications).dy,
        lessThan(tester.getTopLeft(settingsRow).dy),
      );
      expect(find.textContaining('Delete'), findsNothing);
    });

    // Tall enough for all eight, whatever the face: across is measured in
    // the phone's faces, in the last group.
    for (final (phone, size, top) in phones) {
      testWidgets('on $phone all eight rows fit the menu and the screen, '
          'Project settings… included, with no scrolling', (tester) async {
        await menuFits(tester, size, top, across: false);
      });
    }

    testWidgets('a collaborator who is not its owner gets Project settings… '
        'but no Sharing', (tester) async {
      await pump(tester, ownerId: 'diego', myRole: 'collaborator');
      await openMenu(tester);
      expect(sharingRow, findsNothing);
      expect(settingsRow, findsOneWidget);
    });

    testWidgets('its owner as a viewer now gets no Sharing', (tester) async {
      await pump(tester, myRole: 'viewer');
      await openMenu(tester);
      expect(sharingRow, findsNothing);
      expect(settingsRow, findsOneWidget);
    });

    testWidgets('Sharing goes from the menu once the project is another\'s', (
      tester,
    ) async {
      await pump(tester);
      await openMenu(tester);
      expect(sharingRow, findsOneWidget);
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();

      owner = 'diego';
      await moveOn(tester);
      await openMenu(tester);
      expect(sharingRow, findsNothing);
    });
  });

  group('Project settings…', () {
    testWidgets('its owner gets Rename project and Project details', (
      tester,
    ) async {
      await pump(tester);
      await openSettings(tester);
      expect(find.text('Project settings'), findsOneWidget);
      expect(find.text('Rename project'), findsOneWidget);
      expect(find.text('Project details'), findsOneWidget);
      expect(find.textContaining('Delete'), findsNothing);
    });

    testWidgets('someone else gets Project details alone', (tester) async {
      await pump(tester, ownerId: 'diego', myRole: 'collaborator');
      await openSettings(tester);
      expect(find.text('Rename project'), findsNothing);
      expect(find.text('Project details'), findsOneWidget);
    });

    testWidgets('a viewer gets Project details alone', (tester) async {
      await pump(tester, myRole: 'viewer');
      await openSettings(tester);
      expect(find.text('Rename project'), findsNothing);
      expect(find.text('Project details'), findsOneWidget);
    });

    testWidgets('the project taken off the Swarm with it open: it closes', (
      tester,
    ) async {
      await pump(tester);
      await openSettings(tester);
      expect(find.text('Project settings'), findsOneWidget);

      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c9', lastChangedAt: 300),
        'head': part('head', 9, headData(projects: const [])),
      };
      await moveOn(tester);
      expect(find.text('Project settings'), findsNothing);
      expect(find.text('Rename project'), findsNothing);
    });

    testWidgets('access lost with it open: it closes', (tester) async {
      await pump(tester);
      await openSettings(tester);
      reader().revoke();
      await tester.pumpAndSettle();
      expect(find.text('Project settings'), findsNothing);
      expect(find.text('Rename project'), findsNothing);
    });

    testWidgets('the account signing out with it open: it closes', (
      tester,
    ) async {
      await pump(tester);
      await openSettings(tester);
      account.value = null;
      await tester.pumpAndSettle();
      expect(find.text('Project settings'), findsNothing);
      expect(find.text('Rename project'), findsNothing);
    });

    testWidgets('Project details opens from it once it has closed', (
      tester,
    ) async {
      await pump(tester);
      await openDetails(tester);
      expect(find.text('Project settings'), findsNothing);
      expect(key('swarm-project-info-close'), findsOneWidget);
      await tester.tap(key('swarm-project-info-close'));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);

      // And again: nothing of the first stays in the way.
      await openDetails(tester);
      expect(key('swarm-project-info-close'), findsOneWidget);
    });
  });

  group('Rename project', () {
    testWidgets('a new name, trimmed, is the server\'s at once, in the '
        'header', (tester) async {
      await pump(tester);
      await openRename(tester);
      expect(find.text('Rename project'), findsOneWidget);
      expect(
        tester.widget<TextField>(key('swarm-project-name')).controller!.text,
        'Mobile',
      );
      await tester.enterText(key('swarm-project-name'), '  Phone app ');
      await tester.pump();
      await tester.tap(key('swarm-project-name-save'));
      await settle(tester);

      expect(sent('project.rename'), [
        {'type': 'project.rename', 'projectId': project, 'name': 'Phone app'},
      ]);
      expect(key('swarm-project-name'), findsNothing);
      expect(reader().snapshot!.projectById(project)!.name, 'Phone app');
      expect(find.text('#Phone app'), findsOneWidget);
    });

    testWidgets('an empty name cannot be saved', (tester) async {
      await pump(tester);
      await openRename(tester);
      await tester.enterText(key('swarm-project-name'), '   ');
      await tester.pump();
      await tester.tap(key('swarm-project-name-save'));
      await settle(tester);
      expect(sent('project.rename'), isEmpty);
      expect(key('swarm-project-name'), findsOneWidget);
    });

    testWidgets('a name at the 160-character limit saves; one longer is cut '
        'to fit', (tester) async {
      await pump(tester);
      await openRename(tester);
      final longest = 'a' * 160;
      await tester.enterText(key('swarm-project-name'), '${longest}b');
      await tester.pump();
      await tester.tap(key('swarm-project-name-save'));
      await settle(tester);
      expect(sent('project.rename').single['name'], longest);
    });

    testWidgets('a refused name says why under the field and stays open', (
      tester,
    ) async {
      await pump(tester);
      await openRename(tester);
      answer = () => throw const SuperTabFailure(
        'PROJECT_OWNER_REQUIRED',
        'Only the project owner can manage this project.',
        statusCode: 403,
      );
      await tester.enterText(key('swarm-project-name'), 'Another');
      await tester.pump();
      await tester.tap(key('swarm-project-name-save'));
      await settle(tester);

      expect(
        tester.widget<Text>(key('swarm-project-name-error')).data,
        'Only the project owner can manage this project.',
      );
      expect(key('swarm-project-name'), findsOneWidget);
      expect(reader().snapshot!.projectById(project)!.name, 'Mobile');
    });

    testWidgets('offline: a call lost on the way says so, never stays '
        'Saving', (tester) async {
      await pump(tester);
      await openRename(tester);
      answer = () => throw TimeoutException('no answer');
      await tester.enterText(key('swarm-project-name'), 'Another');
      await tester.pump();
      await tester.tap(key('swarm-project-name-save'));
      await settle(tester);
      expect(find.text('Could not reach this Swarm. Try again.'), findsOne);
      expect(find.text('Saving…'), findsNothing);
      expect(key('swarm-project-name'), findsOneWidget);
    });

    testWidgets('the project made someone else\'s while it is open: it '
        'goes, and nothing is sent', (tester) async {
      await pump(tester);
      await openRename(tester);
      owner = 'diego';
      await moveOn(tester);
      expect(key('swarm-project-name'), findsNothing);
      expect(sent('project.rename'), isEmpty);
    });

    testWidgets('access lost while it is open: it goes, and nothing of the '
        'project stays', (tester) async {
      await pump(tester);
      await openRename(tester);
      reader().revoke();
      await tester.pumpAndSettle();
      expect(key('swarm-project-name'), findsNothing);
      expect(find.textContaining('Mobile'), findsNothing);
    });

    testWidgets('the account signing out while it is open: it goes, and '
        'nothing of the project stays', (tester) async {
      await pump(tester);
      await openRename(tester);
      account.value = null;
      await tester.pumpAndSettle();
      expect(key('swarm-project-name'), findsNothing);
      expect(find.textContaining('Mobile'), findsNothing);
      expect(sent('project.rename'), isEmpty);
    });

    for (final (phone, size, keyboard) in [
      ('a phone', const Size(390, 844), 336.0),
      ('a short phone', const Size(320, 568), 260.0),
    ]) {
      testWidgets('on $phone the keyboard up keeps the field and Save in '
          'sight above it', (tester) async {
        addTearDown(tester.view.reset);
        tester.view
          ..physicalSize = size * 3
          ..devicePixelRatio = 3;
        await pump(tester);
        await openRename(tester);
        final before = tester.getRect(key('swarm-project-name-save'));

        tester.view.viewInsets = FakeViewPadding(bottom: keyboard * 3);
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        final top = size.height - keyboard;
        final field = tester.getRect(key('swarm-project-name'));
        final save = tester.getRect(key('swarm-project-name-save'));
        expect(field.top, greaterThanOrEqualTo(0));
        expect(field.bottom, lessThanOrEqualTo(top));
        expect(save.bottom, lessThanOrEqualTo(top));
        expect(save.bottom, lessThan(before.bottom), reason: 'it moved up');
        await tester.tap(key('swarm-project-name-save'));
        await settle(tester);
        expect(sent('project.rename').single['name'], 'Mobile');
      });
    }
  });

  group('Project details', () {
    testWidgets('its name over its description, its repository and its '
        'Product Manager', (tester) async {
      await pump(
        tester,
        description: 'The phone app for Harness.',
        repo: {
          'repositoryUrl': 'https://github.com/acme/mobile',
          'cwd': '/Users/me/mobile',
        },
      );
      await openDetails(tester);

      expect(key('swarm-project-info-close'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('Mobile'),
        ),
        findsOneWidget,
      );
      expect(find.text('The phone app for Harness.'), findsOneWidget);
      final repository = key('swarm-project-info-repository');
      expect(
        find.descendant(of: repository, matching: find.text('Repository')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: repository,
          matching: find.text('https://github.com/acme/mobile'),
        ),
        findsOneWidget,
      );
      final pm = key('swarm-project-info-coordinator');
      expect(
        find.descendant(of: pm, matching: find.text('Product Manager')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: pm, matching: find.text('River')),
        findsOneWidget,
      );
    });

    testWidgets('nothing set yet: No description yet, Not set, and the PM '
        'Starting…', (tester) async {
      await pump(tester, lead: null);
      await openDetails(tester);
      expect(find.text('No description yet'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-project-info-repository'),
          matching: find.text('Not set'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-project-info-coordinator'),
          matching: find.text('Starting…'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a repository with no link names its folder; the '
        'coordinator goes by the project\'s own name for it', (tester) async {
      await pump(
        tester,
        coordinator: 'Tech Lead',
        repo: {'repositoryUrl': 7, 'cwd': '/Users/me/mobile'},
      );
      await openDetails(tester);
      expect(find.text('/Users/me/mobile'), findsOneWidget);
      expect(find.text('Tech Lead'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a viewer reads them too, and a rename elsewhere shows at '
        'once', (tester) async {
      await pump(tester, myRole: 'viewer');
      await openDetails(tester);
      expect(key('swarm-project-info-close'), findsOneWidget);
      name = 'Phone app';
      await moveOn(tester);
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('Phone app'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('the project taken off the Swarm with them open: they '
        'close', (tester) async {
      await pump(tester);
      await openDetails(tester);
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c9', lastChangedAt: 300),
        'head': part('head', 9, headData(projects: const [])),
      };
      await moveOn(tester);
      expect(key('swarm-project-info-close'), findsNothing);
      expect(find.byType(BottomSheet), findsNothing);
    });
  });

  group('Sharing', () {
    testWidgets('a public project: Public ticked and no one to pick; '
        'Private lists the Swarm, its owner always in, and Save makes it '
        'private to who is ticked', (tester) async {
      await pump(tester);
      await openSharing(tester);

      expect(find.text('Sharing'), findsOneWidget);
      expect(find.text('Everyone in this Swarm'), findsOneWidget);
      expect(
        find.text('Only people you invite to this project'),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-sharing-public'),
          matching: find.byIcon(LucideIcons.check300),
        ),
        findsOneWidget,
      );
      expect(
        tester.widget<Text>(key('swarm-sharing-line')).data,
        'Everyone in this Swarm can open this project.',
      );
      expect(key('swarm-sharing-person-diego'), findsNothing);

      await tester.tap(key('swarm-sharing-private'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-sharing-line')).data,
        'Only the people below can open this project.',
      );
      expect(
        find.descendant(
          of: key('swarm-sharing-person-$me'),
          matching: find.text('$me@example.com · Project owner'),
        ),
        findsOneWidget,
      );
      expect(ticked(tester, me), isTrue);
      expect(tickable(tester, me), isFalse, reason: 'its owner stays in');
      expect(ticked(tester, 'diego'), isFalse);
      expect(ticked(tester, 'ken'), isFalse);
      // Each by the name the Swarm shows them by, over their email: their
      // username until they set a name.
      for (final (id, shown) in [('diego', 'diego'), ('ken', 'Ken Tran')]) {
        final row = key('swarm-sharing-person-$id');
        expect(
          find.descendant(of: row, matching: find.text(shown)),
          findsOneWidget,
          reason: id,
        );
        expect(
          find.descendant(of: row, matching: find.text('$id@example.com')),
          findsOneWidget,
          reason: id,
        );
        expect(
          tester.getTopLeft(find.text(shown)).dy,
          lessThan(tester.getTopLeft(find.text('$id@example.com')).dy),
          reason: '$id: the name over the email',
        );
      }

      await tester.tap(key('swarm-sharing-person-diego'));
      await tester.pumpAndSettle();
      expect(ticked(tester, 'diego'), isTrue);
      await tester.tap(key('swarm-sharing-save'));
      await settle(tester);

      expect(sent('project.sharing'), [
        {
          'type': 'project.sharing',
          'projectId': project,
          'visibility': 'private',
          'memberIds': ['diego'],
        },
      ]);
      expect(key('swarm-sharing-close'), findsNothing);
      final shared = reader().snapshot!.projectById(project)!;
      expect(shared.isPrivate, isTrue);
      expect(shared.memberIds, ['diego']);
    });

    testWidgets('a private project opens as it is: who is a member ticked, '
        'never someone who left the Swarm nor one who came back', (
      tester,
    ) async {
      await pump(
        tester,
        projectVisibility: 'private',
        projectMembers: [
          (id: 'diego', generation: 'gen-diego'),
          // Left the Swarm and joined again: not a member until ticked.
          (id: 'ken', generation: 'gen-old'),
          // No longer in the Swarm.
          (id: 'gone', generation: 'gen-gone'),
        ],
      );
      await openSharing(tester);

      expect(
        find.descendant(
          of: key('swarm-sharing-private'),
          matching: find.byIcon(LucideIcons.check300),
        ),
        findsOneWidget,
      );
      expect(ticked(tester, 'diego'), isTrue);
      expect(ticked(tester, 'ken'), isFalse);
      expect(key('swarm-sharing-person-gone'), findsNothing);

      // The checkbox itself ticks too; the list scrolls to the last one.
      await tester.tap(key('swarm-sharing-person-diego-check'));
      await tester.ensureVisible(key('swarm-sharing-person-ken-check'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-sharing-person-ken-check'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-sharing-save'));
      await settle(tester);

      expect(sent('project.sharing').single['memberIds'], ['ken']);
    });

    testWidgets('back to Public keeps its members for later', (tester) async {
      await pump(
        tester,
        projectVisibility: 'private',
        projectMembers: [(id: 'diego', generation: 'gen-diego')],
      );
      await openSharing(tester);
      await tester.tap(key('swarm-sharing-public'));
      await tester.pumpAndSettle();
      expect(key('swarm-sharing-person-diego'), findsNothing);
      await tester.tap(key('swarm-sharing-save'));
      await settle(tester);

      expect(sent('project.sharing'), [
        {
          'type': 'project.sharing',
          'projectId': project,
          'visibility': 'public',
          'memberIds': ['diego'],
        },
      ]);
      expect(reader().snapshot!.projectById(project)!.isPrivate, isFalse);
    });

    testWidgets('✕ changes nothing', (tester) async {
      await pump(tester);
      await openSharing(tester);
      await tester.tap(key('swarm-sharing-private'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-sharing-close'));
      await settle(tester);
      expect(key('swarm-sharing-close'), findsNothing);
      expect(sent('project.sharing'), isEmpty);
      expect(reader().snapshot!.projectById(project)!.isPrivate, isFalse);
    });

    testWidgets('a refusal says why over Save and stays open to try again', (
      tester,
    ) async {
      await pump(tester);
      await openSharing(tester);
      answer = () => throw const SuperTabFailure(
        'PROJECT_OWNER_REQUIRED',
        'Only the project owner can manage this project.',
        statusCode: 403,
      );
      await tester.tap(key('swarm-sharing-private'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-sharing-save'));
      await settle(tester);

      expect(
        tester.widget<Text>(key('swarm-sharing-error')).data,
        'Only the project owner can manage this project.',
      );
      expect(key('swarm-sharing-close'), findsOneWidget);
      expect(reader().snapshot!.projectById(project)!.isPrivate, isFalse);

      await tester.tap(key('swarm-sharing-save'));
      await settle(tester);
      expect(sent('project.sharing'), hasLength(2));
      expect(key('swarm-sharing-close'), findsNothing);
      expect(reader().snapshot!.projectById(project)!.isPrivate, isTrue);
    });

    testWidgets('offline: a call lost on the way says so, never stays '
        'Saving', (tester) async {
      await pump(tester);
      await openSharing(tester);
      answer = () => throw TimeoutException('no answer');
      await tester.tap(key('swarm-sharing-save'));
      await settle(tester);
      expect(find.text('Could not reach this Swarm. Try again.'), findsOne);
      expect(find.text('Saving…'), findsNothing);
    });

    testWidgets('the project made someone else\'s while it is open: it '
        'goes, and nothing is sent', (tester) async {
      await pump(tester);
      await openSharing(tester);
      owner = 'diego';
      await moveOn(tester);
      expect(key('swarm-sharing-close'), findsNothing);
      expect(find.byType(BottomSheet), findsNothing);
      expect(sent('project.sharing'), isEmpty);
    });

    testWidgets('the project taken off the Swarm with it open: it closes', (
      tester,
    ) async {
      await pump(tester);
      await openSharing(tester);
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c9', lastChangedAt: 300),
        'head': part('head', 9, headData(projects: const [])),
      };
      await moveOn(tester);
      expect(key('swarm-sharing-close'), findsNothing);
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets('the account signing out with it open: it closes', (
      tester,
    ) async {
      await pump(tester);
      await openSharing(tester);
      account.value = null;
      await tester.pumpAndSettle();
      expect(key('swarm-sharing-close'), findsNothing);
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets('the server is never asked for someone no longer in the '
        'Swarm', (tester) async {
      await pump(tester);
      final error = await swarmShareProject(
        reader(),
        project,
        private: true,
        memberIds: ['diego', 'gone'],
      );
      expect(error, isNull);
      expect(sent('project.sharing').single['memberIds'], ['diego']);
    });

    testWidgets('nothing is sent for someone who may not manage it', (
      tester,
    ) async {
      await pump(tester, ownerId: 'diego', myRole: 'collaborator');
      expect(swarmManagesProject(reader(), project), isFalse);
      expect(
        await swarmShareProject(
          reader(),
          project,
          private: true,
          memberIds: const [],
        ),
        'Only the project owner can manage this project.',
      );
      expect(
        await swarmRenameProject(reader(), project, 'Another'),
        'Only the project owner can manage this project.',
      );
      expect(swarm.commands, isEmpty);
    });
  });

  group('the lock of a private project on Home', () {
    Future<void> row(
      WidgetTester tester, {
      required String visibility,
      String name = 'Mobile',
      String? swarmName,
      SwarmProjectNews news = swarmNoProjectNews,
      double width = 390,
    }) {
      final snapshot = SuperTabSnapshot.fromJson(
        SuperTabParts.firstLoad(
          firstLoad(
            head: headData(
              projects: [
                {
                  'id': project,
                  'name': name,
                  'ownerId': me,
                  'leadConversationId': leadChat,
                  'visibility': visibility,
                  'members': <Object>[],
                  'updateMinutes': 5,
                },
              ],
            ),
          ),
        ).state,
      );
      return tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: width,
                child: SwarmHomeProjectRow(
                  project: SwarmHomeProject(
                    swarmId: tab,
                    project: snapshot.projects.single,
                    news: news,
                  ),
                  swarmName: swarmName,
                  onTap: () {},
                ),
              ),
            ),
          ),
        ),
      );
    }

    final lock = key('swarm-project-private');
    final name = key('swarm-project-name');

    testWidgets('a private project has a lock at the end of its one line, '
        'heard as Private project', (tester) async {
      final semantics = tester.ensureSemantics();
      await row(tester, visibility: 'private');
      expect(lock, findsOneWidget);
      expect(
        tester.getTopLeft(lock).dx,
        greaterThan(tester.getTopRight(name).dx),
      );
      expect(tester.getTopRight(lock).dx, 390 - AppSpace.l);
      expect(
        tester.getCenter(lock).dy,
        moreOrLessEquals(tester.getCenter(name).dy, epsilon: 1),
        reason: 'level with the name, on the one line',
      );
      expect(
        tester.getSize(find.byType(SwarmHomeProjectRow)).height,
        minTouchTarget,
      );
      // Heard with the row's name, as one button.
      expect(
        find.bySemanticsLabel(RegExp(r'#Mobile\nPrivate project')),
        findsOneWidget,
      );
      semantics.dispose();
    });

    testWidgets('a public one has none', (tester) async {
      await row(tester, visibility: 'public');
      expect(lock, findsNothing);
    });

    testWidgets('after the tags waiting in it, as the desktop marks it', (
      tester,
    ) async {
      await row(
        tester,
        visibility: 'private',
        news: (bold: true, tags: 2, hasWaitingTag: true),
      );
      final tags = find.byType(SwarmTags);
      expect(tags, findsOneWidget);
      expect(
        tester.getTopLeft(lock).dx,
        greaterThan(tester.getTopRight(tags).dx),
      );
    });

    testWidgets('a long name and its Swarm ellipsize and keep the lock in '
        'sight', (tester) async {
      await row(
        tester,
        visibility: 'private',
        name: 'A project with a name far too long for one row of a phone',
        swarmName: 'Phone Swarm',
        width: 240,
      );
      expect(tester.takeException(), isNull);
      final rect = tester.getRect(lock);
      expect(rect.right, lessThanOrEqualTo(240));
      expect(rect.left, greaterThanOrEqualTo(tester.getTopRight(name).dx));
    });
  });

  // Last: the faces it loads stay loaded for every test after it. The test
  // font draws each glyph a full em wide, about twice a phone's, so across
  // is measured here only.
  group("the menu in the phone's faces", () {
    setUpAll(loadRealFonts);

    for (final (phone, size, top) in phones) {
      testWidgets('on $phone all eight rows fit across, every label whole', (
        tester,
      ) async {
        await menuFits(tester, size, top, across: true);
      });
    }
  });
}
