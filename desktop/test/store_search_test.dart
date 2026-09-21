// The Store's toolbar, laid out as a Mac draws it.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/store/store_search.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);

  // Widget tests run as Android unless told otherwise, and Android's standard
  // density hid this: a desktop's compact density took 8px off the collapsed
  // field and the hint sat 4px under the middle of the outline on a Mac.
  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    testWidgets(
      'the hint sits on the middle of the field on ${platform.name}',
      (tester) async {
        debugDefaultTargetPlatformOverride = platform;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1200, 200);
        addTearDown(tester.view.reset);
        final controller = TextEditingController();
        final focus = FocusNode();
        addTearDown(controller.dispose);
        addTearDown(focus.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: Column(
                children: [
                  StoreSearch(
                    controller: controller,
                    focusNode: focus,
                    onChanged: (_) {},
                    autofocus: false,
                    onClear: () {},
                    onBack: null,
                    onForward: null,
                  ),
                ],
              ),
            ),
          ),
        );
        final field = tester.getRect(
          find.byKey(const ValueKey('store-search-field')),
        );
        final hint = tester.getRect(find.text('Search harnesses'));
        expect(hint.center.dy, moreOrLessEquals(field.center.dy, epsilon: 0.5));
        expect(find.text('Create Harness'), findsOneWidget);
        debugDefaultTargetPlatformOverride = null;
      },
    );
  }
}
