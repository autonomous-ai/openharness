import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Whether a picture on screen is still loading: its load asked for, not yet
/// decoded or failed. The image cache counts a picture as there from the
/// moment its load is asked for, so a test that goes on once the cache has it
/// can delete the file a load has not yet opened ('PathNotFoundException ...
/// resolving an image codec', task #2883).
bool picturesLoading(WidgetTester tester) {
  for (final element in find.byType(Image, skipOffstage: false).evaluate()) {
    final provider = (element.widget as Image).image;
    // File pictures answer with their key at once.
    Object? key;
    provider.obtainKey(ImageConfiguration.empty).then((value) => key = value);
    if (key == null) {
      throw StateError('${provider.runtimeType} has no key to look up at once');
    }
    if (PaintingBinding.instance.imageCache.statusForKey(key!).pending) {
      return true;
    }
  }
  return false;
}

/// Real time (a load reads a file and decodes, outside the test's fake clock),
/// a frame after each step, until no picture on screen is loading.
Future<void> picturesLoaded(WidgetTester tester) async {
  for (var i = 0; i < 100 && picturesLoading(tester); i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
  }
  expect(picturesLoading(tester), isFalse, reason: 'a picture never loaded');
}
