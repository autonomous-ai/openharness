import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../widgets/desktop_chrome.dart';
import 'identity.dart';
import 'leaderboard/format.dart';
import 'model.dart';

// Start each day and end each week together (v2 J): the stand-up card the
// backend posts with each morning digest, and on Mondays the shipped-together
// recap (backend superTabs/morning.ts). People and agents come as ids, named
// from the members this reader already has.

const _months = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', //
  'August', 'September', 'October', 'November', 'December',
];
const _weekdays = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', //
  'Sunday',
];
const _medals = {'gold': '🏆', 'silver': '🥈', 'bronze': '🥉'};
const _statuses = {
  'planned': 'planned',
  'working': 'working',
  'review': 'ready for review',
  'reconciling': 'being reconciled',
  'blocked': 'stuck',
  'lost': 'lost',
};

/// Whether [message] carries a stand-up or recap card.
bool superTabMorningCard(SuperTabMessage message) =>
    (message.source['kind'] == 'standup' ||
        message.source['kind'] == 'recap') &&
    message.source['card'] is Map;

String _names(List<String> names) => names.length < 2
    ? names.join()
    : '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';

class SuperTabMorningCard extends StatelessWidget {
  const SuperTabMorningCard({
    super.key,
    required this.message,
    required this.personName,
    required this.agentName,
    this.onDismiss,
  });

  final SuperTabMessage message;
  final String Function(String personId) personName;
  final String Function(String agentId) agentName;

  /// Set where the card is pinned at the top of the chat.
  final VoidCallback? onDismiss;

  Map<String, dynamic> get _card => superTabMap(message.source['card']);
  List<Map<String, dynamic>> _items(String key) => [
    for (final item in _card[key] as List? ?? const []) superTabMap(item),
  ];

  @override
  Widget build(BuildContext context) {
    final recap = _card['kind'] == 'recap';
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 8),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: DesktopChrome.surface,
          border: Border.all(color: DesktopChrome.rim),
          borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    recap ? AppIcons.trophy : AppIcons.sun,
                    size: 18,
                    color: DesktopChrome.accent,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      recap ? _recapTitle() : _standupTitle(),
                      style: DesktopChrome.heading(),
                    ),
                  ),
                  if (onDismiss != null)
                    IconButton(
                      key: const ValueKey('super-card-dismiss'),
                      tooltip: 'Dismiss',
                      iconSize: 16,
                      visualDensity: VisualDensity.compact,
                      onPressed: onDismiss,
                      icon: Icon(AppIcons.close, color: DesktopChrome.muted),
                    ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: recap ? _recap() : _standup(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _standupTitle() {
    final day = DateTime.tryParse(_card['on'] as String? ?? '');
    return day == null
        ? 'Stand-up'
        : 'Stand-up · ${_weekdays[day.weekday - 1]} ${day.day} '
              '${_months[day.month - 1]}';
  }

  String _recapTitle() {
    final week = DateTime.fromMillisecondsSinceEpoch(
      (_card['week'] as num? ?? 0).toInt(),
      isUtc: true,
    );
    return 'Shipped together · week of ${week.day} ${_months[week.month - 1]}';
  }

  List<Widget> _standup() {
    final shipped = _items('shipped'), moving = _items('inProgress');
    final blocked = _items('blocked'), waiting = _items('waiting');
    if ([shipped, moving, blocked, waiting].every((l) => l.isEmpty)) {
      return [
        const SizedBox(height: 8),
        Text(
          'A quiet night: nothing shipped, moving or blocked.',
          style: DesktopChrome.text(color: DesktopChrome.muted),
        ),
      ];
    }
    return [
      ..._part('Shipped', [for (final s in shipped) _shipped(s)]),
      ..._part('In progress', [for (final s in moving) _open(s)]),
      ..._part('Blocked', [for (final s in blocked) _open(s)]),
      ..._part('Waiting on people', [
        for (final s in waiting)
          _line(
            s,
            '${agentName(s['agentId'] as String)} waits for '
            '${personName(s['personId'] as String)}'
            '${s['note'] == null ? '' : ': ${s['note']}'}',
            person: s['personId'] as String,
          ),
      ]),
    ];
  }

  List<Widget> _recap() {
    final shipped = _items('shipped'), top = _items('top');
    final ask = superTabMap(_card['askToShipMs'] ?? const {});
    final thanks = superTabMap(_card['thanks'] ?? const {});
    final last = ask['lastWeek'] as num?, before = ask['weekBefore'] as num?;
    final names = [
      for (final id in thanks['personIds'] as List? ?? const [])
        personName(id as String),
      for (final id in thanks['agentIds'] as List? ?? const [])
        agentName(id as String),
    ];
    return [
      ..._part(plural(shipped.length, 'shipped', 'shipped'), [
        for (final s in shipped) _shipped(s),
      ]),
      if (last != null)
        _fact(
          'Ask to shipped: ${leaderboardDuration(last.toInt())}'
          '${before == null ? '' : ', from ${leaderboardDuration(before.toInt())} the week before'}',
        ),
      for (final t in top)
        _fact(
          '${_medals[t['medal']] ?? ''} ${personName(t['personId'] as String)}'
          ' · ${plural((t['points'] as num).toInt(), 'point')}',
        ),
      if (names.isNotEmpty) _fact('Thank you, ${_names(names)}!'),
    ];
  }

  List<Widget> _part(String title, List<Widget> rows) => rows.isEmpty
      ? const []
      : [
          Padding(
            padding: const EdgeInsets.only(top: 10, bottom: 2),
            child: Text(title, style: DesktopChrome.control(medium: true)),
          ),
          ...rows,
        ];

  Widget _shipped(Map<String, dynamic> s) {
    final asked = s['askedBy'] as String?;
    final reviewers = [
      for (final id in s['reviewedBy'] as List? ?? const [])
        agentName(id as String),
    ];
    return _line(
      s,
      [
        if (asked != null) 'asked by ${personName(asked)}',
        'built by ${agentName(s['builtBy'] as String)}',
        if (reviewers.isNotEmpty) 'reviewed by ${_names(reviewers)}',
      ].join(' · '),
      person: asked,
    );
  }

  Widget _open(Map<String, dynamic> s) => _line(
    s,
    '${agentName(s['agentId'] as String)} · '
    '${_statuses[s['status']] ?? s['status']}'
    '${s['note'] == null ? '' : ': ${s['note']}'}',
  );

  /// One item: its number and title, then who and what, led by the person's
  /// avatar when one is named (initials until the shared avatar lands).
  Widget _line(Map<String, dynamic> s, String detail, {String? person}) =>
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 26,
              child: person == null
                  ? null
                  : Align(
                      alignment: Alignment.topLeft,
                      child: SuperTabAvatar(
                        identity: 'person:$person',
                        name: personName(person),
                        size: 18,
                      ),
                    ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '#${s['number']} ${s['title']}',
                    style: DesktopChrome.text(),
                  ),
                  Text(detail, style: DesktopChrome.metadata()),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _fact(String text) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(text, style: DesktopChrome.text()),
  );
}
