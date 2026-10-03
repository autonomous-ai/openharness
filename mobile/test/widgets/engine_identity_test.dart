import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/theme/app_theme.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

/// An asset bundle with nothing in it: what an engine logo that failed to
/// load looks like to [Image.asset].
class _EmptyBundle extends CachingAssetBundle {
  @override
  Future<ByteData> load(String key) async =>
      throw FlutterError('no asset $key');
}

/// The engine's name and mark, wherever an agent is listed on the phone — its
/// card, the model sheet, the usage page, the New agent picker.
void main() {
  group('engineIdentity', () {
    test('a known engine is itself, however its id was spelled', () {
      final codex = engineIdentity('  Codex ');
      expect(codex.id, 'codex');
      expect(codex.label, 'Codex');
      expect(codex.asset, 'assets/engine-icons/codex.png');
      // A daemon's display name does not rename an engine this app knows.
      expect(
        engineIdentity('claude', displayName: 'claude-code').label,
        'Claude',
      );
    });

    test('an engine this build has never heard of is named by the daemon, '
        'then by its id, then as an agent', () {
      final named = engineIdentity('gemini', displayName: ' gemini CLI ');
      expect(named.id, 'gemini');
      expect(named.label, 'Gemini CLI');
      expect(named.asset, isNull);
      expect(named.color, AppColors.mutedStrong);

      expect(engineIdentity('gemini', displayName: '   ').label, 'Gemini');
      final nothing = engineIdentity(null);
      expect(nothing.id, 'unknown');
      expect(nothing.label, 'Agent');
      expect(engineIdentity('').label, 'Agent');
    });

    test('the New agent picker offers every engine, each with a mark', () {
      final ids = allEngines.map((engine) => engine.id).toList();
      expect(ids.first, 'claude');
      expect(ids.toSet(), hasLength(ids.length), reason: 'no engine twice');
      for (final engine in allEngines) {
        // Claude alone is drawn rather than loaded.
        expect(
          engine.asset != null || engine.id == 'claude',
          isTrue,
          reason: engine.id,
        );
        expect(engine.label, isNotEmpty);
      }
    });
  });

  group('EngineMark', () {
    Future<void> pump(WidgetTester tester, Widget mark, {AssetBundle? bundle}) {
      Widget child = Center(child: mark);
      if (bundle != null) {
        child = DefaultAssetBundle(bundle: bundle, child: child);
      }
      return tester.pumpWidget(MaterialApp(home: child));
    }

    testWidgets('an engine with a logo draws the logo', (tester) async {
      await pump(tester, const EngineMark(engine: 'codex', size: 18));
      final image = tester.widget<Image>(
        find.byKey(const ValueKey('engine-icon-codex')),
      );
      expect(image.width, 18);
      expect(image.height, 18);
    });

    testWidgets('Claude is painted, not loaded', (tester) async {
      await pump(tester, const EngineMark(engine: 'claude', size: 32));
      final paint = tester.widget<CustomPaint>(
        find.byKey(const ValueKey('engine-icon-claude')),
      );
      expect(paint.size, const Size.square(32));
      final painter = paint.painter!;
      // Same colour, same drawing: nothing to repaint for.
      expect(painter.shouldRepaint(painter), isFalse);
    });

    testWidgets('an engine with no logo is its initial, unscaled', (
      tester,
    ) async {
      await pump(
        tester,
        const MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(1.4)),
          child: EngineMark(engine: 'gemini', size: 17),
        ),
      );
      expect(
        find.byKey(const ValueKey('engine-fallback-gemini')),
        findsOneWidget,
      );
      final initial = tester.widget<Text>(find.text('G'));
      // Sized from its fixed box: the app's UI scale would clip the letter
      // out of its own 17px square.
      expect(initial.textScaler, TextScaler.noScaling);
      expect(initial.style!.fontSize, closeTo(17 * 0.68, 0.001));
      expect(initial.style!.fontFamilyFallback, AppFonts.monoFallback);
    });

    testWidgets('a logo that fails to load falls back to the initial', (
      tester,
    ) async {
      await pump(
        tester,
        const EngineMark(engine: 'amp', size: 18),
        bundle: _EmptyBundle(),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('engine-fallback-amp')), findsOneWidget);
      expect(find.text('A'), findsOneWidget);
    });

    testWidgets('a disabled mark is dimmed', (tester) async {
      await pump(tester, const EngineMark(engine: 'pi', enabled: false));
      expect(tester.widget<Opacity>(find.byType(Opacity)).opacity, 0.45);
      await pump(tester, const EngineMark(engine: 'pi'));
      expect(tester.widget<Opacity>(find.byType(Opacity)).opacity, 1);
    });
  });
}
