import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/swarm/swarm_row.dart';

/// A row of a Swarm card draws with the design system's roles and spacing, not
/// numbers of its own: the title is the control role, the line under it the
/// caption, and the row keeps a thumb's height.
void main() {
  Future<void> show(WidgetTester tester, Widget child) => tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(body: Center(child: child)),
    ),
  );

  /// The style the row's title is drawn in.
  TextStyle titleStyle(WidgetTester tester) {
    final title = tester.widget<RichText>(
      find.byWidgetPredicate(
        (w) => w is RichText && w.text.toPlainText().contains('Fix login'),
      ),
    );
    return (title.text as TextSpan).style!;
  }

  testWidgets('the title is the control role: 17 points, medium', (
    tester,
  ) async {
    await show(tester, SwarmRow(title: 'Fix login', onTap: () {}));

    final style = titleStyle(tester);
    expect(style.fontSize, AppType.bodySize);
    expect(style.fontWeight, FontWeight.w500);
    expect(style.height, 1.3);
  });

  testWidgets('the line under the title is the caption role', (tester) async {
    await show(
      tester,
      SwarmRow(
        title: 'Fix login',
        detail: SwarmRow.line('Nova is working'),
        onTap: () {},
      ),
    );

    final style = tester.widget<Text>(find.text('Nova is working')).style!;
    expect(style.fontSize, AppType.captionSize);
    expect(style.height, 1.35);
  });

  testWidgets('the row is padded 16 across and 12 down, on the spacing scale', (
    tester,
  ) async {
    await show(tester, SwarmRow(title: 'Fix login', onTap: () {}));

    final padding = tester.widget<Padding>(
      find.byWidgetPredicate((w) => w is Padding && w.child is Row),
    );
    expect(
      padding.padding,
      const EdgeInsets.symmetric(horizontal: AppSpace.l, vertical: AppSpace.m),
    );
  });

  testWidgets("a row never draws under a thumb's 56 points", (tester) async {
    await show(tester, SwarmRow(title: 'Fix login', onTap: () {}));

    expect(
      tester.getSize(find.byType(SwarmRow)).height,
      greaterThanOrEqualTo(SwarmRow.height),
    );
  });
}
