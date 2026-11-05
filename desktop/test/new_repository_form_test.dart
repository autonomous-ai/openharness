import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/lead_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/new_repository.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;

final _project = find.byKey(const ValueKey('new-harness-field-project'));
final _row = find.byKey(
  const ValueKey('new-harness-option-${NewHarnessController.newRepositoryId}'),
);
final _dialog = find.byKey(const ValueKey('new-repository-dialog'));
final _owner = find.byKey(const ValueKey('new-repository-owner'));
final _name = find.byKey(const ValueKey('new-repository-name'));
final _path = find.byKey(const ValueKey('new-repository-path'));
final _private = find.byKey(const ValueKey('new-repository-private'));
final _problem = find.byKey(const ValueKey('new-repository-problem'));
final _install = find.byKey(const ValueKey('new-repository-install'));
final _copy = find.byKey(const ValueKey('new-repository-copy'));
final _use = find.byKey(const ValueKey('new-repository-use'));
final _start = find.byKey(const ValueKey('new-harness-field-start'));
final _note = find.byKey(const ValueKey('new-harness-new-repository-note'));
final _checkAgain = find.byKey(const ValueKey('new-harness-check-repository'));

/// The Swarm starts the Product Manager on a teammate's Team account.
const _diego = LeadMachine(
  id: 'diego-mac',
  name: 'Diego MacBook',
  online: true,
  freeAgents: 3,
  own: false,
  native: false,
  team: true,
);

/// What New Repository asked of the Swarm, and how it answers.
class _Swarm {
  final asks = <(NewRepositoryAsk, String)>[];
  final starts = <LeadSwarmStart>[];
  final ownerChecks = <String>[];
  var checkedAgain = 0;
  Map<String, NewRepositoryOwnerCheck> owners = {};
  Completer<NewRepositoryCreated>? creating;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final capture = Platform.environment['HARNESS_SWARM_FORM_CAPTURE'];
  final previousShadows = debugDisableShadows;
  setUpAll(() async {
    if (capture == null || !Platform.isMacOS) return;
    final bytes = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });
  tearDownAll(() => debugDisableShadows = previousShadows);

