import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/shared/widgets/pulse.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

/// What the phone draws while a list has not answered — the agents list, the
/// folder picker, a terminal still attaching — and what it draws when the
/// answer is "nothing".
void main() {
  Widget app(Widget child, {bool reduceMotion = false}) => MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reduceMotion),
      child: Scaffold(body: child),
    ),
  );

  group('Pulse', () {
    testWidgets('breathes up and back while it is on screen', (tester) async {
      final seen = <double>[];
      await tester.pumpWidget(
        app(
          Pulse(
            duration: const Duration(milliseconds: 100),
            builder: (context, t, _) {
              seen.add(t);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 50));
      expect(seen.first, 0);
      expect(seen, contains(1.0), reason: 'reaches its peak');
      expect(seen.last, lessThan(1), reason: 'and comes back down');
    });

    testWidgets('Reduce Motion holds it at the peak, not half-faded', (
      tester,
    ) async {
      final seen = <double>[];
      await tester.pumpWidget(
        app(
          reduceMotion: true,
          Pulse(
            builder: (context, t, _) {
              seen.add(t);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      await tester.pump(const Duration(seconds: 1));
      expect(seen.toSet(), {1.0});
      expect(tester.hasRunningAnimations, isFalse);

      // Turned back on, it breathes again.
      await tester.pumpWidget(
        app(
          Pulse(
            builder: (context, t, _) {
              seen.add(t);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      expect(tester.hasRunningAnimations, isTrue);
    });

    testWidgets('a new tempo takes over without stopping the beat', (
      tester,
    ) async {
      Widget pulse(int ms) => app(
        Pulse(
          duration: Duration(milliseconds: ms),
          builder: (context, t, child) => child!,
          child: const Text('kept'),
        ),
      );
      await tester.pumpWidget(pulse(400));
      await tester.pumpWidget(pulse(800));
      expect(tester.hasRunningAnimations, isTrue);
      expect(find.text('kept'), findsOneWidget);
    });
  });

  group('Skeleton', () {
    testWidgets('fills between the recess and its hover, on its own radius', (
      tester,
    ) async {
      await tester.pumpWidget(
        app(const Skeleton(width: 120, height: 64, radius: 12)),
      );
      final box = tester.widget<Container>(find.byType(Container));
      final decoration = box.decoration! as BoxDecoration;
      expect(decoration.color, AppSurface.recess);
      expect(decoration.borderRadius, BorderRadius.circular(12));
      expect(tester.getSize(find.byType(Container)), const Size(120, 64));
    });

    testWidgets('a round one takes no corner radius', (tester) async {
      await tester.pumpWidget(
        app(const Skeleton(width: 18, height: 18, shape: BoxShape.circle)),
      );
      final decoration =
          tester.widget<Container>(find.byType(Container)).decoration!
              as BoxDecoration;
      expect(decoration.shape, BoxShape.circle);
      expect(decoration.borderRadius, isNull);
    });
  });

  group('SkeletonText', () {
    testWidgets('reserves exactly the line the real text will take', (
      tester,
    ) async {
      const style = TextStyle(fontSize: 14, height: 1.4);
      await tester.pumpWidget(
        app(
          const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 200,
                child: SkeletonText(style: style, widthFactor: 0.5),
              ),
              Text('Real row', style: style),
            ],
          ),
        ),
      );
      final placeholder = tester.getSize(find.byType(SkeletonText));
      final real = tester.getSize(find.text('Real row'));
      expect(placeholder.height, real.height);
      // The bar is the x-height of the line, and half the row wide.
      final bar = tester.getSize(find.byType(Skeleton));
      expect(bar.height, (14 * 0.72).roundToDouble());
      expect(bar.width, 100);
    });

    testWidgets('a fixed width, and a thin line, still read as a line', (
      tester,
    ) async {
      await tester.pumpWidget(
        app(
          const Align(
            alignment: Alignment.topLeft,
            child: SkeletonText(style: TextStyle(fontSize: 4), width: 60),
          ),
        ),
      );
      final bar = tester.getSize(find.byType(Skeleton));
      expect(bar.width, 60);
      expect(bar.height, 6, reason: 'never thinner than a readable bar');
    });
  });

  group('SkeletonList', () {
    testWidgets('fades toward its foot, says "loading" once, and takes no '
        'touches', (tester) async {
      final handle = tester.ensureSemantics();
      var tapped = 0;
      await tester.pumpWidget(
        app(
          SkeletonList(
            rows: 4,
            semanticsLabel: 'Loading folders',
            itemBuilder: (context, i) => GestureDetector(
              onTap: () => tapped++,
              child: const SizedBox(height: 30, child: Skeleton.text()),
            ),
          ),
        ),
      );
      final opacities = tester
          .widgetList<Opacity>(find.byType(Opacity))
          .map((o) => o.opacity)
          .toList();
      expect(opacities, hasLength(4));
      expect(opacities.first, 1);
      for (var i = 1; i < opacities.length; i++) {
        expect(opacities[i], lessThan(opacities[i - 1]));
      }
      expect(find.bySemanticsLabel('Loading folders'), findsOneWidget);

      await tester.tap(find.byType(SkeletonList), warnIfMissed: false);
      expect(tapped, 0, reason: 'a placeholder is not content');
      handle.dispose();
    });

    test('an empty list is not faded at all', () {
      expect(skeletonFade(0, 0), 1);
      expect(skeletonFade(3, 3, depth: 0.3), closeTo(0.7, 1e-9));
    });
  });

  group('EmptyState', () {
    testWidgets('nothing yet: the title, one line, and the way out', (
      tester,
    ) async {
      await tester.pumpWidget(
        app(
          EmptyState(
            icon: Icons.computer,
            title: 'No computers yet',
            message: 'Link one to see its agents here.',
            action: FilledButton(onPressed: () {}, child: const Text('Link')),
          ),
        ),
      );
      expect(find.text('No computers yet'), findsOneWidget);
      expect(find.text('Link one to see its agents here.'), findsOneWidget);
      expect(find.text('Link'), findsOneWidget);
      expect(tester.widget<Icon>(find.byType(Icon)).size, 32);
    });

    testWidgets('nothing matched: compact, and no action to take', (
      tester,
    ) async {
      await tester.pumpWidget(app(const EmptyState.noMatches()));
      expect(find.text('No matches'), findsOneWidget);
      expect(find.byIcon(Icons.search_off_rounded), findsOneWidget);
      expect(tester.widget<Icon>(find.byType(Icon)).size, 24);
      expect(find.byType(FilledButton), findsNothing);
    });
  });
}
