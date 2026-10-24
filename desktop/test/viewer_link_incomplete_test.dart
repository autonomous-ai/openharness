// A viewer link without its machine or agent (`/?viewer=1`): a page that says
// what to do, with a way back to the workspace. Audit finding S13.
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/viewer/viewer_link_incomplete.dart';
import 'package:harness/viewer/viewer_location.dart';

void main() {
  // As the app shell puts it: a screen of its own, with no Scaffold above it.
  Future<List<Uri>> mount(WidgetTester tester) async {
    final opened = <Uri>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: ViewerLinkIncomplete(
          location: Uri.parse('https://harness.example/?viewer=1&machine=m1'),
          open: (uri) async => opened.add(uri),
        ),
      ),
    );
    return opened;
  }

  testWidgets('says what to run, with hn view as code', (tester) async {
    await mount(tester);
    expect(find.text('This viewer link is incomplete'), findsOneWidget);
    final message = tester.renderObject<RenderParagraph>(
      find.byKey(const Key('viewer-link-incomplete-message')),
    );
    expect(message.text.toPlainText(), 'Run hn view again for a new link.');
    final spans = <TextSpan>[];
    message.text.visitChildren((span) {
      if (span is TextSpan && span.text != null) spans.add(span);
      return true;
    });
    final code = spans.singleWhere((span) => span.text == 'hn view');
    final prose = spans.firstWhere((span) => span.text!.startsWith('Run'));
    expect(code.style?.fontFamily, isNot(prose.style?.fontFamily));
    // Drawn on a Material: no error-styled text (yellow double underline).
    for (final paragraph in tester.renderObjectList<RenderParagraph>(
      find.byType(RichText),
    )) {
      expect(
        paragraph.text.style?.decoration,
        isNot(TextDecoration.underline),
      );
    }
  });

  testWidgets('Open Harness goes to the workspace this link came from', (
    tester,
  ) async {
    final opened = await mount(tester);
    // A thumb's target on a phone.
    expect(
      tester.getSize(find.widgetWithText(FilledButton, 'Open Harness')).height,
      greaterThanOrEqualTo(44),
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Open Harness'));
    await tester.pump();
    expect(opened, [Uri.parse('https://harness.example/')]);
  });

  test('the workspace of a viewer link drops its query and fragment', () {
    expect(
      ViewerLocation.workspaceOf(
        Uri.parse('https://harness.example/?viewer=1&machine=m1#x'),
      ),
      Uri.parse('https://harness.example/'),
    );
    expect(
      ViewerLocation.workspaceOf(Uri.parse('http://localhost:8080/?viewer=1')),
      Uri.parse('http://localhost:8080/'),
    );
  });
}
