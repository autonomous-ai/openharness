import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/relative_time.dart';

void main() {
  final now = DateTime(2026, 10, 1, 12);
  String ago(Duration d) => relativeAgo(now.subtract(d), now);

  test('relativeAgo follows the boundaries the CLI and mobile use', () {
    expect(ago(Duration.zero), 'just now');
    expect(ago(const Duration(seconds: 59)), 'just now');
    expect(ago(const Duration(minutes: 1)), '1 minute ago');
    expect(ago(const Duration(minutes: 59)), '59 minutes ago');
    expect(ago(const Duration(hours: 1)), '1 hour ago');
    expect(ago(const Duration(hours: 23)), '23 hours ago');
    expect(ago(const Duration(hours: 24)), 'yesterday');
    expect(ago(const Duration(hours: 47)), 'yesterday');
    expect(ago(const Duration(days: 2)), '2 days ago');
    expect(ago(const Duration(days: 13)), '13 days ago');
    expect(ago(const Duration(days: 14)), '2 weeks ago');
    expect(ago(const Duration(days: 59)), '8 weeks ago');
    expect(ago(const Duration(days: 60)), '2 months ago');
    expect(ago(const Duration(days: 364)), '12 months ago');
    expect(ago(const Duration(days: 365)), 'over a year ago');
    expect(relativeAgo(now.add(const Duration(minutes: 5)), now), 'just now');
  });

  test('fullDateTime spells the local date and 24-hour time', () {
    expect(fullDateTime(DateTime(2026, 10, 1, 14, 5)), '1 Oct 2026, 14:05');
  });

  test('activityPhrase says active now, last active, or added', () {
    final added = now.subtract(const Duration(days: 30));
    expect(
      activityPhrase(
        lastSeen: now.subtract(const Duration(minutes: 1)),
        addedAt: added,
        now: now,
      ),
      'active now',
    );
    expect(
      activityPhrase(
        lastSeen: now.subtract(const Duration(days: 2)),
        addedAt: added,
        now: now,
      ),
      'last active 2 days ago',
    );
    expect(
      activityPhrase(addedAt: now.subtract(const Duration(days: 21)), now: now),
      'added 3 weeks ago',
    );
  });
}
