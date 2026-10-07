import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/shell/web_store_banner.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _banner = ValueKey('web-store-banner');
const _app = ValueKey('the-app');

void main() {
  Future<List<Uri>> mount(
    WidgetTester tester,
    TargetPlatform platform,
    _MemoryStore store,
  ) async {
    debugDefaultTargetPlatformOverride = platform;
    final opened = <Uri>[];
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => WebStoreFrame(
          storage: store,
          open: (uri) async {
            opened.add(uri);
            return true;
          },
          child: child!,
        ),
        home: const _CountedApp(key: _app),
      ),
    );
    await tester.pump();
    return opened;
  }

  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('a phone has a store page; a computer has none', () {
    expect(webStoreLink(TargetPlatform.iOS)!.host, 'apps.apple.com');
    expect(
      webStoreLink(TargetPlatform.android)!.queryParameters['id'],
      'ai.autonomous.harness.android',
    );
    for (final computer in [
      TargetPlatform.macOS,
      TargetPlatform.linux,
      TargetPlatform.windows,
    ]) {
      expect(webStoreLink(computer), isNull, reason: '$computer');
    }
  });

  for (final platform in [TargetPlatform.iOS, TargetPlatform.android]) {
    testWidgets('$platform: the bar opens its own store and fits a phone', (
      tester,
    ) async {
      final opened = await mount(tester, platform, _MemoryStore());
      expect(find.byKey(_banner), findsOneWidget);
      // The app's icon leads its name: the bar reads as an app to get.
      expect(
        tester
            .getRect(find.byKey(const ValueKey('web-store-banner-icon')))
            .right,
        lessThan(tester.getRect(find.text('Harness')).left),
      );
      // The bar is above the app, never over it.
      expect(
        tester.getRect(find.byKey(_banner)).bottom,
        lessThanOrEqualTo(tester.getRect(find.byKey(_app)).top),
      );
      await tester.tap(find.byKey(const ValueKey('web-store-banner-open')));
      expect(opened, [webStoreLink(platform)]);
      expect(tester.takeException(), isNull);
      debugDefaultTargetPlatformOverride = null;
    });
  }

  testWidgets('closing it is remembered, and never remounts the app', (
    tester,
  ) async {
    final store = _MemoryStore();
    await mount(tester, TargetPlatform.iOS, store);
    final mounted = _CountedApp.mounts;
    await tester.tap(find.byKey(const ValueKey('web-store-banner-close')));
    await tester.pump();
    expect(find.byKey(_banner), findsNothing);
    expect(_CountedApp.mounts, mounted);
    expect(tester.getRect(find.byKey(_app)).top, 0);

    // The next visit reads the answer before it draws a bar.
    await tester.pumpWidget(const SizedBox.shrink());
    await mount(tester, TargetPlatform.iOS, store);
    expect(find.byKey(_banner), findsNothing);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('the on-screen keyboard takes the bar away', (tester) async {
    await mount(tester, TargetPlatform.android, _MemoryStore());
    final mounted = _CountedApp.mounts;
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.pump();
    expect(find.byKey(_banner), findsNothing);
    tester.view.resetViewInsets();
    await tester.pump();
    expect(find.byKey(_banner), findsOneWidget);
    expect(_CountedApp.mounts, mounted);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a computer never sees the bar', (tester) async {
    await mount(tester, TargetPlatform.macOS, _MemoryStore());
    expect(find.byKey(_banner), findsNothing);
    expect(tester.getRect(find.byKey(_app)).top, 0);
    debugDefaultTargetPlatformOverride = null;
  });
}

/// Stands in for the app below the bar, counting how often it is mounted.
class _CountedApp extends StatefulWidget {
  const _CountedApp({super.key});

  static int mounts = 0;

  @override
  State<_CountedApp> createState() => _CountedAppState();
}

class _CountedAppState extends State<_CountedApp> {
  @override
  void initState() {
    super.initState();
    _CountedApp.mounts++;
  }

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
