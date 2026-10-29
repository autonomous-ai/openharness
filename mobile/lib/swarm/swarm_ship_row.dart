import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/swarm_tokens_set_b.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_message_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// [message] is the project chat's ship line (backend superTabs/ship.ts
/// `SHIP_KIND`): linked work just became Done.
bool swarmShips(SuperTabMessage message) => message.source['kind'] == 'ship';

/// A GitHub pull request's address, and nothing else a ship line might carry
/// (the desktop's `superTabPullRequestLinks`).
final _pullRequest = RegExp(
  r'^https://github\.com/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)$',
);

/// What a ship line says: what shipped, and who asked, built and reviewed
/// it, as ids the Swarm names; its pull requests, at most four.
class SwarmShip {
  SwarmShip.of(SuperTabMessage message)
    : title = message.source['title'] is String
          ? message.source['title'] as String
          : '',
      requesterId = message.source['requesterId'] is String
          ? message.source['requesterId'] as String
          : null,
      builderIds = _ids(message.source['builderIds']),
      reviewerIds = _ids(message.source['reviewerIds']),
      pullRequests = List.unmodifiable(
        _ids(message.source['pullRequests'])
            .where(_pullRequest.hasMatch)
            .map(Uri.parse)
            .take(4),
      );

  final String title;
  final String? requesterId;
  final List<String> builderIds, reviewerIds;
  final List<Uri> pullRequests;

  static List<String> _ids(Object? value) => List.unmodifiable([
    for (final id in value is List ? value : const [])
      ?id is String ? id : null,
  ]);
}

/// The avatars beside a ship's credits; their label's cell is as tall.
const _creditAvatar = 22.0;

/// How recent a ship still is: an older one in the history is still.
const swarmShipFresh = Duration(minutes: 2);

/// Whether [message] throws confetti as it first appears at [now]: only
/// while it is fresh, and only once per ship — [played] remembers which have
/// (the desktop's `SuperTabShipRow`).
bool swarmShipCelebrates(
  SuperTabMessage message,
  DateTime now,
  Set<String> played,
) {
  final at = message.createdAt;
  if (at == null || now.difference(at) > swarmShipFresh) return false;
  return played.add(message.id);
}

/// The project chat's line when linked work is Done, as a card in place of
/// a message (the desktop's `SuperTabShipRow`, laid out as the approved
/// mockup draws it): 🎉 and what shipped; who asked, built and reviewed it,
/// one to a line; then its pull requests. A fresh one throws confetti, once
/// per ship on this phone ([swarmShipCelebrates]).
///
/// Its people are named from the Swarm the chat belongs to; until that is
/// read, the title and links show alone.
class SwarmShipRow extends StatefulWidget {
  const SwarmShipRow({
    super.key,
    required this.message,
    this.now = DateTime.now,
  });

  final SuperTabMessage message;
  final DateTime Function() now;

  static final _played = <String>{};
  @visibleForTesting
  static void resetPlayed() => _played.clear();

  @override
  State<SwarmShipRow> createState() => _SwarmShipRowState();
}

class _SwarmShipRowState extends State<SwarmShipRow> {
  // Decided once, as the line first appears: a rebuild never cuts it short,
  // and the same line drawn again later throws none.
  late final bool _throws = swarmShipCelebrates(
    widget.message,
    widget.now(),
    SwarmShipRow._played,
  );
  late final SwarmShip _ship = SwarmShip.of(widget.message);

