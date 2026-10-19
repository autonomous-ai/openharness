import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/guest_folders.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/machine_sharing_form.dart';

import 'support/real_fonts.dart';

/// A machine's daemon answering `shared_machines` as services/sharedMachines.ts does.
class _SharingApp extends AppNotifier {
  _SharingApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  Map<String, dynamic> policy = {
    'emails': <String>[],
    'sameDomain': false,
    'domain': 'autonomous.ai',
    'members': <Map<String, dynamic>>[],
  };
  Map<String, dynamic>? unreadable;
  Map<String, dynamic>? refusal;
  final sets = <({List<String> emails, bool sameDomain})>[];

  /// Turning guest access on: how often it was asked, and what the admin prompt came to.
  int enables = 0;
  Map<String, dynamic>? enableRefusal;

  /// The folders guests may use, as the daemon keeps them; [folderRefusal] answers instead when set.
  final folderSets = <List<({String path, bool write})>>[];
  Map<String, dynamic>? folderRefusal;

  @override
  Future<Map<String, dynamic>> setMachineGuestFolders(
    String machineId,
    List<GuestFolder> folders,
  ) async {
    folderSets.add([
      for (final folder in folders) (path: folder.path, write: folder.write),
    ]);
    if (folderRefusal != null) return folderRefusal!;
    policy = {
      ...policy,
      'folders': [
        for (final folder in folders)
          {'path': folder.path, 'write': folder.write},
      ],
    };
    return policy;
  }

  @override
  Future<Map<String, dynamic>> enableMachineGuests(String machineId) async {
    enables++;
    if (enableRefusal != null) return enableRefusal!;
    policy = {...policy, 'guestAccess': 'ready'};
    return {'ok': true, 'guestAccess': 'ready'};
  }

  @override
  Future<Map<String, dynamic>> machineSharing(String machineId) async =>
      unreadable ?? policy;

  @override
  Future<Map<String, dynamic>> setMachineSharing(
    String machineId,
    List<String> emails, {
    required bool sameDomain,
  }) async {
    sets.add((emails: emails, sameDomain: sameDomain));
    if (refusal != null) return refusal!;
    policy = {...policy, 'emails': emails, 'sameDomain': sameDomain};
    return policy;
  }
}

final _capture = Platform.environment['HARNESS_SHARE_CAPTURE_DIR'];

