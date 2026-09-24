// Where the model picker's furniture sits: the figures and the one button end on the edges the eye
// looks for them at, rather than wherever a flex split happened to leave them.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/model_picker_chrome.dart';

Widget _frame(Widget child, {double width = kModelPickerWidth}) => MaterialApp(
  home: Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(width: width, child: child),
    ),
  ),
);

void main() {
  testWidgets('the quota column ends where the meter under it ends', (
    tester,
  ) async {
    // ⚠️ REGRESSION. The column was Flexible beside an Expanded title, which split the row in half
    // and parked "43% left" in the middle of it, a tick's width and more short of the edge.
    await tester.pumpWidget(
      _frame(
        ModelPickerRow(
          title: 'Anthropic',
          subtitle: 'key ···315df1',
          selected: true,
          onTap: () {},
          trailing: const Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [Text('43% left'), Text('Healthy')],
          ),
          meter: 0.43,
        ),
      ),
    );

    final meter = tester.getRect(find.byType(LinearProgressIndicator));
    expect(tester.getRect(find.text('43% left')).right, meter.right);
    expect(tester.getRect(find.text('Healthy')).right, meter.right);
    expect(find.byIcon(Icons.check), findsNothing);
  });

  testWidgets('the footer button ends on the panel edge, not mid-row', (
    tester,
  ) async {
    // ⚠️ REGRESSION. Expanded summary + Flexible button split the row in half and left the button
    // at the start of its half. Wider than the real panel on purpose: the test font draws every
    // glyph a full em wide, so at the real width both halves are full and ANY split looks right.
    const width = 600.0;
    await tester.pumpWidget(
      _frame(
        width: width,
        ModelPickerFooter(
          summary: '5 models available',
          actionLabel: 'Local models',
          onAction: () {},
        ),
      ),
    );

    final button = tester.getRect(
      find
          .ancestor(
            of: find.text('Local models'),
            matching: find.byType(InkWell),
          )
          .first,
    );
    // The same 12 the search box and the rows' boxes keep from the panel's side.
    expect(button.right, width - 12);
    expect(
      tester.getRect(find.text('5 models available')).left,
      12 + kModelPickerInset,
    );
  });
}
