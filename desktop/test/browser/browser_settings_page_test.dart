import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/browser/browser_settings.dart';
import 'package:harness/browser/browser_settings_page.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';

/// The agent's machine, as Browser settings asks it: what it keeps, every save and every proxy test.
class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  Map<String, dynamic> stored = {
    'proxy': {
      'scheme': 'socks5',
      'host': 'proxy.example',
      'port': 1080,
      'username': 'ken',
      'passwordSet': true,
    },
    'timeZone': null,
    'languages': 'vi-VN, en-US',
    'screen': '1920x1080',
    'humanInput': true,
    'humanSpeed': 'normal',
    'device': null,
  };
  final saves = <Map<String, Object?>>[];
  final tests = <Map<String, Object?>>[];
  ProxyTestResult answer = const ProxyTestResult(
    ok: true,
    address: '203.0.113.7',
    timeZone: 'Asia/Ho_Chi_Minh',
  );

  @override
  Future<BrowserSettings> agentBrowserSettings(
    String machineId,
    String agentId,
  ) async => BrowserSettings.fromJson(stored);

  @override
  Future<BrowserSettings> agentBrowserSettingsSave(
    String machineId,
    String agentId,
    Map<String, Object?> settings,
  ) async {
    saves.add(settings);
    final proxy = settings['proxy'] as Map?;
    stored = {
      ...settings,
      'proxy': proxy == null
          ? null
          : {
              for (final MapEntry(:key, :value) in proxy.entries)
                if (key != 'password') key: value,
              'passwordSet': true,
            },
    };
    return BrowserSettings.fromJson(stored);
  }

  @override
  Future<ProxyTestResult> agentBrowserProxyTest(
    String machineId,
    String agentId,
    Map<String, Object?> proxy,
  ) async {
    tests.add(proxy);
    return answer;
  }
}

Finder _key(String name) => find.byKey(ValueKey('browser-settings-$name'));