  /// The account's Swarms, read: the one whose chat this is names the people.
  SwarmSession? _session;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.inbox.removeListener(_changed);
    _session = session?..inbox.addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _session?.inbox.removeListener(_changed);
    super.dispose();
  }

  /// The Swarm read that holds this chat; null until one does.
  SuperTabSnapshot? get _snapshot {
    final inbox = _session?.inbox;
    if (inbox == null) return null;
    for (final swarm in inbox.swarms) {
      final snapshot = inbox.reader(swarm.id)?.snapshot;
      if (snapshot?.conversation(widget.message.conversationId) != null) {
        return snapshot;
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ship = _ship, snapshot = _snapshot, id = widget.message.id;
    final requester = snapshot?.people
        .where((p) => p.id == ship.requesterId)
        .firstOrNull;
    List<(String, String)> agents(List<String> ids) => [
      for (final id in ids)
        if (snapshot?.agent(id) != null) (id, snapshot!.agentName(id)),
    ];
    final credits = [
      if (requester != null)
        ('Requested by', [(requester.id, superTabPersonName(requester.email))]),
      ('Built by', agents(ship.builderIds)),
      ('Reviewed by', agents(ship.reviewerIds)),
    ].where((credit) => credit.$2.isNotEmpty).toList();
    final accent = AppPalette.accentOnSurface;
    final card = Container(
      key: ValueKey('swarm-ship-$id'),
      margin: const EdgeInsets.all(AppSpace.s),
      padding: const EdgeInsets.fromLTRB(
        AppSpace.l,
        AppSpace.m,
        AppSpace.l,
        AppSpace.l,
      ),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: .10),
        borderRadius: BorderRadius.circular(AppCard.radius),
        border: Border.all(color: accent.withValues(alpha: .4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const ExcludeSemantics(
                child: Text(
                  '🎉',
                  style: TextStyle(
                    fontSize: AppIconSize.besideText,
                    height: 1.2,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Shipped: ${ship.title}',
                  style: swarmChatText(
                    16,
                    weight: FontWeight.w600,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
          if (credits.isNotEmpty) const SizedBox(height: 10),
          for (final (label, people) in credits)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpace.xs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // As tall as an avatar and centred in it, so a label sits level
                  // with the first name beside it at any text size.
                  ConstrainedBox(
                    constraints: const BoxConstraints(
                      minWidth: 104,
                      maxWidth: 104,
                      minHeight: _creditAvatar,
                    ),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        label,
                        style: swarmChatText(
                          14,
                          color: AppPalette.textSecondary,
                        ),
                      ),
                    ),
                  ),
                  Expanded(
                    child: Wrap(
                      spacing: 12,
                      runSpacing: 6,
                      children: [
                        for (final (personId, name) in people)
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              SwarmAvatar(
                                id: personId,
                                name: name,
                                size: _creditAvatar,
                              ),
                              const SizedBox(width: 6),
                              Text(name, style: swarmChatText(15)),
                            ],
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          if (ship.pullRequests.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (i, link) in ship.pullRequests.indexed)
                  _PullRequestButton(
                    key: ValueKey('swarm-ship-pr-$id-$i'),
                    link: link,
                  ),
              ],
            ),
          ],
        ],
      ),
    );
    if (!_throws) return card;
    return _Confetti(seed: id.hashCode, child: card);
  }
}

/// A pull request the ship links, as a button: its repository and number,
/// opened in the in-app browser.
class _PullRequestButton extends StatelessWidget {
  const _PullRequestButton({super.key, required this.link});

  final Uri link;

  @override
  Widget build(BuildContext context) {
    final label = '${link.pathSegments[1]} · PR #${link.pathSegments[3]}';
    return Semantics(
      button: true,
      link: true,
      label: 'Open $label',
      excludeSemantics: true,
      child: Material(
        color: AppPalette.windowBg,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppControl.radius),
          side: BorderSide(color: AppGlass.hair),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () {
            HapticFeedback.selectionClick();
            unawaited(launchUrl(link, mode: LaunchMode.inAppBrowserView));
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    LucideIcons.gitPullRequest300,
                    size: 16,
                    color: AppPalette.textSecondary,
                  ),
                  const SizedBox(width: 8),
                  Text(label, style: swarmChatText(14.5)),
                  const SizedBox(width: 6),
                  Icon(
                    LucideIcons.externalLink300,
                    size: 14,
                    color: AppPalette.textFaint,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A short burst of confetti over its child, once, then gone; with Reduce
/// Motion on, the child alone (the desktop's `SuperTabConfetti`).
class _Confetti extends StatefulWidget {
  const _Confetti({required this.seed, required this.child});

  final int seed;
  final Widget child;

  @override
  State<_Confetti> createState() => _ConfettiState();
}

class _ConfettiState extends State<_Confetti>
    with SingleTickerProviderStateMixin {
  late final _motion = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2200),
  );
  late final _pieces = _Piece.burst(widget.seed);
  bool _done = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_done || _motion.isAnimating) return;
    if (MediaQuery.disableAnimationsOf(context)) {
      _done = true;
      return;
    }
    _motion.forward().whenComplete(() {
      if (mounted) setState(() => _done = true);
    });
  }

  @override
  void dispose() {
    _motion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Stack(
    clipBehavior: Clip.none,
    children: [
      widget.child,
      if (!_done)
        Positioned.fill(
          child: IgnorePointer(
            child: ExcludeSemantics(
              child: CustomPaint(
                key: const ValueKey('swarm-ship-confetti'),
                painter: _ConfettiPainter(_pieces, _motion),
              ),
            ),
          ),
        ),
    ],
  );
}

class _Piece {
  const _Piece(this.x, this.drift, this.lift, this.spin, this.size, this.color);
  final double x, drift, lift, spin, size;
  final Color color;

  static List<_Piece> burst(int seed) {
    final random = Random(seed);
    return [
      for (var i = 0; i < 40; i++)
        _Piece(
          random.nextDouble(),
          (random.nextDouble() - .5) * .3,
          .4 + random.nextDouble() * .6,
          (random.nextDouble() - .5) * 12,
          4 + random.nextDouble() * 4,
          SwarmConfetti.colors[i % SwarmConfetti.colors.length],
        ),
    ];
  }
}

class _ConfettiPainter extends CustomPainter {
  _ConfettiPainter(this.pieces, this.motion) : super(repaint: motion);
  final List<_Piece> pieces;
  final Animation<double> motion;

  @override
  void paint(Canvas canvas, Size size) {
    final t = motion.value;
    final paint = Paint();
    for (final piece in pieces) {
      // Thrown up from the card, then falling past it as it fades.
      final y = size.height * (1 - piece.lift * 4 * t * (1 - t) * 2 + t * .6);
      final x = size.width * (piece.x + piece.drift * t);
      paint.color = piece.color.withValues(alpha: (1 - t).clamp(0, 1));
      canvas
        ..save()
        ..translate(x, y)
        ..rotate(piece.spin * t)
        ..drawRect(
          Rect.fromCenter(
            center: Offset.zero,
            width: piece.size,
            height: piece.size * .5,
          ),
          paint,
        )
        ..restore();
    }
  }

  @override
  bool shouldRepaint(_ConfettiPainter old) => false;
}