Future<void> _snap(WidgetTester tester, GlobalKey boundary, String name) async {
  final output = _capture;
  if (output == null) return;
  await tester.pumpAndSettle();
  final render =
      boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  await tester.runAsync(() async {
    final picture = await render.toImage(pixelRatio: 2);
    final bytes = await picture.toByteData(format: ui.ImageByteFormat.png);
    await Directory(output).create(recursive: true);
    await File('$output/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    picture.dispose();
  });
}

void main() {
  setUpAll(() async {
    // Captures use the macOS system face; regression runs the shared metric-compatible fonts.
    if (_capture != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('.AppleSystemUIFont', '/System/Library/Fonts/SFNS.ttf'),
        ('Roboto', '/System/Library/Fonts/SFNS.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    } else {
      await loadRealFonts();
    }
  });

  Future<(String? Function(), GlobalKey)> open(
    WidgetTester tester,
    _SharingApp app, {
    Brightness brightness = Brightness.dark,
  }) async {
    // The app's tokens follow their own brightness (main.dart's _GridTokenScope), not the theme's.
    final saved = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = saved);
    tester.view.physicalSize = const Size(1200, 1400);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    String? closed;
    var wasClosed = false;
    final boundary = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          backgroundColor: DesktopChrome.surface,
          body: DesktopChrome(
            child: Align(
              alignment: Alignment.topLeft,
              child: RepaintBoundary(
                key: boundary,
                child: ColoredBox(
                  color: DesktopChrome.surface,
                  child: SizedBox(
                    width: 560,
                    height: 640,
                    child: MachineSharingForm(
                      app: app,
                      machineId: 'm1',
                      onClose: (message) {
                        wasClosed = true;
                        closed = message;
                      },
                      onFocusChanged: (_) {},
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (() => wasClosed ? (closed ?? '') : null, boundary);
  }

  testWidgets(
    'shares with people and the domain as each change is made, saying only what needs saying',
    (tester) async {
      final app = _SharingApp();
      final (closed, boundary) = await open(tester, app);
      expect(find.text('Share this machine'), findsOneWidget);
      // Nobody yet: no empty box, no hints, no Done; Back (and Esc) leaves.
      expect(
        find.text('Not shared. Only your own devices can use it.'),
        findsNothing,
      );
      expect(find.textContaining('Tab next'), findsNothing);
      expect(find.text('Done'), findsNothing);
      expect(
        find.byKey(const ValueKey('machine-sharing:back')),
        findsOneWidget,
      );
      expect(find.text('Everyone at autonomous.ai'), findsOneWidget);
      await _snap(tester, boundary, 'share-empty-dark');

      // An address the backend would refuse is named, and nothing is sent.
      await tester.enterText(
        find.byKey(const ValueKey('machine-sharing-email')),
        'bitcoinbuilder.ai@!gmail.com',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('machine-sharing:add')));
      await tester.pumpAndSettle();
      expect(
        find.text('“bitcoinbuilder.ai@!gmail.com” is not an email address.'),
        findsOneWidget,
      );
      expect(app.sets, isEmpty);
      await _snap(tester, boundary, 'share-invalid-dark');

      // Several at once, shared the moment Share is pressed.
      await tester.enterText(
        find.byKey(const ValueKey('machine-sharing-email')),
        'Ann@Gmail.com, kim@acme.io',
      );
      await tester.pump();
      app.policy = {
        ...app.policy,
        'members': [
          {
            'email': 'kim@acme.io',
            'name': 'Kim',
            'via': 'email',
            'machines': 1,
          },
        ],
      };
      await tester.tap(find.byKey(const ValueKey('machine-sharing:add')));
      await tester.pumpAndSettle();
      expect(app.sets.last.emails, ['ann@gmail.com', 'kim@acme.io']);
      // A share that went through says nothing: the list shows it.
      expect(find.text('Shared with 2 people.'), findsNothing);
      expect(find.text('Using it'), findsOneWidget);
      expect(find.text('Invited · not using it yet'), findsOneWidget);

      // Everyone at the domain: the switch applies at once.
      await tester.tap(find.byKey(const ValueKey('machine-sharing:domain')));
      await tester.pumpAndSettle();
      expect(app.sets.last.sameDomain, isTrue);
      expect(
        find.text('Anyone with an @autonomous.ai address can use it.'),
        findsOneWidget,
      );
      await _snap(tester, boundary, 'share-people-dark');

      // Removing someone takes them off the list, and that is all that is said.
      await tester.tap(
        find.byKey(const ValueKey('machine-sharing:remove:ann@gmail.com')),
      );
      await tester.pumpAndSettle();
      expect(app.sets.last.emails, ['kim@acme.io']);
      expect(find.textContaining('Stopped sharing'), findsNothing);
      expect(find.text('Undo'), findsNothing);
      expect(find.text('ann@gmail.com'), findsNothing);
      await _snap(tester, boundary, 'share-removed-dark');

      // Someone already on the list is a quiet note under the field, not an error.
      await tester.enterText(
        find.byKey(const ValueKey('machine-sharing-email')),
        'kim@acme.io',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('machine-sharing:add')));
      await tester.pumpAndSettle();
      expect(find.text('Already shared with kim@acme.io.'), findsOneWidget);
      expect(app.sets.last.emails, ['kim@acme.io']);

      // A refusal says why and changes nothing.
      app.refusal = {
        'error': 'VALIDATION_ERROR',
        'message': 'The backend refused it.',
      };
      await tester.tap(find.byKey(const ValueKey('machine-sharing:domain')));
      await tester.pumpAndSettle();
      expect(find.text('The backend refused it.'), findsOneWidget);
      expect(
        tester
            .widget<Switch>(
              find.byKey(const ValueKey('machine-sharing:domain')),
            )
            .value,
        isTrue,
      );

      // Back leaves where the sharing stands.
      await tester.tap(find.byKey(const ValueKey('machine-sharing:back')));
      await tester.pump();
      expect(closed(), 'Shared with 1 person and everyone at autonomous.ai.');
    },
  );

  testWidgets(
    'says what a guest gets, and turns guest access on before the first share, behind one admin prompt',
    (tester) async {
      final app = _SharingApp()
        ..policy = {
          'emails': <String>[],
          'sameDomain': false,
          'domain': 'autonomous.ai',
          'members': <Map<String, dynamic>>[],
          'guestAccess': 'missing',
        };
      await open(tester, app);
      // Guest is the only level (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
      expect(find.textContaining('full access'), findsNothing);
      expect(
        find.textContaining(
          'Guests get their own space on this machine and can use your Claude and ChatGPT plans.',
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining(
          'Sharing asks for an admin password on this machine once.',
        ),
        findsOneWidget,
      );

      // Cancelled at the prompt: nothing is shared, and the form says why.
      app.enableRefusal = {
        'error': 'CANCELLED',
        'message': 'Sharing was not turned on: the admin prompt was cancelled.',
      };
      await tester.tap(find.byKey(const ValueKey('machine-sharing:domain')));
      await tester.pumpAndSettle();
      expect(app.enables, 1);
      expect(app.sets, isEmpty);
      expect(
        find.text('Sharing was not turned on: the admin prompt was cancelled.'),
        findsOneWidget,
      );

      // Approved: guest access first, then the share; the next share asks nothing more.
      app.enableRefusal = null;
      await tester.tap(find.byKey(const ValueKey('machine-sharing:domain')));
      await tester.pumpAndSettle();
      expect(app.enables, 2);
      expect(app.sets.single.sameDomain, isTrue);
      expect(find.textContaining('admin password'), findsNothing);
      await tester.enterText(
        find.byKey(const ValueKey('machine-sharing-email')),
        'kim@acme.io',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('machine-sharing:add')));
      await tester.pumpAndSettle();
      expect(app.enables, 2);
      expect(app.sets.last.emails, ['kim@acme.io']);
    },
  );

  testWidgets(
    'shares folders with guests, read only until the switch lets them edit, and says why one cannot be',
    (tester) async {
      final app = _SharingApp();
      final (closed, _) = await open(tester, app);
      expect(
        find.textContaining('They can read anything inside, secrets too.'),
        findsOneWidget,
      );
      final field = find.byKey(const ValueKey('machine-sharing-folder'));
      final add = find.byKey(const ValueKey('machine-sharing:folder-add'));

      // A path that is not a full one is named, and nothing is sent.
      await tester.enterText(field, 'code/app');
      await tester.pump();
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Enter the folder’s full path on this machine, like /Users/you/project.',
        ),
        findsOneWidget,
      );
      expect(app.folderSets, isEmpty);

      // Shared read only.
      await tester.enterText(field, '/Users/dee/code/app/');
      await tester.pump();
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(app.folderSets.last, [
        (path: '/Users/dee/code/app', write: false),
      ]);
      expect(find.text('/Users/dee/code/app'), findsOneWidget);
      expect(find.text('Read only'), findsOneWidget);

      // Once is enough.
      await tester.enterText(field, '/Users/dee/code/app');
      await tester.pump();
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(
        find.text('Guests can already use /Users/dee/code/app.'),
        findsOneWidget,
      );
      expect(app.folderSets, hasLength(1));

      // The switch lets them edit it.
      await tester.tap(
        find.byKey(
          const ValueKey('machine-sharing:folder-write:/Users/dee/code/app'),
        ),
      );
      await tester.pumpAndSettle();
      expect(app.folderSets.last, [(path: '/Users/dee/code/app', write: true)]);
      expect(find.text('Guests can edit it'), findsOneWidget);

      // The machine refuses one that is not the owner's, in words, and nothing changes.
      app.folderRefusal = {
        'error': 'BAD_REQUEST',
        'message': 'Only your own folders can be shared: /Users/kim',
      };
      await tester.enterText(field, '/Users/kim');
      await tester.pump();
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(
        find.text('Only your own folders can be shared: /Users/kim'),
        findsOneWidget,
      );
      // Kept in the field to correct, never listed.
      expect(
        find.byKey(const ValueKey('machine-sharing-folder:/Users/kim')),
        findsNothing,
      );
      app.folderRefusal = null;

      // Taken back.
      await tester.tap(
        find.byKey(
          const ValueKey('machine-sharing:folder-remove:/Users/dee/code/app'),
        ),
      );
      await tester.pumpAndSettle();
      expect(app.folderSets.last, isEmpty);
      expect(find.text('/Users/dee/code/app'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('machine-sharing:back')));
      await tester.pump();
      expect(closed(), 'Not shared.');
    },
  );

  testWidgets(
    'shared already, it says when guests are stopped until guest access is on, and turns it on',
    (tester) async {
      final app = _SharingApp()
        ..policy = {
          'emails': ['kim@acme.io'],
          'sameDomain': false,
          'domain': 'autonomous.ai',
          'members': <Map<String, dynamic>>[],
          'guestAccess': 'outdated',
        };
      await open(tester, app);
      expect(
        find.text(
          'Guests cannot start harnesses until you turn guest access on again after the update.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('machine-sharing:guests-on')));
      await tester.pumpAndSettle();
      expect(app.enables, 1);
      expect(app.sets, isEmpty);
      expect(
        find.byKey(const ValueKey('machine-sharing:guests-on')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'Back with nothing changed closes quietly; light appearance; the domain is not listed person by person',
    (tester) async {
      final app = _SharingApp()
        ..policy = {
          'emails': ['ann@gmail.com'],
          'sameDomain': true,
          'domain': 'autonomous.ai',
          'members': [
            {'email': 'ann@gmail.com', 'via': 'email', 'machines': 2},
            {'email': 'lee@autonomous.ai', 'via': 'domain', 'machines': 1},
          ],
        };
      final (closed, boundary) = await open(
        tester,
        app,
        brightness: Brightness.light,
      );
      // Everyone at the domain is the switch: since 2026-10-16 they use it with no add step, so the
      // members hold the whole domain, and none of them is a row of their own.
      expect(find.text('lee@autonomous.ai'), findsNothing);
      expect(find.textContaining('added from'), findsNothing);
      expect(find.text('Using it'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('machine-sharing:remove:ann@gmail.com')),
        findsOneWidget,
      );
      await _snap(tester, boundary, 'share-people-light');
      await tester.tap(find.byKey(const ValueKey('machine-sharing:back')));
      await tester.pump();
      expect(closed(), '');
    },
  );

  testWidgets(
    'a machine that cannot say offers Retry, and no domain at a public one',
    (tester) async {
      final app = _SharingApp()..unreadable = {'error': 'UNSUPPORTED'};
      final (_, boundary) = await open(tester, app);
      expect(
        find.text('Update Harness on this machine to share it.'),
        findsOneWidget,
      );
      await _snap(tester, boundary, 'share-unavailable-dark');
      app.unreadable = null;
      app.policy = {...app.policy, 'domain': null};
      await tester.tap(find.byKey(const ValueKey('machine-sharing:retry')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('machine-sharing:domain')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('machine-sharing-email')),
        findsOneWidget,
      );
    },
  );
}
