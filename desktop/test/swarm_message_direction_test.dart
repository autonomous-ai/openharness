import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/message_text.dart';

/// A message reads in the direction of its own words (Unicode's first strong letter), whatever the app's: Arabic or Hebrew
/// from the right, an English line from the left, a tag or a task number before the words never deciding it.
void main() {
  Future<TextDirection> drawn(WidgetTester tester, String text) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SizedBox(
            width: 400,
            child: SuperTabMessageText(text, agents: const ['Pip']),
          ),
        ),
      ),
    );
    // The direction its text is laid out in, its own or the one around it.
    return tester
        .renderObject<RenderParagraph>(
          find
              .descendant(
                of: find.byType(SuperTabMessageText),
                matching: find.byType(RichText),
              )
              .first,
        )
        .textDirection;
  }

  for (final (text, direction) in const [
    ('مرحبا! أنا بيب. سأبدأ بقراءة المهمة الآن.', TextDirection.rtl),
    ('שלום! אני פיפ. אני קורא את המשימה עכשיו.', TextDirection.rtl),
    ('@Pip ابدأ بالمهمة #12 الآن', TextDirection.rtl),
    ('#12 ثم الذاكرة', TextDirection.rtl),
    ('Read #12 (المهمة) before 18:00.', TextDirection.ltr),
    ('12:30 Taking #12.', TextDirection.ltr),
    ('你好，我是 Pip。', TextDirection.ltr),
    ('👍', TextDirection.ltr),
  ]) {
    testWidgets('"$text" reads ${direction.name}', (tester) async {
      expect(await drawn(tester, text), direction);
    });
  }
}
