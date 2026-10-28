import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';
import 'confetti.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';
import 'pull_requests.dart';

/// The project chat's line when linked work is Done (backend superTabs/ship.ts):
/// what shipped, and who asked, built and reviewed it. A fresh one throws
/// confetti, once per message on this computer.
class SuperTabShipRow extends StatefulWidget {
  const SuperTabShipRow({
    super.key,
    required this.message,
    required this.controller,
    this.now = DateTime.now,
  });
  final SuperTabMessage message;
  final SuperTabController controller;
  final DateTime Function() now;

  /// How recent a celebration still is: an older one in the history is still.
  static const fresh = Duration(minutes: 2);
  static final _played = <String>{};
  @visibleForTesting
  static void resetPlayed() => _played.clear();

  static bool shows(SuperTabMessage message) =>
      message.source['kind'] == 'ship';

  @override
  State<SuperTabShipRow> createState() => _SuperTabShipRowState();
}

class _SuperTabShipRowState extends State<SuperTabShipRow> {
  // Decided once, when the line first appears: a rebuild never cuts it short,
  // and the same line drawn again later throws none.
  late final bool _throws = () {
    final at = widget.message.createdAt;
    if (at == null || widget.now().difference(at) > SuperTabShipRow.fresh) {
      return false;
    }
    return SuperTabShipRow._played.add(widget.message.id);
  }();

  SuperTabMessage get message => widget.message;

  List<String> _ids(String key) => [
    for (final id in message.source[key] as List? ?? const [])
      if (id is String) id,
  ];

  @override
  Widget build(BuildContext context) {
    final snapshot = widget.controller.snapshot;
    final title = message.source['title'] as String? ?? '';
    final requester = snapshot?.people
        .where((p) => p.id == message.source['requesterId'])
        .firstOrNull;
    Widget agents(String label, List<String> ids) => _Credit(label, [
      for (final id in ids)
        if (snapshot?.agent(id) case final agent?)
          (SuperTabAvatar.agent(agent, size: 20), snapshot!.agentName(id)),
    ]);
    final line = Container(
      margin: const EdgeInsets.fromLTRB(24, 12, 24, 0),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: DesktopChrome.selection,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        border: Border.all(color: DesktopChrome.accent.withValues(alpha: .4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const ExcludeSemantics(
                child: Text('🎉', style: TextStyle(fontSize: 20)),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Shipped: $title',
                  style: DesktopChrome.control(medium: true),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 16,
            runSpacing: 6,
            children: [
              if (requester != null)
                _Credit('Requested by', [
                  (
                    SuperTabAvatar.person(requester, size: 20),
                    superTabPersonName(requester.email),
                  ),
                ]),
              agents('Built by', _ids('builderIds')),
              agents('Reviewed by', _ids('reviewerIds')),
            ],
          ),
          SuperTabPullRequestLinks(_ids('pullRequests').join(' ')),
        ],
      ),
    );
    if (!_throws) return line;
    return SuperTabConfetti(seed: message.id.hashCode, child: line);
  }
}

class _Credit extends StatelessWidget {
  const _Credit(this.label, this.people);
  final String label;
  final List<(Widget, String)> people;

  @override
  Widget build(BuildContext context) {
    if (people.isEmpty) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: DesktopChrome.metadata()),
        for (final (avatar, name) in people) ...[
          const SizedBox(width: 6),
          avatar,
          const SizedBox(width: 4),
          Text(name, style: DesktopChrome.control()),
        ],
      ],
    );
  }
}
