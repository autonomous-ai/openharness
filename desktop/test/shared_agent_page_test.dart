import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/measurement/hub_usage.dart';
import 'package:harness/sharing/shared_agent_location.dart';
import 'package:harness/sharing/shared_agent_page.dart';
import 'package:harness/sharing/shared_harness_panel.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/empty_state.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/web_download_button.dart';
import 'package:url_launcher/link.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  const id = '11111111-1111-4111-8111-111111111111';
  final key = base64Encode(List.filled(32, 1));
  late AppNotifier app;
  late Dio dio;
  late List<RequestOptions> requests;
  late int status;
  late Map<String, dynamic> metadata;
  late int harnessOpens;

  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    requests = [];
    status = 200;
    metadata = {'ownerPublicKey': key, 'online': false};
    harnessOpens = 0;
    dio = Dio()
      ..interceptors.add(
        InterceptorsWrapper(
          onRequest: (request, handler) {
            requests.add(request);
            handler.resolve(
              Response(
                requestOptions: request,
                statusCode: status,
                data: {'data': metadata},
              ),
            );
          },
        ),
      );
  });
  tearDown(() {
    dio.close();
    app.dispose();
  });

  Future<void> show(
    WidgetTester tester, {
    String? pinnedKey,
    Brightness brightness = Brightness.dark,
    Size size = const Size(800, 600),
    double scale = 1,
    String environment = 'stag',
    HubUsage? usage,
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
          key: const ValueKey('shared-access-preview'),
          child: SharedAgentPage(
            app: app,
            dio: dio,
            location: SharedAgentLocation(id, pinnedKey, environment),
            usage: usage,
            openHarness: () async => harnessOpens++,
          ),
        ),
      ),
    );
    for (
      var i = 0;
      i < 20 && find.text('Opening shared harness…').evaluate().isNotEmpty;
      i++
    ) {
      await tester.pump(const Duration(milliseconds: 10));
    }
  }

  Future<void> capture(WidgetTester tester, String name) async {
    final directory = Platform.environment['HARNESS_COMMENTS_CAPTURE_DIR'];
    if (directory == null) return;
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(const ValueKey('shared-access-preview')),
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

  testWidgets('the Harness mark opens the product page in a new tab', (
    tester,
  ) async {
    await show(tester);
    final link = tester.widget<Link>(
      find.ancestor(of: find.text('Harness'), matching: find.byType(Link)),
    );
    expect(link.uri, Uri.parse('https://www.autonomous.ai/harness-app'));
    expect(link.target, LinkTarget.blank);
    // Outside a browser no build can be detected: the page that lists them.
    expect(
      WebDownloadButton.uri,
      Uri.parse('https://harness.autonomous.ai/desktop'),
    );
    await tester.pumpWidget(const SizedBox());
  });

  /// The state's one way forward: a filled button a thumb can hit.
  Finder primary(String label) => find.widgetWithText(FilledButton, label);

  void expectThumbSized(WidgetTester tester, Finder button) {
    expect(button, findsOneWidget);
    final size = tester.getSize(button);
    expect(size.height, greaterThanOrEqualTo(44));
    expect(size.width, greaterThanOrEqualTo(44));
  }

  /// No state that cannot be helped by trying again offers it.
  void expectNoRetry() {
    for (final label in ['Retry', 'Try again', 'Check now']) {
      expect(find.text(label), findsNothing, reason: label);
    }
  }

  group('an incomplete link', () {
    testWidgets('says what to do in one sentence and offers Open Harness', (
      tester,
    ) async {
      await show(tester);
      expect(find.text('This shared link is incomplete'), findsOneWidget);
      expect(
        find.text('Ask the owner to copy the whole link again.'),
        findsOneWidget,
      );
      expectNoRetry();
      expect(find.text('Sign in'), findsNothing);
      expect(requests, isEmpty);
      expect(find.byType(SharedHarnessPanel), findsNothing);
      expectThumbSized(tester, primary('Open Harness'));
      await tester.tap(primary('Open Harness'));
      await tester.pump();
      expect(harnessOpens, 1);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('is drawn as the app\'s empty state, with its icon', (
      tester,
    ) async {
      await show(tester);
      expect(
        find.descendant(
          of: find.byType(EmptyState),
          matching: find.text('This shared link is incomplete'),
        ),
        findsOneWidget,
      );
      expect(find.byIcon(AppIcons.unlink), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  testWidgets('a changed owner identity never opens a viewer', (tester) async {
    metadata['ownerPublicKey'] = base64Encode(List.filled(32, 2));
    await show(tester, pinnedKey: key);
    expect(find.text('This link no longer matches its owner'), findsOneWidget);
    expect(find.byType(SharedHarnessPanel), findsNothing);
    expect(requests.single.headers['x-autonomous-env'], 'stag');
    expect(requests.single.headers.containsKey('Authorization'), isFalse);
    expectNoRetry();
    expectThumbSized(tester, primary('Open Harness'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a private link asks a signed-out visitor to sign in', (
    tester,
  ) async {
    status = 401;
    app.status = AppStatus.unauthenticated;
    await show(tester, pinnedKey: key);
    expect(find.text('This shared harness is private'), findsOneWidget);
    expect(
      find.text('Sign in with the email it was shared with.'),
      findsOneWidget,
    );
    expect(find.byIcon(AppIcons.lock), findsOneWidget);
    expectThumbSized(tester, primary('Sign in'));
    expectNoRetry();
    expect(find.byType(SharedHarnessPanel), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  group('a link refused to a signed-in reader', () {
    for (final refusal in [403, 404, 401]) {
      testWidgets('($refusal) never asks to sign in again', (tester) async {
        status = refusal;
        app
          ..status = AppStatus.authenticated
          ..currentUser = const CurrentUserProfile(
            name: 'Jamie',
            email: 'jamie@example.test',
          );
        await show(tester, pinnedKey: key);
        expect(
          find.text('You can\u2019t open this shared harness'),
          findsOneWidget,
        );
        // Expired, turned off or another email: the server answers alike.
        expect(
          find.text(
            'It may have expired or been turned off, or it was shared with '
            'an email other than jamie@example.test.',
          ),
          findsOneWidget,
        );
        expect(find.text('Sign in'), findsNothing);
        expectNoRetry();
        expectThumbSized(tester, primary('Switch account'));
        final open = find.widgetWithText(TextButton, 'Open Harness');
        expectThumbSized(tester, open);
        await tester.tap(open);
        await tester.pump();
        expect(harnessOpens, 1);
        await tester.pumpWidget(const SizedBox());
      });
    }
  });

  testWidgets('a server error is a failed read, not a refusal', (tester) async {
    status = 502;
    await show(tester, pinnedKey: key);
    expect(find.text('Couldn\u2019t open this shared harness'), findsOneWidget);
    expect(find.text('Check your connection and try again.'), findsOneWidget);
    expectThumbSized(tester, primary('Try again'));
    await tester.tap(primary('Try again'));
    await tester.pump(const Duration(milliseconds: 50));
    expect(requests.length, 2);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'offline links retry automatically and stop retrying when closed',
    (tester) async {
      await show(tester, pinnedKey: key);
      expect(find.text('The owner\u2019s computer is offline'), findsOneWidget);
      expect(
        find.text('This page opens the harness by itself when it is back.'),
        findsOneWidget,
      );
      expect(find.byIcon(AppIcons.cloudOff), findsOneWidget);
      expectThumbSized(tester, primary('Check now'));
      expect(find.byType(SharedHarnessPanel), findsNothing);
      expect(requests.length, 1);
      await tester.pump(const Duration(seconds: 10));
      for (
        var i = 0;
        i < 20 && find.text('Opening shared harness…').evaluate().isNotEmpty;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(requests.length, 2);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 20));
      expect(requests.length, 2);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a state sits in the middle of a computer\'s window', (
    tester,
  ) async {
    await show(tester, size: const Size(1440, 900));
    final title = tester.getCenter(find.text('This shared link is incomplete'));
    expect(title.dy, inInclusiveRange(300, 600));
    expect(title.dx, closeTo(720, 1));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a phone gets one download, the store bar\'s', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    await show(tester);
    expect(find.byType(WebDownloadButton), findsNothing);
    await tester.pumpWidget(const SizedBox());
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    await show(tester);
    expect(find.byType(WebDownloadButton), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    debugDefaultTargetPlatformOverride = null;
  });

  test('Open Harness goes to the root of the link\'s own site', () {
    expect(
      SharedAgentLocation.workspaceOf(
        Uri.parse('https://harness.example/s/$id?env=stag#key=$key'),
      ),
      Uri.parse('https://harness.example/'),
    );
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'shared access remains readable ${brightness.name} at $scale text',
        (tester) async {
          status = 401;
          await show(
            tester,
            pinnedKey: key,
            brightness: brightness,
            size: const Size(390, 360),
            scale: scale,
          );
          await tester.pumpAndSettle();
          expect(find.text('This shared harness is private'), findsOneWidget);
          final signIn = find.widgetWithText(FilledButton, 'Sign in');
          await tester.ensureVisible(signIn);
          await tester.pumpAndSettle();
          expect(signIn.hitTestable(), findsOneWidget);
          expect(find.byType(SharedHarnessPanel), findsNothing);
          expect(tester.takeException(), isNull);
          await capture(tester, 'private-access-${brightness.name}-$scale');
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }

  testWidgets(
    'counts what a shared link showed once each, and never the link',
    (tester) async {
      final bodies = <String>[];
      final usage = HubUsage(
        enabled: () => true,
        post: (body, _) => bodies.add(body),
      );
      app.status = AppStatus.unauthenticated;
      await show(tester, pinnedKey: key, environment: 'prod', usage: usage);
      await tester.pump(const Duration(seconds: 10));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(find.widgetWithText(FilledButton, 'Check now'));
      await tester.pump(const Duration(milliseconds: 50));
      usage.flush();
      expect(requests.length, greaterThanOrEqualTo(3));
      expect(jsonDecode(bodies.single)['counters'], {
        'hub_view_shared_visitor': 1,
        'hub_shared_open_offline': 1,
        'hub_shared_retry': 1,
      });
      expect(bodies.single, isNot(contains(id)));
      expect(bodies.single, isNot(contains(key)));
      await tester.pumpWidget(const SizedBox());
      usage.flush();
      bodies.clear();
      // A staging link is the team's own.
      await show(tester, pinnedKey: key, usage: usage);
      usage.flush();
      expect(bodies, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
