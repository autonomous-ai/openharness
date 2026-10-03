import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/sharing/shared_agent_location.dart';
import 'package:harness/sharing/shared_agent_page.dart';
import 'package:harness/sharing/shared_harness_panel.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';

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

  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    requests = [];
    status = 200;
    metadata = {'ownerPublicKey': key, 'online': false};
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
            location: SharedAgentLocation(id, pinnedKey, 'stag'),
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

  testWidgets('incomplete and changed owner identities never open a viewer', (
    tester,
  ) async {
    await show(tester);
    expect(find.textContaining('This link is incomplete'), findsOneWidget);
    expect(requests, isEmpty);
    expect(find.byType(SharedHarnessPanel), findsNothing);
    await tester.pumpWidget(const SizedBox());
    metadata['ownerPublicKey'] = base64Encode(List.filled(32, 2));
    await show(tester, pinnedKey: key);
    expect(
      find.textContaining('The owner identity has changed'),
      findsOneWidget,
    );
    expect(find.byType(SharedHarnessPanel), findsNothing);
    expect(requests.single.headers['x-autonomous-env'], 'stag');
    expect(requests.single.headers.containsKey('Authorization'), isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'private and denied links show access guidance without opening a viewer',
    (tester) async {
      status = 401;
      await show(tester, pinnedKey: key);
      expect(
        find.textContaining('Sign in with an invited email'),
        findsOneWidget,
      );
      expect(find.widgetWithText(TextButton, 'Sign in'), findsOneWidget);
      expect(find.byType(SharedHarnessPanel), findsNothing);
      await tester.pumpWidget(const SizedBox());
      status = 403;
      await show(tester, pinnedKey: key);
      expect(
        find.textContaining('your email has not been invited'),
        findsOneWidget,
      );
      expect(find.byType(SharedHarnessPanel), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'offline links retry automatically and stop retrying when closed',
    (tester) async {
      await show(tester, pinnedKey: key);
      expect(find.textContaining('machine is offline'), findsOneWidget);
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
          expect(
            find.textContaining('Sign in with an invited email'),
            findsOneWidget,
          );
          final signIn = find.widgetWithText(TextButton, 'Sign in');
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
}
