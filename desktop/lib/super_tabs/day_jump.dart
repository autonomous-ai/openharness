import 'dart:math' as math;

import 'package:flutter/material.dart';

/// The date pill's Jump to choices, as Slack's (Huy 11-04).
enum SuperTabJumpTo {
  yesterday('Yesterday'),
  lastWeek('Last week'),
  lastMonth('Last month'),
  beginning('The very beginning');

  const SuperTabJumpTo(this.label);

  final String label;
}

/// The local midnight [choice] jumps to from [now]: yesterday's, 7 days
/// ago's, or the same day a month ago (the month's last day when it is
/// shorter). Null for the very beginning, which has no time.
DateTime? superTabJumpStart(SuperTabJumpTo choice, DateTime now) {
  final day = DateTime(now.year, now.month, now.day);
  switch (choice) {
    case SuperTabJumpTo.yesterday:
      return DateTime(day.year, day.month, day.day - 1);
    case SuperTabJumpTo.lastWeek:
      return DateTime(day.year, day.month, day.day - 7);
    case SuperTabJumpTo.lastMonth:
      final month = DateTime(day.year, day.month - 1);
      final last = DateUtils.getDaysInMonth(month.year, month.month);
      return DateTime(month.year, month.month, math.min(day.day, last));
    case SuperTabJumpTo.beginning:
      return null;
  }
}
