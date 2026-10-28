import 'package:flutter/material.dart';

import 'model.dart';

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
    for (final id in value is List ? value : const []) ?id is String ? id : null,
  ]);
}

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

class SwarmShipRow extends StatelessWidget {
  const SwarmShipRow({super.key, required this.message});
  final SuperTabMessage message;
  static void resetPlayed() {}
  @override
  Widget build(BuildContext context) => const SizedBox();
}
