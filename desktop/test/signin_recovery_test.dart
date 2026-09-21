import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';

class _Attempt {
  _Attempt(this.authorize);
  final void Function(String) authorize;
  final done = Completer<void>();
}

class _Cli extends CliLogin {
  final attempts = <_Attempt>[];
  var cancellations = 0;
  var statusChecks = 0;
  @override
  Future<void> login({required void Function(String) onAuthorizeUrl}) {
    final attempt = _Attempt(onAuthorizeUrl);
    attempts.add(attempt);
    return attempt.done.future;
  }

  @override
  Future<CliAuthStatus> checkStatus() async {
    statusChecks++;
    throw StateError('A stale fixture login must not bootstrap');
  }

  @override
  void cancel() => cancellations++;
}

class _App extends AppNotifier {
  _App(_Cli cli)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: cli,
      ) {
    status = AppStatus.unauthenticated;
  }
  var daemonChecks = 0;
  Completer<void>? daemon;
  @override
  Future<void> ensureCliDaemonReady() async {
    daemonChecks++;
    if (daemon == null) throw StateError('Unexpected fixture bootstrap');
    await daemon!.future;
  }
}

_App _app(_Cli cli) => _App(cli);

const _browser = MethodChannel('plugins.flutter.io/url_launcher');
const _platform = SystemChannels.platform;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final hasUrl in [false, true]) {
    testWidgets(
      'Escape cancels sign-in ${hasUrl ? 'after' : 'before'} the browser link and restores Enter',
      (tester) async {
        final cli = _Cli();
        final app = _app(cli);
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          _browser,
          (_) async => true,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            _browser,
            null,
          ),
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: ListenableBuilder(
              listenable: app,
              builder: (_, _) => LoginScreen(notifier: app),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 100));
        expect(cli.attempts, hasLength(1));
        if (hasUrl) {
          cli.attempts.single.authorize('https://auth.example/fixture');
          await tester.pump(const Duration(milliseconds: 100));
          expect(find.text('Waiting for your browser'), findsOneWidget);
        }
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump(const Duration(milliseconds: 100));
        expect(app.signingIn, isFalse);
        expect(cli.cancellations, 1);
        expect(app.pendingAuthorizeUrl, isNull);
        expect(app.lastError, isNull);
        expect(find.text('Sign in'), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        expect(cli.cancellations, 1);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 100));
        expect(cli.attempts, hasLength(2));
        cli.attempts.first.done.complete();
        await tester.pump(const Duration(milliseconds: 100));
        expect(app.signingIn, isTrue);
        expect(app.daemonChecks, 0);
        app.cancelLogin();
        cli.attempts.last.done.complete();
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'keyboard sign-in can reopen and copy its link without restarting login',
    (tester) async {
      final cli = _Cli();
      final app = _app(cli);
      final launches = <String>[];
      String? clipboard;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(_browser, (
        call,
      ) async {
        expect(call.method, 'launch');
        final args = call.arguments as Map;
        expect(args['useWebView'], isFalse);
        expect(args['useSafariVC'], isFalse);
        launches.add(args['url'] as String);
        return launches.length > 1;
      });
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        _platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboard = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(() {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          _browser,
          null,
        );
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          _platform,
          null,
        );
      });
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(880, 800);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: ListenableBuilder(
            listenable: app,
            builder: (_, _) => LoginScreen(notifier: app),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 100));
      expect(cli.attempts, hasLength(1));
      expect(find.text('Signing in…'), findsOneWidget);
      expect(find.text('Copy link'), findsNothing);
      const url = 'https://auth.example/authorize?state=fixture';
      cli.attempts.single.authorize(url);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.textContaining('Couldn’t open your browser'), findsOneWidget);
      expect(app.signingIn, isTrue);
      await tester.tap(find.text('Open browser'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(launches, [url, url]);
      expect(cli.attempts, hasLength(1));
      expect(app.loginBrowserError, isNull);
      await tester.tap(find.text('Copy link'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(clipboard, url);
      expect(find.text('Link copied'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.signingIn, isFalse);
      expect(app.status, AppStatus.unauthenticated);
      expect(app.lastError, isNull);
      expect(find.text('Sign in'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 100));
      expect(cli.attempts, hasLength(2));
      // An old result cannot finish the replacement or open a stale browser tab.
      cli.attempts.first.authorize('https://auth.example/stale');
      cli.attempts.first.done.complete();
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.signingIn, isTrue);
      expect(cli.statusChecks, 0);
      expect(app.daemonChecks, 0);
      expect(launches, [url, url]);
      app.cancelLogin();
      cli.attempts.last.done.complete();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      expect(tester.takeException(), isNull);
    },
  );

  test('Cancel before a URL is immediate and ignores a late success', () async {
    final cli = _Cli();
    final app = _app(cli);
    addTearDown(app.dispose);
    final login = app.login();
    app.cancelLogin();
    expect(app.signingIn, isFalse);
    expect(app.status, AppStatus.unauthenticated);
    expect(cli.cancellations, 1);
    cli.attempts.single.authorize('https://auth.example/stale');
    cli.attempts.single.done.complete();
    await login;
    expect(app.pendingAuthorizeUrl, isNull);
    expect(app.lastError, isNull);
    expect(cli.statusChecks, 0);
    expect(app.daemonChecks, 0);
  });

  test(
    'completed browser sign-in clears recovery before restoring the workspace',
    () async {
      final cli = _Cli();
      final app = _app(cli)..daemon = Completer<void>();
      addTearDown(app.dispose);
      final login = app.login();
      cli.attempts.single.done.complete();
      await Future<void>.delayed(Duration.zero);
      expect(app.signingIn, isTrue);
      expect(app.canCancelLogin, isFalse);
      expect(app.pendingAuthorizeUrl, isNull);
      app.cancelLogin();
      expect(app.status, AppStatus.bootstrapping);
      expect(cli.cancellations, 0);
      app.daemon!.completeError(StateError('Fixture service unavailable'));
      await login;
      expect(app.signingIn, isFalse);
    },
  );

  for (final replace in [false, true]) {
    test(
      'late browser failure belongs to its original ${replace ? 'login' : 'URL'}',
      () async {
        final cli = _Cli();
        final app = _app(cli);
        addTearDown(app.dispose);
        final replies = <Completer<bool>>[];
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(_browser, (_) {
              final reply = Completer<bool>();
              replies.add(reply);
              return reply.future;
            });
        addTearDown(
          () => TestDefaultBinaryMessengerBinding
              .instance
              .defaultBinaryMessenger
              .setMockMethodCallHandler(_browser, null),
        );
        final first = app.login();
        cli.attempts.first.authorize('https://auth.example/first');
        await Future<void>.delayed(Duration.zero);
        await app
            .openLoginBrowser(); // A held/repeated action shares this handoff.
        expect(replies, hasLength(1));
        Future<void>? second;
        if (replace) {
          app.cancelLogin();
          second = app.login();
        }
        cli.attempts.last.authorize('https://auth.example/current');
        await Future<void>.delayed(Duration.zero);
        expect(replies, hasLength(2));
        replies.last.complete(true);
        await Future<void>.delayed(Duration.zero);
        replies.first.complete(false);
        await Future<void>.delayed(Duration.zero);
        expect(app.loginBrowserError, isNull);
        expect(app.openingLoginBrowser, isFalse);
        expect(app.pendingAuthorizeUrl, 'https://auth.example/current');
        app.cancelLogin();
        for (final attempt in cli.attempts) {
          attempt.done.complete();
        }
        await first;
        await second;
      },
    );
  }

  test('browser exceptions stay recoverable and disposal cancels the pending login', () async {
    final cli = _Cli();
    final app = _app(cli);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_browser, (_) async {
          throw PlatformException(code: 'browser_unavailable');
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(_browser, null),
    );
    final login = app.login();
    cli.attempts.single.authorize('https://auth.example/current');
    await Future<void>.delayed(Duration.zero);
    expect(app.signingIn, isTrue);
    expect(app.loginBrowserError, contains('Couldn’t open your browser'));
    expect(app.lastError, isNull);
    app.dispose();
    expect(cli.cancellations, 1);
    cli.attempts.single.done.complete();
    await login;
    expect(cli.statusChecks, 0);
  });
}
