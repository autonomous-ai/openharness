import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/ime_echo_hold.dart';

Future<void> _endInputEvent() => Future<void>.microtask(() {});

void main() {
  late ImeEchoHold hold;
  var expired = 0;

  setUp(() {
    expired = 0;
    hold = ImeEchoHold(onExpired: () => expired++);
  });

  tearDown(() => hold.dispose());

  test('ordinary typing is never held', () {
    expect(hold.insert('hunter2'), isFalse);
    expect(hold.delete(1), isFalse);
    expect(hold.isEmpty, isTrue);
    expect(hold.preview(null, 0), isNull);
  });

  test('holds a commit and draws the next composition after it', () async {
    hold.beginCommit();
    expect(hold.insert('alo '), isTrue);
    await _endInputEvent();

    expect(hold.preview(null, 0), (text: 'alo ', backtrackCells: 0));
    expect(hold.preview('may', 0), (text: 'alo may', backtrackCells: 0));
    // Typing that follows a held commit joins it, in order.
    expect(hold.insert('m'), isTrue);
    expect(hold.text, 'alo m');
  });

  test('a composition reaching back replaces the end of the held text', () {
    hold.beginCommit();
    hold.insert('tu');

    expect(hold.preview('ư', 1), (text: 'tư', backtrackCells: 0));
  });

  test('a composition reaching past the held text covers shown cells', () {
    hold.beginCommit();
    hold.insert('o');

    expect(hold.preview('ươ', 3), (text: 'ươ', backtrackCells: 2));
  });

  test('a commit that deletes shown cells paints over them', () {
    hold.beginCommit();
    hold.delete(1);
    hold.insert('ư');

    expect(hold.preview(null, 0), (text: 'ư', backtrackCells: 1));
  });

  test('lets go of each part as the terminal echoes it', () {
    hold.beginCommit();
    hold.insert('alo mày');

    expect(hold.echoed('› '), isFalse);
    expect(hold.echoed('› alo'), isTrue);
    expect(hold.text, ' mày');
    expect(hold.echoed('› alo mày'), isTrue);
    expect(hold.isEmpty, isTrue);
    expect(expired, 0);
  });

  testWidgets('an unanswered hold expires, and twice turns holding off', (
    tester,
  ) async {
    for (var miss = 0; miss < 2; miss++) {
      hold.beginCommit();
      hold.insert('alo');
      await tester.pump(ImeEchoHold.defaultTimeout);
      expect(hold.isEmpty, isTrue);
    }
    expect(expired, 2);

    hold.beginCommit();
    expect(hold.insert('alo'), isFalse);
  });

  testWidgets('an echo forgives earlier misses', (tester) async {
    hold.beginCommit();
    hold.insert('alo');
    await tester.pump(ImeEchoHold.defaultTimeout);

    hold.beginCommit();
    hold.insert('mày');
    hold.echoed('› mày');
    hold.beginCommit();
    hold.insert('ơi');
    await tester.pump(ImeEchoHold.defaultTimeout);

    hold.beginCommit();
    expect(hold.insert('nhé'), isTrue);
    hold.clear();
  });
}