void main() {
  late _App app;
  late int backs;

  Future<void> open(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(480, 900);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BrowserSettingsPage(
            app: app,
            machineId: 'm',
            agentId: 'a1',
            onBack: () => backs++,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> type(WidgetTester tester, String field, String text) async {
    await tester.enterText(_key(field), text);
    await tester.pump();
  }

  bool enabled(WidgetTester tester, String button) =>
      tester.widget<ButtonStyleButton>(_key(button)).onPressed != null;

  Future<void> tap(WidgetTester tester, String button) async {
    await tester.tap(_key(button));
    await tester.pumpAndSettle();
  }

  setUp(() {
    app = _App();
    backs = 0;
  });
  tearDown(() => app.dispose());

  testWidgets('back returns to the screen', (tester) async {
    await open(tester);
    expect(find.text('Browser settings'), findsOneWidget);
    await tap(tester, 'back');
    expect(backs, 1);
  });

  testWidgets('the page loads the saved settings; a saved password shows as '
      'dots and is never in the widget tree as text', (tester) async {
    await open(tester);
    String text(String field) => tester
        .widget<EditableText>(
          find.descendant(of: _key(field), matching: find.byType(EditableText)),
        )
        .controller
        .text;
    expect(text('host'), 'proxy.example');
    expect(text('port'), '1080');
    expect(text('username'), 'ken');
    expect(text('languages'), 'vi-VN, en-US');
    expect(text('zone'), isEmpty, reason: 'Auto');
    expect(find.text('SOCKS5'), findsOneWidget);
    expect(find.text('1920 × 1080'), findsOneWidget);
    final password = tester.widget<EditableText>(
      find.descendant(
        of: _key('password'),
        matching: find.byType(EditableText),
      ),
    );
    expect(password.obscureText, isTrue);
    expect(password.controller.text, isEmpty);
    expect(find.text('••••••••'), findsOneWidget);
  });

  testWidgets('Save waits for a change, then sends the settings, and no '
      'password when it was not edited', (tester) async {
    await open(tester);
    expect(enabled(tester, 'save'), isFalse);
    await type(tester, 'languages', 'en-US');
    expect(enabled(tester, 'save'), isTrue);
    await tap(tester, 'save');
    expect(app.saves.single, {
      'proxy': {
        'scheme': 'socks5',
        'host': 'proxy.example',
        'port': 1080,
        'username': 'ken',
      },
      'timeZone': null,
      'languages': 'en-US',
      'screen': '1920x1080',
      'humanInput': true,
      'humanSpeed': 'normal',
      'device': null,
    });
    expect(enabled(tester, 'save'), isFalse, reason: 'saved');

    await type(tester, 'password', 'hunter2');
    await tap(tester, 'save');
    expect((app.saves.last['proxy'] as Map)['password'], 'hunter2');
    expect(find.text('hunter2'), findsNothing);
  });

  testWidgets('Test shows "Proxy works · 203.0.113.7 · Asia/Ho_Chi_Minh" or '
      '"Proxy is not reachable"', (tester) async {
    await open(tester);
    await tap(tester, 'test');
    expect(app.tests.single, {
      'scheme': 'socks5',
      'host': 'proxy.example',
      'port': 1080,
      'username': 'ken',
    });
    expect(
      find.text('Proxy works · 203.0.113.7 · Asia/Ho_Chi_Minh'),
      findsOneWidget,
    );
    app.answer = const ProxyTestResult(ok: false);
    await type(tester, 'host', 'other.example');
    expect(find.textContaining('Proxy works'), findsNothing);
    await tap(tester, 'test');
    expect((app.tests.last)['host'], 'other.example');
    expect(find.text('Proxy is not reachable'), findsOneWidget);
  });

  testWidgets('Remove clears the proxy after Save', (tester) async {
    await open(tester);
    await tap(tester, 'remove');
    expect(app.saves, isEmpty, reason: 'only Save saves');
    await tap(tester, 'save');
    expect(app.saves.single['proxy'], isNull);
    expect(enabled(tester, 'remove'), isFalse);
  });

  testWidgets('Screen offers exactly the five sizes', (tester) async {
    await open(tester);
    await tester.tap(_key('screen'));
    await tester.pumpAndSettle();
    for (final size in [
      '1680 × 1050',
      '1536 × 864',
      '1440 × 900',
      '1366 × 768',
    ]) {
      expect(find.text(size), findsOneWidget, reason: size);
    }
    // The chosen one, in the field and in the menu.
    expect(find.text('1920 × 1080'), findsNWidgets(2));
    await tester.tap(find.text('1366 × 768'));
    await tester.pumpAndSettle();
    await tap(tester, 'save');
    expect(app.saves.single['screen'], '1366x768');
  });

  testWidgets('Human input off disables the speed choice', (tester) async {
    await open(tester);
    await tester.tap(_key('speed'));
    await tester.pumpAndSettle();
    expect(find.text('Fast'), findsOneWidget);
    await tester.tap(find.text('Fast'));
    await tester.pumpAndSettle();
    await tester.tap(_key('human'));
    await tester.pumpAndSettle();
    await tester.tap(_key('speed'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(find.text('Slow'), findsNothing, reason: 'no menu opens');
    await tap(tester, 'save');
    expect(app.saves.single['humanInput'], isFalse);
    expect(app.saves.single['humanSpeed'], 'fast');
  });

  testWidgets('Device is under Advanced and off by default', (tester) async {
    await open(tester);
    expect(_key('device'), findsNothing);
    await tap(tester, 'advanced');
    expect(
      find.descendant(of: _key('device'), matching: find.text('Off')),
      findsOneWidget,
    );
    await tester.tap(_key('device'));
    await tester.pumpAndSettle();
    // On, it asks what to report, and saves only once it has all four.
    expect(enabled(tester, 'save'), isFalse);
    await type(tester, 'gpu-vendor', 'Apple');
    await type(tester, 'gpu-renderer', 'Apple M3');
    await type(tester, 'cpu-cores', '8');
    await type(tester, 'memory', '16');
    await tap(tester, 'save');
    expect(app.saves.single['device'], {
      'gpuVendor': 'Apple',
      'gpuRenderer': 'Apple M3',
      'cpuCores': 8,
      'memoryGb': 16,
    });
  });

  testWidgets('an invalid port disables Save', (tester) async {
    await open(tester);
    for (final port in ['0', '65536', 'abc', '']) {
      await type(tester, 'port', port);
      expect(enabled(tester, 'save'), isFalse, reason: port);
      expect(enabled(tester, 'test'), isFalse, reason: port);
    }
    await type(tester, 'port', '8080');
    expect(enabled(tester, 'save'), isTrue);
  });
}
