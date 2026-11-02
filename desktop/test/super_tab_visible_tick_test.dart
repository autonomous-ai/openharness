import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/visible_tick.dart';

// Task #2195: nothing redraws on a timer while it's off screen.

class _Panel extends StatefulWidget {
  const _Panel({required this.builds, required this.changes});
  final List<int> builds;
  final List<bool> changes;
  @override
  State<_Panel> createState() => _PanelState();
}

class _PanelState extends State<_Panel> with WidgetsBindingObserver, VisibleTick<_Panel> {
  @override
  void initState() {
    super.initState();
    visibleTick(const Duration(seconds: 1));
  }

  @override
  void onScreenChanged(bool onScreen) => widget.changes.add(onScreen);

  @override
  Widget build(BuildContext context) {
    widget.builds.add(1);
    return const SizedBox();
  }
}

Widget _frame(_Panel panel, {required bool on}) => Directionality(
  textDirection: TextDirection.ltr,
  child: TickerMode(enabled: on, child: panel),
);

void main() {
  testWidgets('ticks while on screen', (tester) async {
    final builds = <int>[], panel = _Panel(builds: builds, changes: []);
    await tester.pumpWidget(_frame(panel, on: true));
    builds.clear();
    await tester.pump(const Duration(seconds: 3));
    expect(builds, isNotEmpty);
  });

  testWidgets('does not tick or rebuild off screen, and redraws at once on coming back', (tester) async {
    final builds = <int>[], changes = <bool>[], panel = _Panel(builds: builds, changes: changes);
    await tester.pumpWidget(_frame(panel, on: false));
    builds.clear();
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(seconds: 5));
    expect(builds, isEmpty);
    await tester.pumpWidget(_frame(panel, on: true));
    expect(builds, isNotEmpty);
    expect(changes.last, isTrue);
    builds.clear();
    await tester.pump(const Duration(seconds: 2));
    expect(builds, isNotEmpty);
  });

  testWidgets('stops when its tab leaves the screen', (tester) async {
    final builds = <int>[], changes = <bool>[], panel = _Panel(builds: builds, changes: changes);
    await tester.pumpWidget(_frame(panel, on: true));
    await tester.pumpWidget(_frame(panel, on: false));
    expect(changes.last, isFalse);
    builds.clear();
    await tester.pump(const Duration(seconds: 5));
    expect(builds, isEmpty);
  });

  testWidgets('stops while the app is hidden, and redraws when it returns', (tester) async {
    final builds = <int>[], changes = <bool>[], panel = _Panel(builds: builds, changes: changes);
    await tester.pumpWidget(_frame(panel, on: true));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    expect(changes.last, isFalse);
    builds.clear();
    await tester.pump(const Duration(seconds: 5));
    expect(builds, isEmpty);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(changes.last, isTrue);
    expect(builds, isNotEmpty);
  });

  testWidgets('leaves no timer behind when it goes', (tester) async {
    await tester.pumpWidget(_frame(_Panel(builds: [], changes: []), on: true));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 2));
  });
}
