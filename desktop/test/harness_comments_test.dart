import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/sharing/harness_comments.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'support/real_fonts.dart';

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (Platform.isMacOS &&
        Platform.environment['HARNESS_COMMENTS_CAPTURE_DIR'] != null) {
      final font = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(font))).load();
      }
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  Future<void> show(
    WidgetTester tester,
    CommentAction manage, {
    VoidCallback? signIn,
    Brightness brightness = Brightness.dark,
    Size size = const Size(460, 560),
    double scale = 1,
    Widget? headerAction,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
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
          child: child!,
        ),
        home: RepaintBoundary(
          key: const ValueKey('comments-preview'),
          child: Scaffold(
            body: HarnessComments(
              manage: manage,
              onSignIn: signIn,
              headerAction: headerAction,
            ),
          ),
        ),
      ),
    );
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final directory = Platform.environment['HARNESS_COMMENTS_CAPTURE_DIR'];
    if (directory == null) return;
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(const ValueKey('comments-preview')),
    );
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(directory).create(recursive: true);
      await File('$directory/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  testWidgets('public guests can read and sign in but cannot post', (
    tester,
  ) async {
    var signIns = 0;
    await show(
      tester,
      (_, _) async => {
        'canComment': false,
        'comments': [
          {
            'id': 'one',
            'authorName': 'Alice',
            'text': 'Looks good 👋',
            'canDelete': false,
          },
        ],
      },
      signIn: () => signIns++,
    );
    await tester.pump();
    expect(find.text('Looks good 👋'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    expect(find.widgetWithText(TextButton, 'Remove'), findsNothing);
    await tester.tap(find.widgetWithText(TextButton, 'Sign in to comment'));
    expect(signIns, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'failed posting retains the draft and id; retry, broadcast refresh and removal work',
    (tester) async {
      final requests = <Map<String, dynamic>>[];
      var comments = <Map<String, dynamic>>[];
      var fail = true;
      await show(tester, (action, payload) async {
        if (action == 'comment_post') {
          requests.add(payload);
          if (fail) {
            fail = false;
            throw StateError('offline');
          }
          comments = [
            {
              'id': payload['id'],
              'authorName': 'Alice',
              'text': payload['text'],
              'canDelete': true,
            },
          ];
        }
        if (action == 'comment_remove') comments = [];
        return {'canComment': true, 'comments': comments};
      });
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('comment-input')),
        'Hello team',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('comment-post')));
      await tester.pump();
      expect(find.textContaining('Your draft is saved'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Hello team',
      );
      await tester.tap(find.byKey(const ValueKey('comment-post')));
      await tester.pump();
      expect(requests, hasLength(2));
      expect(requests[0]['id'], requests[1]['id']);
      expect(find.text('Hello team'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      await tester.tap(find.widgetWithText(TextButton, 'Remove'));
      await tester.pump();
      expect(find.text('Hello team'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'pending post keeps its draft and blocks edits, removal and polling',
    (tester) async {
      final result = Completer<Map<String, dynamic>>();
      final actions = <String>[];
      const existing = {
        'id': 'existing',
        'authorName': 'Morgan',
        'text': 'Please review the current changes.',
        'canDelete': true,
      };
      await show(tester, (action, payload) async {
        actions.add(action);
        if (action == 'comment_post') return result.future;
        return {
          'canComment': true,
          'comments': [existing],
        };
      });
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('comment-input')),
        'Reviewing now',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('comment-post')));
      await tester.pump();
      expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isTrue);
      expect(
        tester
            .widget<FilledButton>(find.byKey(const ValueKey('comment-post')))
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Remove'))
            .onPressed,
        isNull,
      );
      await tester.pump(const Duration(seconds: 5));
      expect(actions, ['comments', 'comment_post']);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Reviewing now',
      );
      await capture(tester, 'pending-dark');
      result.complete({
        'canComment': true,
        'comments': [existing],
      });
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).readOnly,
        isFalse,
      );
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('comments remain usable ${brightness.name} at $scale text', (
        tester,
      ) async {
        final comments = [
          {
            'id': 'one',
            'authorName': 'Morgan Rivera · Product and frontend engineering',
            'createdAt': '2026-09-29T14:06:00Z',
            'text': 'The new layout makes the next step clear. Can we keep the explanation beside the approval choice?',
            'canDelete': true,
          },
          {
            'id': 'two',
            'authorName': 'Alex Chen',
            'createdAt': '2026-09-29T14:12:00Z',
            'text': 'Yes. I’m checking the narrow window and larger text next.',
            'canDelete': false,
          },
        ];
        await show(
          tester,
          (_, _) async => {'canComment': true, 'comments': comments},
          brightness: brightness,
          scale: scale,
          size: scale == 1 ? const Size(460, 560) : const Size(320, 360),
          headerAction: TextButton(onPressed: () {}, child: const Text('Back')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Comments (2)'), findsOneWidget);
        expect(find.text('Back'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await capture(tester, 'discussion-${brightness.name}-$scale');
        await tester.enterText(
          find.byKey(const Key('comment-input')),
          'A draft\nwith a second line\nand one more.',
        );
        await tester.pumpAndSettle();
        final post = find.byKey(const ValueKey('comment-post'));
        await tester.ensureVisible(post);
        await tester.pumpAndSettle();
        expect(post.hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
        await capture(tester, 'composer-${brightness.name}-$scale');
        await tester.pumpWidget(const SizedBox());
      });
    }
  }

  testWidgets(
    'failed initial read shows a scrollable error without an empty claim',
    (tester) async {
      await show(
        tester,
        (_, _) async => throw StateError('offline'),
        scale: 2,
        size: const Size(320, 360),
        signIn: () {},
      );
      await tester.pumpAndSettle();
      expect(find.text('Comments are unavailable.'), findsOneWidget);
      expect(find.text('Start the conversation.'), findsNothing);
      final signIn = find.widgetWithText(TextButton, 'Sign in to comment');
      await tester.ensureVisible(signIn);
      await tester.pumpAndSettle();
      expect(signIn.hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await capture(tester, 'unavailable-dark-2.0');
      await tester.pumpWidget(const SizedBox());
    },
  );
}
