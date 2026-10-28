// The six Swarm details dialogs share one frame (Ken, 2026-10-28: "polish lai UI nay, xau qua"): a title with a quiet
// close, a hairline under it once the content scrolls, label/value rows in one label column, and actions at the bottom.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_dialog.dart';
import 'package:harness/super_tabs/detail_dialog.dart';

Future<void> _open(WidgetTester tester, WidgetBuilder builder) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => showAppDialog<void>(context: context, builder: builder),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('the hairline under the title shows only once the content has scrolled under it', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 500));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await _open(
      tester,
      (context) => SuperTabDetailDialog(
        title: 'MacbookPro',
        body: Column(
          children: [for (var i = 0; i < 40; i++) SuperTabDetailRow(label: 'Row $i', value: 'Value $i')],
        ),
      ),
    );
    final hairline = find.byKey(const ValueKey('super-detail-hairline'));
    expect(hairline, findsNothing);
    await tester.drag(find.text('Value 3'), const Offset(0, -120));
    await tester.pumpAndSettle();
    expect(hairline, findsOneWidget);
    await tester.drag(find.text('Value 8'), const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(hairline, findsNothing);
  });

  testWidgets('values line up in one column across rows and sections, and the close mark dismisses', (tester) async {
    await _open(
      tester,
      (context) => SuperTabDetailDialog(
        title: 'Project details',
        body: Column(
          children: [
            const SuperTabDetailRow(label: 'Owner', value: 'ken@example.com'),
            SuperTabDetailSection(
              title: 'Details',
              children: const [SuperTabDetailRow(label: 'Product Manager', value: 'River')],
            ),
          ],
        ),
      ),
    );
    expect(tester.getTopLeft(find.text('ken@example.com')).dx, tester.getTopLeft(find.text('River')).dx);
    expect(
      find.descendant(of: find.byType(SuperTabDetailDialog), matching: find.byType(TextButton)),
      findsNothing,
      reason: 'no Close button repeats the close mark',
    );
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.text('Project details'), findsNothing);
  });

  testWidgets('with enlarged text a row stacks its value under its label instead of squeezing it', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2)),
          child: const Scaffold(
            body: SizedBox(width: 400, child: SuperTabDetailRow(label: 'Owner', value: 'ken@example.com')),
          ),
        ),
      ),
    );
    expect(
      tester.getTopLeft(find.text('ken@example.com')).dy,
      greaterThan(tester.getBottomLeft(find.text('Owner')).dy - 1),
    );
  });
}
