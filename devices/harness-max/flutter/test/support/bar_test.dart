// Puts a page on a 1480 x 320 test glass with the real faces, for golden screens that read like the mockup.
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/ui/bar_frame.dart';
import 'package:harness_max_bar/ui/tokens.dart';

const _faces = {
  'Inter': ['fonts/Inter-Regular.ttf', 'fonts/Inter-Medium.ttf', 'fonts/Inter-SemiBold.ttf', 'fonts/Inter-Bold.ttf'],
  'ChakraPetch': ['fonts/ChakraPetch-Light.ttf', 'fonts/ChakraPetch-Medium.ttf', 'fonts/ChakraPetch-SemiBold.ttf'],
  'JetBrainsMono': ['fonts/JetBrainsMono-Medium.ttf'],
};
bool _loaded = false;

/// Loads Inter, Chakra Petch and JetBrains Mono (flutter test draws text in Ahem otherwise). Call in setUpAll.
Future<void> loadBarFaces() async {
  if (_loaded) return;
  for (final e in _faces.entries) {
    final loader = FontLoader(e.key);
    for (final f in e.value) {
      loader.addFont(rootBundle.load(f));
    }
    await loader.load();
  }
  _loaded = true;
}

/// Pumps [child] on the bar's glass at 1:1.
Future<void> pumpOnBar(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = kCanvas;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(BarFrame(child: child));
}
