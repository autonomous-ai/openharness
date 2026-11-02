import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/update/web_update_bar.dart';
import 'package:harness/web/update/web_update_watcher.dart';

/// The quiet bar a page shows once the host serves a newer release (task
/// #2185, Huy's mockup): "A new version of Harness is ready." and Reload.
void main() {
  late String? latest;
  late WebUpdateWatcher watcher;
  var reloads = 0;

  Future<void> mount(WidgetTester tester, {Widget? child}) async {
    reloads = 0;
    latest = '1.3.51';
    watcher = WebUpdateWatcher(
      running: '1.3.51',
      readLatest: () async => latest,
    );
    addTearDown(watcher.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: WebUpdateFrame(
            watcher: watcher,
            reload: () => reloads++,
            child: child ?? const Text('the app'),
          ),
        ),
      ),
    );
  }

  Finder bar() => find.byKey(const ValueKey('web-update-bar'));

  testWidgets('the same build shows nothing', (tester) async {
    await mount(tester);
    await watcher.check();
    await tester.pump();
    expect(bar(), findsNothing);
    expect(find.text('the app'), findsOneWidget);
  });

  testWidgets('a newer build shows the bar, and Reload reloads once', (
    tester,
  ) async {
    await mount(tester);
    latest = '1.3.52';
    await watcher.check();
    await tester.pump();
    expect(bar(), findsOneWidget);
    expect(find.text('A new version of Harness is ready.'), findsOneWidget);
    expect(reloads, 0);
    await tester.tap(find.byKey(const ValueKey('web-update-reload')));
    await tester.pump();
    expect(reloads, 1);
  });

  testWidgets('the bar coming does not remount the app below it', (
    tester,
  ) async {
    await mount(tester, child: const _Counter());
    await tester.tap(find.byKey(const ValueKey('counter')));
    await tester.pump();
    expect(find.text('taps 1'), findsOneWidget);
    latest = '1.3.52';
    await watcher.check();
    await tester.pump();
    expect(bar(), findsOneWidget);
    expect(find.text('taps 1'), findsOneWidget);
  });

  testWidgets('the bar sits above the app, reads in the page\'s own '
      'surface and offers Reload to a thumb', (tester) async {
    final handle = tester.ensureSemantics();
    await mount(tester);
    latest = '1.3.52';
    await watcher.check();
    await tester.pump();
    expect(
      tester.getTopLeft(bar()).dy,
      lessThan(tester.getTopLeft(find.text('the app')).dy),
    );
    final reload = tester.getSize(
      find.byKey(const ValueKey('web-update-reload')),
    );
    expect(reload.height, greaterThanOrEqualTo(40));
    final semantics = tester.getSemantics(
      find.byKey(const ValueKey('web-update-reload')),
    );
    expect(semantics.label, 'Reload');
    handle.dispose();
  });
}

class _Counter extends StatefulWidget {
  const _Counter();
  @override
  State<_Counter> createState() => _CounterState();
}

class _CounterState extends State<_Counter> {
  var taps = 0;
  @override
  Widget build(BuildContext context) => TextButton(
    key: const ValueKey('counter'),
    onPressed: () => setState(() => taps++),
    child: Text('taps $taps'),
  );
}
