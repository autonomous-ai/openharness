import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// The top-left corner radius the open bottom sheet is drawn with.
double sheetTopRadius(WidgetTester tester) {
  final material = tester.widget<Material>(
    find
        .descendant(
          of: find.byType(BottomSheet),
          matching: find.byType(Material),
        )
        .first,
  );
  final shape = material.shape! as RoundedRectangleBorder;
  return shape.borderRadius.resolve(TextDirection.ltr).topLeft.x;
}
