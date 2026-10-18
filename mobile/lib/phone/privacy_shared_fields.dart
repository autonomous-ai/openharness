import 'package:flutter/material.dart';

/// One labelled line of what product usage sharing sends or keeps.
typedef _Field = ({String label, String text});

const List<_Field> _sent = [
  (
    label: 'Each report',
    text:
        'UTC day, a random retry receipt, protocol and preference revisions; '
        'the app version and whether it runs on iOS or Android.',
  ),
  (
    label: 'Activity',
    text:
        'Active/working computer counts, first/repeat work, desktop/terminal opens, '
        'first/repeat feature use and monthly returns.',
  ),
  (
    label: 'Days you used Harness',
    text:
        'Which apps you used, whether an agent worked and your sign-up day, under a coded ID '
        'instead of your account, kept 10 days, then only as combined totals.',
  ),
  (
    label: 'Turns',
    text:
        'Started/ended/interrupted (including automation), and duration buckets '
        '(under 10 seconds, 10–60 seconds, 1–5 minutes, over 5 minutes).',
  ),
  (
    label: 'Reliability',
    text:
        'Request outcomes and fixed failure categories for launch/resume/restart/model changes/history, '
        'response wait buckets, missing responses and error-event counts, '
        'first-launch 24-hour response counts and D1/D7/D28 working-day returns.',
  ),
  (
    label: 'Setup and connections',
    text:
        'Fixed setup, sign-in (and which button: scan, Google, Apple or email), '
        'connection, viewer and update-stage outcomes.',
  ),
  (
    label: 'Phone setup steps',
    text:
        'Waiting for a computer, opening its session, sending a first message, '
        'answering the notification prompt: outcomes and duration buckets; '
        'whether a sign-in that went through came after a failed try or on another button.',
  ),
  (
    label: 'This phone',
    text:
        'How often Find and Computers are opened, by a swipe or a button; '
        'request outcomes counted as this phone\'s rather than any app\'s.',
  ),
  (label: 'Feedback', text: 'Only your selected task outcome or reason.'),
  (
    label: 'Older apps',
    text:
        'Connection, remote-session and turn-start totals, counted separately.',
  ),
];

const List<_Field> _kept = [
  (
    label: 'Identity',
    text:
        'Sign-in checks your preference. Account, computer and agent identifiers '
        'are not stored with the combined totals.',
  ),
  (
    label: 'Daily records',
    text: 'Use a coded ID instead of your account and are deleted when you turn sharing off.',
  ),
  (
    label: 'Expiry',
    text:
        'Queued local counters older than 35 days are discarded when Harness next runs. '
        'Server retry receipts are scheduled to expire after 36 days; combined totals after 13 months. '
        'Background cleanup may lag. Previously collected activity records expire after 35 days.',
  ),
  (
    label: 'Limits',
    text:
        'Combined totals cannot be removed for one person. '
        'A turn ending does not establish task success.',
  ),
];

/// "See what's shared": what a report carries, then how long it is kept, as short labelled lines.
class PrivacySharedFields extends StatelessWidget {
  const PrivacySharedFields({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Heading('What is shared', theme: theme),
            for (final field in _sent) _FieldLine(field, theme: theme),
            const SizedBox(height: 8),
            _Heading('How it is kept', theme: theme),
            for (final field in _kept) _FieldLine(field, theme: theme),
          ],
        ),
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text, {required this.theme});
  final String text;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(
      text.toUpperCase(),
      style: theme.textTheme.labelMedium?.copyWith(
        color: theme.colorScheme.primary,
        fontWeight: FontWeight.w700,
        letterSpacing: .6,
      ),
    ),
  );
}

class _FieldLine extends StatelessWidget {
  const _FieldLine(this.field, {required this.theme});
  final _Field field;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '${field.label}\n',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          TextSpan(
            text: field.text,
            style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
      style: theme.textTheme.bodyMedium,
    ),
  );
}