  Future<(NewHarnessController, GlobalKey, _Swarm)> mount(
    WidgetTester tester, {
    Brightness brightness = Brightness.dark,
    List<String>? owners = const ['acme', 'autonomous-ai'],
    bool newProject = true,
    String? lead = 'diego-mac',
  }) async {
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    if (capture != null) debugDisableShadows = false;
    addTearDown(() => debugDisableShadows = previousShadows);
    tester.view.physicalSize = const Size(760, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final swarm = _Swarm();
    final f = SuperTabLaunchFixture();
    final box = NewHarnessController(
      f.app,
      machineId: 'm',
      engine: 'codex',
      task: 'A notes app with sync.',
      integration:
          HarnessLaunchIntegration(
              creationId: 'new-repository-fixture',
              actionLabel: newProject ? 'New Project' : 'New Harness',
              projectVisibility: 'public',
              prepare: (_, task, _) async => task,
              beforeSubmit: (_, _) async {},
              complete: (_, _) async {},
              startInSwarm: (start) async => swarm.starts.add(start),
              checkRepositoryOwner: (owner) async {
                swarm.ownerChecks.add(owner);
                return swarm.owners[owner] ??
                    NewRepositoryOwnerCheck('ready', owner: owner);
              },
              createRepository: (ask, task) {
                swarm.asks.add((ask, task));
                return (swarm.creating = Completer()).future;
              },
              checkRepositoryAgain: () async => swarm.checkedAgain++,
            )
            ..leadMachines = newProject ? const [_diego] : null
            ..newRepositoryOwners = owners,
    );
    addTearDown(box.dispose);
    final boundary = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              desktop: true,
              embedded: true,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    if (newProject && lead != null) {
      box.chooseLeadMachine(lead);
      await tester.pumpAndSettle();
    }
    return (box, boundary, swarm);
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    debugDefaultTargetPlatformOverride = null;
    debugDisableShadows = previousShadows;
  }

  Future<void> shot(
    WidgetTester tester,
    GlobalKey boundary,
    String name,
  ) async {
    if (capture == null) return;
    await tester.pump();
    await tester.runAsync(() async {
      final render =
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await render.toImage(pixelRatio: 1.5);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(capture).create(recursive: true);
      await File('$capture/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(_project);
    await tester.pumpAndSettle();
  }

  Future<void> openPrompt(WidgetTester tester) async {
    await openMenu(tester);
    await tester.tap(_row);
    await tester.pumpAndSettle();
  }

  Future<void> typeName(WidgetTester tester, String name) async {
    await tester.enterText(
      find.descendant(of: _name, matching: find.byType(EditableText)),
      name,
    );
    await tester.pumpAndSettle();
  }

  /// Types [owner] and goes on: checked once, not per key.
  Future<void> chooseOwner(WidgetTester tester, String owner) async {
    await tester.enterText(
      find.descendant(of: _owner, matching: find.byType(EditableText)),
      owner,
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
  }

  bool enabled(WidgetTester tester, Finder button) =>
      tester.widget<ButtonStyleButton>(button).onPressed != null;

  String startLabel(WidgetTester tester) => tester
      .widget<Text>(
        find.descendant(of: _start, matching: find.byType(Text)).first,
      )
      .data!;

  Future<void> named(WidgetTester tester, [String name = 'notes']) async {
    await openPrompt(tester);
    await typeName(tester, name);
    await tester.tap(_use);
    await tester.pumpAndSettle();
  }

  for (final brightness in Brightness.values) {
    testWidgets(
      'Choose repo offers New Repository for New Project, in ${brightness.name}',
      (tester) async {
        final (_, boundary, _) = await mount(tester, brightness: brightness);
        await openMenu(tester);
        expect(_row, findsOneWidget);
        expect(
          find.descendant(of: _row, matching: find.text('New Repository')),
          findsOneWidget,
        );
        // A door, as GitHub above it: the menu shows its title alone.
        await shot(tester, boundary, 'new-repository-menu-${brightness.name}');
        await unmount(tester);
      },
    );

    testWidgets(
      'The prompt asks Owner, Name and Private, in ${brightness.name}',
      (tester) async {
        final (_, boundary, swarm) = await mount(
          tester,
          brightness: brightness,
        );
        await openPrompt(tester);
        expect(_dialog, findsOneWidget);
        // The Swarm's first organization, checked as it is chosen.
        expect(
          tester
              .widget<EditableText>(
                find.descendant(
                  of: _owner,
                  matching: find.byType(EditableText),
                ),
              )
              .controller
              .text,
          'acme',
        );
        expect(swarm.ownerChecks, ['acme']);
        expect(
          tester
              .widget<Checkbox>(
                find.descendant(of: _private, matching: find.byType(Checkbox)),
              )
              .value,
          isTrue,
        );
        expect(enabled(tester, _use), isFalse);
        await typeName(tester, 'notes-app');
        expect(tester.widget<Text>(_path).data, 'github.com/acme/notes-app');
        expect(enabled(tester, _use), isTrue);
        await shot(
          tester,
          boundary,
          'new-repository-prompt-${brightness.name}',
        );
        await unmount(tester);
      },
    );

    testWidgets(
      'After Use this name, the composer says what Start does, in ${brightness.name}',
      (tester) async {
        final (box, boundary, _) = await mount(tester, brightness: brightness);
        await named(tester);
        expect(_dialog, findsNothing);
        expect(
          box.project.newRepository,
          const NewRepositoryAsk(owner: 'acme', name: 'notes'),
        );
        expect(
          find.descendant(
            of: _project,
            matching: find.text('acme/notes · new'),
          ),
          findsOneWidget,
        );
        expect(startLabel(tester), 'Create and continue in GitHub');
        expect(
          tester.widget<Text>(_note).data,
          'Creates acme/notes on GitHub, then clones it on Diego MacBook',
        );
        await shot(
          tester,
          boundary,
          'new-repository-composer-${brightness.name}',
        );
        await unmount(tester);
      },
    );
  }

  testWidgets(
    'New Repository is never offered outside New Project, nor where the server cannot create',
    (tester) async {
      await mount(tester, newProject: false);
      await openMenu(tester);
      expect(_row, findsNothing);
      await unmount(tester);
      await mount(tester, owners: null);
      await openMenu(tester);
      expect(_row, findsNothing);
      await unmount(tester);
    },
  );

  testWidgets(
    'A name GitHub would refuse says why, and Use this name stays off (F1)',
    (tester) async {
      await mount(tester);
      await openPrompt(tester);
      await typeName(tester, 'notes app');
      expect(
        tester.widget<Text>(_problem).data,
        'Use letters, numbers, - _ or . (up to 100).',
      );
      expect(enabled(tester, _use), isFalse);
      await unmount(tester);
    },
  );

  testWidgets(
    'An organization without Harness says what its owner does (F4, F5)',
    (tester) async {
      final (_, _, swarm) = await mount(tester);
      swarm.owners = {
        'globex': const NewRepositoryOwnerCheck(
          'not-installed',
          owner: 'globex',
          installUrl: 'https://github.com/apps/harness/installations/new',
        ),
        'initech': const NewRepositoryOwnerCheck(
          'not-accepted',
          owner: 'initech',
        ),
      };
      await openPrompt(tester);
      await typeName(tester, 'notes');
      await chooseOwner(tester, 'globex');
      expect(
        tester.widget<Text>(_problem).data,
        'Harness isn’t on globex’s GitHub yet.',
      );
      expect(_install, findsOneWidget);
      expect(_copy, findsOneWidget);
      expect(enabled(tester, _use), isFalse);
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.tap(_copy);
      await tester.pumpAndSettle();
      expect(
        copied,
        contains('https://github.com/apps/harness/installations/new'),
      );
      await chooseOwner(tester, 'initech');
      expect(
        tester.widget<Text>(_problem).data,
        'An owner of initech needs to accept Harness’s new permission once: GitHub Settings → GitHub Apps → Harness.',
      );
      expect(_install, findsNothing);
      expect(_copy, findsOneWidget);
      expect(enabled(tester, _use), isFalse);
      await chooseOwner(tester, 'acme');
      expect(_problem, findsNothing);
      expect(enabled(tester, _use), isTrue);
      await unmount(tester);
    },
  );

  testWidgets(
    'Start creates it, then the Swarm starts the Product Manager in it',
    (tester) async {
      final (box, _, swarm) = await mount(tester);
      await named(tester);
      await tester.tap(_start);
      await tester.pump();
      expect(
        swarm.asks.single.$1,
        const NewRepositoryAsk(owner: 'acme', name: 'notes'),
      );
      expect(swarm.asks.single.$2, 'A notes app with sync.');
      expect(find.text('Creating acme/notes…'), findsWidgets);
      await tester.tap(_checkAgain);
      await tester.pump();
      expect(swarm.checkedAgain, 1);
      expect(swarm.starts, isEmpty);
      swarm.creating!.complete(
        const NewRepositoryCreated(
          'https://github.com/acme/notes',
          reachable: true,
        ),
      );
      await tester.pumpAndSettle();
      final start = swarm.starts.single;
      expect(start.machineId, 'diego-mac');
      expect(start.repositoryUrl, contains('github.com/acme/notes'));
      expect(start.title, 'notes');
      expect(box.project.repository?.slug, 'acme/notes');
      await unmount(tester);
    },
  );

  testWidgets(
    'A create that made nothing says why, starts nothing, and Start reads Try again',
    (tester) async {
      final (box, _, swarm) = await mount(tester);
      await named(tester);
      await tester.tap(_start);
      await tester.pump();
      const taken =
          'acme/notes already exists. Choose another name, or choose it under GitHub in Choose repo to use it.';
      swarm.creating!.completeError(
        const SuperTabFailure('REPOSITORY_NOT_CREATED', taken),
      );
      await tester.pumpAndSettle();
      expect(find.text(taken), findsOneWidget);
      expect(swarm.starts, isEmpty);
      expect(startLabel(tester), 'Try again');
      // Still the new repository: Try again asks GitHub again.
      expect(box.project.newRepository, isNotNull);
      await tester.tap(_start);
      await tester.pump();
      expect(swarm.asks, hasLength(2));
      swarm.creating!.complete(
        const NewRepositoryCreated(
          'https://github.com/acme/notes-2',
          reachable: true,
        ),
      );
      await tester.pumpAndSettle();
      expect(swarm.starts, hasLength(1));
      await unmount(tester);
    },
  );
}
