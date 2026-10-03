import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/companions/memory_review_text.dart';

void main() {
  testWidgets(
    'offscreen lesson text is not acknowledged; scrolling through every line is',
    (tester) async {
      final scroll = ScrollController();
      final viewport = GlobalKey();
      var read = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              height: 150,
              child: SingleChildScrollView(
                key: viewport,
                controller: scroll,
                child: Column(
                  children: [
                    const SizedBox(height: 200),
                    MemoryReviewText(
                      text: List.generate(
                        15,
                        (i) => 'Lesson line $i',
                      ).join('\n'),
                      style: const TextStyle(fontSize: 16, height: 1.5),
                      viewport: viewport,
                      scroll: scroll,
                      onRead: () => read++,
                    ),
                    const SizedBox(height: 200),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(read, 0);
      for (var offset = 100.0; offset <= 500; offset += 50) {
        scroll.jumpTo(offset);
        await tester.pump();
      }
      expect(read, 1);
      scroll.jumpTo(0);
      await tester.pump();
      expect(read, 1);
      await tester.pumpWidget(const SizedBox());
      scroll.dispose();
    },
  );

  testWidgets('a tall wrapped paragraph requires every part to be shown', (
    tester,
  ) async {
    final scroll = ScrollController();
    final viewport = GlobalKey();
    var read = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 180,
              height: 150,
              child: SingleChildScrollView(
                key: viewport,
                controller: scroll,
                child: MemoryReviewText(
                  text: List.filled(40, 'A lesson in larger type.').join(' '),
                  style: const TextStyle(fontSize: 26, height: 1.5),
                  viewport: viewport,
                  scroll: scroll,
                  onRead: () => read++,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(read, 0);
    scroll.jumpTo(scroll.position.maxScrollExtent);
    await tester.pump();
    expect(
      read,
      0,
      reason: 'Jumping to the end leaves unread text in the middle.',
    );
    for (
      var offset = 0.0;
      offset < scroll.position.maxScrollExtent;
      offset += 100
    ) {
      scroll.jumpTo(offset);
      await tester.pump();
    }
    expect(read, 1);
    await tester.pumpWidget(const SizedBox());
    scroll.dispose();
  });
}
