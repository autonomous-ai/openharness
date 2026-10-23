import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/widgets/desktop_chrome.dart';

void main() {
  for (final size in [20.0, 24.0, 30.0]) {
    testWidgets(
      'a $size pixel avatar keeps its initial inside while names scale',
      (tester) async {
        for (final name in ['Atlas', 'Sage', 'Quinn']) {
          Size? initialSize;
          double? nameHeight;
          for (final scale in [1.0, 2.0, 3.0]) {
            await tester.pumpWidget(
              MaterialApp(
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: Center(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SuperTabAvatar(
                          identity: 'agent:$name',
                          name: name,
                          size: size,
                        ),
                        const SizedBox(width: 8),
                        Text(name, style: DesktopChrome.control()),
                      ],
                    ),
                  ),
                ),
              ),
            );
            final avatar = find.byType(SuperTabAvatar);
            final bounds = tester.getRect(avatar);
            final initial = find.descendant(
              of: avatar,
              matching: find.byType(Text),
            );
            final paragraph = tester.renderObject<RenderParagraph>(initial);
            final box = paragraph
                .getBoxesForSelection(
                  const TextSelection(baseOffset: 0, extentOffset: 1),
                )
                .single
                .toRect();
            final glyph = box.shift(paragraph.localToGlobal(Offset.zero));
            expect(bounds.size, Size.square(size));
            // Check the painted glyph's bounds, not only the constrained Text
            // widget: a larger line can otherwise be clipped inside that box.
            for (final corner in [
              glyph.topLeft,
              glyph.topRight,
              glyph.bottomLeft,
              glyph.bottomRight,
            ]) {
              expect(
                (corner - bounds.center).distance,
                lessThanOrEqualTo(size / 2),
                reason: '$name at ${scale}x must fit its fixed identity circle',
              );
            }
            initialSize ??= glyph.size;
            expect(glyph.size, initialSize);

            final fullName = tester.getRect(find.text(name));
            nameHeight ??= fullName.height;
            expect(fullName.height, closeTo(nameHeight * scale, 1));
            expect(fullName.left, greaterThan(bounds.right));
            expect(tester.takeException(), isNull);
          }
        }
      },
    );
  }
}
