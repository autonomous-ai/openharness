import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/sharing/share_harness_dialog.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/terminal/terminal_text.dart' show terminalFontStore;
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'support/real_fonts.dart';
import 'keymap_host_test.dart' show MemoryKeymap, key;

class SharingApp extends AppNotifier {
  SharingApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  final calls = <(String, String, String)>[];
  @override
  Future<Map<String, dynamic>> manageHarnessShares(
    String machineId,
    String agentId,
    String action, [
    Map<String, dynamic> payload = const {},
  ]) async {
    calls.add((machineId, agentId, action));
    return {'shares': []};
  }
}

void main() {
  setUpAll(() async {
    // Native captures use real fonts; Chrome uses its test font without
    // reading the host filesystem.
    if (kIsWeb) return;
    await loadRealFonts();
    if (Platform.isMacOS &&
        Platform.environment['HARNESS_SHARE_SCREENSHOT'] != null) {
      final sans = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in [
        '.AppleSystemUIFont',
        'SF Pro Text',
        'Roboto',
        'Ubuntu Sans',
      ]) {
        await (FontLoader(family)..addFont(Future.value(sans))).load();
      }
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  Future<void> show(
    WidgetTester tester,
    ShareAction manage, {
    Size size = const Size(900, 800),
    AppKeymap? keymap,
    Brightness brightness = Brightness.dark,
    double scale = 1,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: keymap == null
              ? child!
              : KeymapProvider(keymap: keymap, child: child!),
        ),
        home: RepaintBoundary(
          key: const Key('sharing-preview'),
          child: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () {
                  showDialog<void>(
                    context: context,
                    builder: (_) => RepaintBoundary(
                      key: const Key('sharing-dialog-preview'),
                      child: ShareHarnessDialog(
                        name: 'Climate dashboard',
                        manage: manage,
                      ),
                    ),
                  );
                },
                child: const Text('Open share'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open share'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Map<String, dynamic> person(
    String email, {
    String? error,
    bool pending = false,
    bool expired = false,
    int watching = 0,
  }) => {
    'id': email,
    'email': email,
    'expiresAt': '2026-10-17T00:00:00.000Z',
    'error': error,
    'pending': pending,
    'expired': expired,
    'watching': watching,
  };
  final submit = find.byKey(const ValueKey('share-choice-1'));

  Future<void> field(WidgetTester tester, String name) async {
    if (find.byKey(ValueKey('share-field-$name')).evaluate().isEmpty) {
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    }
    final target = find.byKey(ValueKey('share-field-$name'));
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    await tester.tap(target);
    await tester.pump();
  }

  Future<void> close(WidgetTester tester) async {
    for (
      var i = 0;
      i < 3 && find.byType(ShareHarnessDialog).evaluate().isNotEmpty;
      i++
    ) {
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
    }
  }

  Future<void> capture(WidgetTester tester, String state) async {
    if (kIsWeb) return;
    final output = Platform.environment['HARNESS_SHARE_SCREENSHOT'];
    if (output == null) return;
    final oldShadows = debugDisableShadows;
    debugDisableShadows = false;
    for (final object in tester.allRenderObjects) {
      object.markNeedsPaint();
    }
    await tester.pump(const Duration(milliseconds: 300));
    var region = tester.getRect(
      find.byKey(const ValueKey('share-form-surface')),
    );
    final choices = find.byKey(const ValueKey('share-choices-surface'));
    if (choices.evaluate().isNotEmpty) {
      region = region.expandToInclude(tester.getRect(choices));
    }
    final layer = tester.binding.renderViews.first.debugLayer! as OffsetLayer;
    await tester.runAsync(() async {
      final image = await layer.toImage(region.inflate(12), pixelRatio: 2);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$output.$state.png').writeAsBytes(png!.buffer.asUint8List());
      image.dispose();
    });
    debugDisableShadows = oldShadows;
    for (final object in tester.allRenderObjects) {
      object.markNeedsPaint();
    }
    await tester.pump();
  }

  testWidgets(
    'compact form uses one-row selection and chooser navigation never changes access',
    (tester) async {
      final changes = <String>[];
      String visibility = 'private';
      await show(tester, (action, payload) async {
        if (action == 'link') {
          visibility = payload['visibility'] as String;
          changes.add(visibility);
        }
        return {
          'collaboration': true,
          'shares': [],
          'link': {'visibility': visibility},
        };
      }, size: const Size(1600, 900));
      final compact = tester.getRect(
        find.byKey(const ValueKey('share-form-surface')),
      );
      expect(find.byType(TextField), findsNothing);
      expect(find.text('Invite for'), findsNothing);
      expect(
        tester
            .widget<Semantics>(find.byKey(const ValueKey('share-field-copy')))
            .properties
            .selected,
        isTrue,
      );
      await capture(tester, 'compact');
      // Copy -> Options -> People -> Access. Moving fields reveals, but never commits, choices.
      for (var i = 0; i < 3; i++) {
        await key(tester, LogicalKeyboardKey.arrowUp);
      }
      expect(
        find.byKey(const ValueKey('share-choices-surface')),
        findsOneWidget,
      );
      expect(
        tester.getRect(find.byKey(const ValueKey('share-form-surface'))),
        compact,
      );
      expect(changes, isEmpty);
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(
        tester
            .widget<Semantics>(find.byKey(const ValueKey('share-choice-1')))
            .properties
            .selected,
        isTrue,
      );
      expect(
        tester.getSize(find.byKey(const ValueKey('share-choice-1'))).height,
        greaterThanOrEqualTo(36),
      );
      await capture(tester, 'public-choice');
      await key(tester, LogicalKeyboardKey.tab, shift: true);
      expect(changes, isEmpty);
      expect(find.text('Private'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.tab);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(changes, ['public']);
      expect(find.byKey(const ValueKey('share-choices-surface')), findsNothing);
      expect(
        tester
            .widget<Semantics>(find.byKey(const ValueKey('share-field-copy')))
            .properties
            .selected,
        isTrue,
      );
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(changes, [
        'public',
      ], reason: 'holding Enter cannot also copy or change another value');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'narrow form preserves drafts and remaps while terminal font and theme changes leave its geometry intact',
    (tester) async {
      final map = MemoryKeymap()
        ..apply('''{"bindings":[
      {"keys":"enter","command":null,"when":"picker"},
      {"keys":"alt+enter","command":"picker.accept","when":"picker"}
    ]}''');
      addTearDown(map.dispose);
      final originalFont = terminalFontStore.value;
      final originalTheme = terminalThemeStore.value;
      addTearDown(() {
        terminalFontStore.value = originalFont;
        terminalThemeStore.value = originalTheme;
      });
      var invites = 0;
      await show(
        tester,
        (action, payload) async {
          if (action == 'invite') invites++;
          return {'collaboration': true, 'shares': []};
        },
        size: const Size(440, 760),
        keymap: map,
      );
      await field(tester, 'people');
      await tester.enterText(find.byType(TextField), 'ken@example.com');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      expect(
        invites,
        0,
        reason: 'unbound Enter stays unbound in an email editor',
      );
      final editorBefore = tester.getRect(find.byType(TextField));
      terminalFontStore.value = TerminalStyle(
        fontSize: 22,
        fontFamily: originalFont.fontFamily,
        fontFamilyFallback: originalFont.fontFamilyFallback,
      );
      terminalThemeStore.value = TerminalThemeChoice.tango;
      await tester.pump();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'ken@example.com',
      );
      expect(tester.takeException(), isNull);
      expect(tester.getRect(find.byType(TextField)), editorBefore);
      await capture(tester, 'narrow-desktop');
      await tester.tap(find.byKey(const ValueKey('share-back')));
      await tester.pump();
      expect(find.text('Copy link'), findsOneWidget);
      await field(tester, 'people');
      final editor = tester.widget<TextField>(find.byType(TextField));
      expect(editor.controller!.text, 'ken@example.com');
      editor.controller!.value = editor.controller!.value.copyWith(
        composing: const TextRange(start: 0, end: 3),
      );
      await key(tester, LogicalKeyboardKey.enter, alt: true);
      expect(
        invites,
        0,
        reason: 'an input-method candidate cannot send an invitation',
      );
      editor.controller!.value = editor.controller!.value.copyWith(
        composing: TextRange.empty,
      );
      await key(tester, LogicalKeyboardKey.enter, alt: true);
      await tester.pump();
      expect(invites, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'live people updates preserve the selected recipient and email draft',
    (tester) async {
      var recipients = [person('ken@example.com'), person('diego@example.com')];
      final removed = <String>[];
      await show(tester, (action, payload) async {
        if (action == 'remove') {
          removed.add(payload['id'] as String);
          recipients.removeWhere((person) => person['id'] == payload['id']);
        }
        return {'collaboration': true, 'shares': recipients};
      }, size: const Size(1600, 900));
      await field(tester, 'people');
      await tester.enterText(find.byType(TextField), 'next@example.com');
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowDown);
      recipients = recipients.reversed.toList();
      await tester.pump(const Duration(seconds: 5));
      await key(tester, LogicalKeyboardKey.enter);
      expect(removed, ['ken@example.com']);
      final editor = tester.widget<TextField>(find.byType(TextField));
      expect(editor.controller!.text, 'next@example.com');
      expect(editor.focusNode!.hasFocus, isTrue);
      expect(find.text('diego@example.com'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Options opens comments and returns to the same form', (
    tester,
  ) async {
    final calls = <String>[];
    await show(tester, (action, payload) async {
      calls.add(action);
      return {
        'collaboration': true,
        'shares': [],
        'comments': [],
        'canComment': true,
      };
    }, size: const Size(1600, 900));
    await field(tester, 'options');
    await field(tester, 'comments');
    await tester.pumpAndSettle();
    expect(find.text('Start the conversation.'), findsOneWidget);
    expect(find.byKey(const ValueKey('comments-heading')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('share-choices-surface')),
        matching: find.text('Comments'),
      ),
      findsOneWidget,
    );
    expect(calls, ['list', 'comments']);
    await tester.enterText(find.byType(TextField), 'Please review this step.');
    tester.view.physicalSize = const Size(900, 800);
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Please review this step.',
      reason: 'moving the discussion into the narrow pane keeps its draft',
    );
    expect(calls, ['list', 'comments']);
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.text('Copy link'), findsOneWidget);
    expect(find.text('Hide'), findsOneWidget);
    expect(find.text('Private'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'one stable browser link can be copied, made public/private and stopped',
    (tester) async {
      Map<String, dynamic>? link;
      final changes = <String>[];
      String? clipboard;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboard = (call.arguments as Map)['text'] as String;
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
      await show(tester, (action, payload) async {
        if (action == 'link') {
          changes.add(payload['visibility'] as String);
          link = {
            'visibility': payload['visibility'],
            'pending': false,
            'error': null,
            'url': 'https://harness.example/s/fixture#key=pinned',
          };
        }
        return {'collaboration': true, 'link': link, 'shares': []};
      });
      expect(find.text('Private'), findsOneWidget);
      expect(find.text('Only you'), findsOneWidget);
      await tester.tap(find.text('Copy link'));
      await tester.pump();
      expect(changes, ['private']);
      expect(clipboard, 'https://harness.example/s/fixture#key=pinned');
      expect(find.text('Link copied.'), findsOneWidget);
      await capture(tester, 'private');
      await field(tester, 'access');
      await capture(tester, 'access-choices');
      await tester.tap(find.byKey(const ValueKey('share-choice-1')));
      await tester.pump();
      expect(changes.last, 'public');
      expect(find.text('Public'), findsOneWidget);
      await capture(tester, 'public');
      await tester.tap(find.text('Copy link'));
      await tester.pump();
      expect(changes, [
        'private',
        'public',
      ], reason: 'copying never silently changes visibility');
      await field(tester, 'access');
      await tester.tap(find.byKey(const ValueKey('share-choice-0')));
      await tester.pump();
      expect(changes.last, 'private');
      await field(tester, 'options');
      await tester.tap(find.text('Stop sharing'));
      await tester.pump();
      expect(changes.last, 'off');
      expect(find.text('Sharing stopped.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a pending link is not copied and an older daemon keeps actionable update guidance',
    (tester) async {
      await show(
        tester,
        (action, _) async => {
          'collaboration': true,
          'shares': [],
          'link': action == 'list'
              ? null
              : {
                  'visibility': 'private',
                  'pending': true,
                  'error': null,
                  'url': 'https://harness.example/s/pending#key=pin',
                },
        },
      );
      await tester.tap(find.text('Copy link'));
      await tester.pump();
      expect(find.textContaining('Waiting for the connection'), findsOneWidget);
      expect(find.text('Link copied.'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('agent-pane entry point manages the exact selected harness', (
    tester,
  ) async {
    final app = SharingApp();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showShareHarnessDialog(
                context,
                app,
                'machine',
                'agent',
                'Climate dashboard',
              ),
              child: const Text('Share'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Share'));
    await tester.pumpAndSettle();
    expect(app.calls, [('machine', 'agent', 'list')]);
    expect(find.text('Share harness'), findsOneWidget);
    expect(find.text('Climate dashboard'), findsOneWidget);
    await close(tester);
    await tester.pumpAndSettle();
    app.dispose();
  });

  testWidgets(
    'invite and remove errors remain actionable and expiry can be changed',
    (tester) async {
      var removing = false;
      final invites = <Map<String, dynamic>>[];
      await show(tester, (action, payload) async {
        if (action == 'invite') {
          invites.add(payload);
          throw const WsRequestFailure(
            responseType: 'harness_share_invite_result',
            code: 'DENIED',
            detail: 'This harness cannot be shared yet.',
          );
        }
        if (action == 'remove') {
          removing = true;
          throw StateError('offline');
        }
        return {
          'shares': [person('ken@example.com')],
        };
      });
      await field(tester, 'options');
      await field(tester, 'expiry');
      await tester.tap(find.text('7 days'));
      await tester.pumpAndSettle();
      await field(tester, 'people');
      await tester.enterText(find.byType(TextField), 'diego@example.com');
      tester
          .widget<TextField>(find.byType(TextField))
          .onSubmitted
          ?.call('diego@example.com');
      await tester.pump();
      expect(invites.single['days'], 7);
      expect(find.text('This harness cannot be shared yet.'), findsOneWidget);
      await tester.tap(find.text('Remove ken@example.com'));
      await tester.pump();
      expect(removing, isTrue);
      expect(find.textContaining('Check the connection'), findsOneWidget);
      expect(find.text('ken@example.com'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'invites normalized emails, shows live presence and immediately removes access',
    (tester) async {
      var shares = <Map<String, dynamic>>[];
      final calls = <(String, Map<String, dynamic>)>[];
      await show(tester, (action, payload) async {
        calls.add((action, payload));
        if (action == 'invite') {
          shares = [
            person('ken@example.com', watching: 1),
            person('diego@example.com'),
          ];
        }
        if (action == 'remove') {
          shares.removeWhere((row) => row['id'] == payload['id']);
        }
        return {'shares': shares};
      });
      await field(tester, 'people');
      expect(find.text('No invited people yet.'), findsOneWidget);
      expect(find.textContaining('cannot control your agent'), findsOneWidget);
      await tester.enterText(
        find.byType(TextField),
        'KEN@example.com; diego@example.com, ken@example.com',
      );
      await tester.pump();
      await tester.tap(submit);
      await tester.pump();
      expect(calls.last.$1, 'invite');
      expect(calls.last.$2, {
        'emails': ['ken@example.com', 'diego@example.com'],
        'days': 30,
      });
      expect(find.text('2 people now have view-only access.'), findsOneWidget);
      expect(find.text('Watching now · Can view'), findsOneWidget);
      // The People pane owns focus while the invitation is edited.
      expect(tester.takeException(), isNull);
      // Optional artifact for visual review; no golden files or production filesystem writes.
      final output = kIsWeb
          ? null
          : Platform.environment['HARNESS_SHARE_SCREENSHOT'];
      if (output != null) {
        final boundary = tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const Key('sharing-dialog-preview')),
        );
        await tester.pump(const Duration(milliseconds: 300));
        await tester.runAsync(() async {
          final image = await boundary.toImage();
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(output).writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.tap(find.text('Remove ken@example.com'));
      await tester.pump();
      expect(calls.last.$1, 'remove');
      expect(calls.last.$2, {'id': 'ken@example.com'});
      expect(find.text('ken@example.com'), findsNothing);
      expect(find.text('Access removed.'), findsOneWidget);
      await tester.pump(const Duration(seconds: 5));
      expect(calls.last.$1, 'list');
      await close(tester);
      await tester.pumpAndSettle();
      expect(find.text('Share harness'), findsNothing);
    },
  );

  testWidgets(
    'validates addresses locally and prevents duplicate submissions while saving',
    (tester) async {
      final pending = Completer<Map<String, dynamic>>();
      var invites = 0;
      await show(tester, (action, _) async {
        if (action == 'invite') {
          invites++;
          return pending.future;
        }
        return {'shares': []};
      });
      await field(tester, 'people');
      expect(tester.widget<Semantics>(submit).properties.enabled, isFalse);
      for (final invalid in [
        'bad',
        List.generate(21, (i) => 'a$i@example.com').join(','),
      ]) {
        await tester.enterText(find.byType(TextField), invalid);
        await tester.pump();
        await tester.tap(submit);
        await tester.pump();
        expect(find.textContaining('Enter up to 20 valid'), findsOneWidget);
      }
      expect(invites, 0);
      await tester.enterText(find.byType(TextField), 'ken@example.com');
      await tester.pump();
      await tester.tap(submit);
      await tester.pump();
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      expect(tester.widget<Semantics>(submit).properties.enabled, isFalse);
      await tester.pump(const Duration(seconds: 5));
      expect(invites, 1);
      pending.complete({
        'shares': [person('ken@example.com', pending: true)],
      });
      await tester.pump();
      await tester.pump();
      expect(find.text('Waiting for connection'), findsOneWidget);
      expect(find.textContaining('Invitations saved.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'renders pending, expired and rejected grants clearly at a narrow width',
    (tester) async {
      await show(
        tester,
        (_, _) async => {
          'shares': [
            person('ken@example.com', pending: true),
            person('diego@example.com', expired: true),
            person('owner@example.com', error: 'You already own this harness.'),
          ],
        },
        size: const Size(440, 680),
      );
      await field(tester, 'people');
      expect(find.text('Waiting for connection'), findsOneWidget);
      expect(find.text('Expired · add again to renew'), findsOneWidget);
      expect(find.text('You already own this harness.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'shows actionable errors, recovers on retry and survives dismissal during a request',
    (tester) async {
      var fails = true;
      await show(tester, (_, _) async {
        if (fails) {
          throw const WsRequestFailure(
            responseType: 'harness_share_list_result',
            code: 'UNSUPPORTED',
          );
        }
        return {'shares': []};
      });
      expect(
        find.text('Update Harness on this machine to start sharing.'),
        findsOneWidget,
      );
      fails = false;
      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(find.text('Only you'), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      final pending = Completer<Map<String, dynamic>>();
      await show(tester, (_, _) => pending.future);
      await close(tester);
      await tester.pumpAndSettle();
      pending.complete({'shares': []});
      await tester.pump();
      expect(tester.takeException(), isNull);
    },
  );

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 1.7]) {
      testWidgets(
        'sharing keeps actions and email entry usable in ${brightness.name} at $scale',
        (tester) async {
          final changes = <String>[];
          await show(
            tester,
            (action, payload) async {
              if (action != 'list' && action != 'comments') changes.add(action);
              return {
                'collaboration': true,
                'shares': [],
                'comments': [],
                'canComment': true,
              };
            },
            brightness: brightness,
            scale: scale,
            size: scale == 1 ? const Size(1280, 800) : const Size(480, 360),
          );
          expect(find.text('Copy link').hitTestable(), findsOneWidget);
          expect(find.text('Close').hitTestable(), findsOneWidget);
          await capture(tester, 'desktop-${brightness.name}-$scale');
          await field(tester, 'people');
          await tester.enterText(
            find.byType(TextField),
            'reviewer@example.com',
          );
          await tester.pumpAndSettle();
          expect(find.byType(TextField).hitTestable(), findsOneWidget);
          expect(find.text('Back').hitTestable(), findsOneWidget);
          expect(changes, isEmpty);
          await capture(tester, 'people-${brightness.name}-$scale');
          await tester.tap(find.text('Back'));
          await tester.pumpAndSettle();
          expect(find.text('Copy link').hitTestable(), findsOneWidget);
          await field(tester, 'options');
          await field(tester, 'comments');
          await tester.pumpAndSettle();
          await tester.enterText(
            find.byKey(const Key('comment-input')),
            'Please review the latest version.',
          );
          await tester.pumpAndSettle();
          final post = find.byKey(const ValueKey('comment-post'));
          await tester.ensureVisible(post);
          await tester.pumpAndSettle();
          expect(post.hitTestable(), findsOneWidget);
          expect(
            find.byKey(const ValueKey('comments-heading')),
            findsOneWidget,
          );
          await capture(tester, 'comments-${brightness.name}-$scale');
          await tester.tap(find.text('Back'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Close'));
          await tester.pumpAndSettle();
          expect(find.byType(ShareHarnessDialog), findsNothing);
          expect(changes, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets(
    'a stale presence refresh cannot erase a newly saved invitation',
    (tester) async {
      var lists = 0;
      final stale = Completer<Map<String, dynamic>>();
      await show(tester, (action, _) async {
        if (action == 'list' && ++lists > 1) return stale.future;
        return {
          'shares': action == 'invite' ? [person('ken@example.com')] : [],
        };
      });
      await tester.pump(const Duration(seconds: 5));
      await field(tester, 'people');
      await tester.enterText(find.byType(TextField), 'ken@example.com');
      await tester.pump();
      await tester.tap(submit);
      await tester.pump();
      stale.complete({'shares': []});
      await tester.pump();
      expect(find.text('ken@example.com'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
