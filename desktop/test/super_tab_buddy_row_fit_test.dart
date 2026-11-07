// Task #4251 (Mac test of #3481): at the left pane's 180 minimum, a row's name stays whole and its quiet note gives
// way, never "Bu… no…".
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddy_rows.dart';

void main() {
  Future<void> row(WidgetTester t, {required String note}) => t.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 180,
            child: SuperTabBuddyRow(
              agentId: null,
              name: 'Buddy',
              note: note,
              tooltip: 'Your Buddy',
              onTap: () {},
            ),
          ),
        ),
      ),
    ),
  );

  bool cut(WidgetTester t, String text) =>
      t.renderObject<RenderParagraph>(find.text(text)).didExceedMaxLines;

  testWidgets('the name stays whole and the note gives way at 180', (
    t,
  ) async {
    await row(t, note: 'not started');
    expect(cut(t, 'Buddy'), isFalse);
    expect(t.takeException(), isNull);
  });

  testWidgets('a long note is cut, the name is not', (t) async {
    await row(t, note: 'not started on any of your computers yet');
    expect(cut(t, 'Buddy'), isFalse);
    expect(cut(t, 'not started on any of your computers yet'), isTrue);
    expect(t.takeException(), isNull);
  });
}
