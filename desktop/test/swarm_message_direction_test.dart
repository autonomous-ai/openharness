import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/code_block.dart';
import 'package:harness/super_tabs/message_text.dart';

/// A message reads in the direction of its own words (Unicode's first strong letter), whatever the app's: Arabic or Hebrew
/// from the right, an English line from the left, a tag or a task number before the words never deciding it.
void main() {
  Future<TextDirection> drawn(
    WidgetTester tester,
    String text, {
    TextDirection app = TextDirection.ltr,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) =>
            Directionality(textDirection: app, child: child!),
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SizedBox(
            width: 400,
            child: SuperTabMessageText(text, agents: const ['Pip']),
          ),
        ),
      ),
    );
    // The direction its words are laid out in, its own or the one around it: the last paragraph, after any code or tag.
    return tester
        .renderObject<RenderParagraph>(
          find
              .descendant(
                of: find.byType(SuperTabMessageText),
                matching: find.byType(RichText),
              )
              .last,
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
    // Code, a link or a bold tag before the words do not decide it.
    ('```dart\nfoo();\n```\nهذا هو الإصلاح', TextDirection.rtl),
    ('`npm test` يفشل الآن', TextDirection.rtl),
    ('**@Pip** ابدأ الآن', TextDirection.rtl),
    // A byte order mark or an Arabic digit is no letter.
    ('\uFEFFAll tests pass', TextDirection.ltr),
    ('٣ tests failed in CI', TextDirection.ltr),
    // An Arabic hashtag is a word.
    ('#مراجعة Please review the diff', TextDirection.rtl),
  ]) {
    testWidgets('"$text" reads ${direction.name}', (tester) async {
      expect(await drawn(tester, text), direction);
    });
  }

  testWidgets(
    'in an app laid out right to left, an English message still reads left to right',
    (tester) async {
      expect(
        await drawn(tester, 'All tests pass.', app: TextDirection.rtl),
        TextDirection.rtl,
        reason: 'no right-to-left letter: the app\'s own direction holds',
      );
      expect(
        await drawn(tester, 'Read المهمة now.', app: TextDirection.rtl),
        TextDirection.ltr,
      );
    },
  );

  testWidgets('a code block in an Arabic message reads left to right', (
    tester,
  ) async {
    await drawn(tester, 'سأشغّل الأمر:\n\n```bash\nnpm test -- --watch;\n```');
    final code = tester.renderObject<RenderParagraph>(
      find
          .descendant(
            of: find.byType(SuperTabCodeBlock),
            matching: find.byType(RichText),
          )
          .first,
    );
    expect(code.textDirection, TextDirection.ltr);
  });
}
