import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/day_jump.dart';

void main() {
  group('the time each choice starts at', () {
    final wednesday = DateTime(2026, 11, 4, 15, 30);

    test('Yesterday, Last week and Last month start at their midnight', () {
      expect(
        superTabJumpStart(SuperTabJumpTo.yesterday, wednesday),
        DateTime(2026, 11, 3),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastWeek, wednesday),
        DateTime(2026, 10, 28),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, wednesday),
        DateTime(2026, 10, 4),
      );
    });

    test('The very beginning has no time', () {
      expect(superTabJumpStart(SuperTabJumpTo.beginning, wednesday), isNull);
    });

    test('Last month from a day a shorter month lacks is its last day', () {
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, DateTime(2026, 3, 31, 9)),
        DateTime(2026, 2, 28),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, DateTime(2027, 1, 15, 9)),
        DateTime(2026, 12, 15),
      );
    });
  });
}
