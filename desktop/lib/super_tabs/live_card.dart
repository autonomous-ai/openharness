import 'package:flutter/material.dart';

import '../shared/theme/pull_request_icon.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'live_card_model.dart';
import 'live_card_pull_request.dart';
import 'model.dart';
import 'pull_request_facts.dart';

/// A task's state in a few words, from its assignment's status.
String superTabCardStatus(Map<String, dynamic>? assignment) =>
    switch (assignment?['status']) {
      'planned' => 'Planned',
      'working' => 'Working',
      'needs_human' => 'Waiting on a person',
      'blocked' => 'Blocked',
      'review' => 'Waiting on others',
      'done' => 'Done',
      'stopped' || 'lost' => 'Stopped',
      'cancelled' => 'Cancelled',
      'reconciling' => 'Checking its agent',
      _ => 'Not started',
    };

/// Like a Slack app's message that updates itself (backend superTabs/cards.ts):
/// a task or a pull request drawn as one card under its message, changing in
/// place as the group's state and GitHub change. Agents read the same facts at
/// once in the Swarm's state, so they need no step-by-step lines.
class SuperTabLiveCard extends StatefulWidget {
  const SuperTabLiveCard({
    super.key,
    required this.group,
    required this.card,
    required this.controller,
    required this.facts,
  });
  final SuperTabConversation group;
  final SuperTabCard card;
  final SuperTabController controller;
  final SuperTabPullRequestFacts facts;

  @override
  State<SuperTabLiveCard> createState() => _SuperTabLiveCardState();
}

class _SuperTabLiveCardState extends State<SuperTabLiveCard> {
  late List<SuperTabPullRequestCard> _watched = _pullRequests;

  /// A task card lists every pull request its group linked; a PR card its own.
  List<SuperTabPullRequestCard> get _pullRequests {
    if (!widget.card.task) return widget.card.pullRequests;
    final cards = widget.group.cards.pullRequests;
    return [
      for (final url in widget.group.pullRequestUrls)
        cards.where((c) => c.url == url).firstOrNull ??
            SuperTabPullRequestCard(url, ''),
    ];
  }

  @override
  void initState() {
    super.initState();
    widget.facts.watch(_watched.map((c) => c.url));
  }

  @override
  void didUpdateWidget(SuperTabLiveCard old) {
    super.didUpdateWidget(old);
    // Watched again before the old ones are let go, so a rebuild never
    // stops the refresh of what it still shows.
    final next = _pullRequests;
    widget.facts.watch(next.map((c) => c.url));
    old.facts.unwatch(_watched.map((c) => c.url));
    _watched = next;
  }

  @override
  void dispose() {
    widget.facts.unwatch(_watched.map((c) => c.url));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.facts,
    builder: (context, _) {
      final pulls = [
        for (final card in _watched)
          SuperTabCardPullRequest(card, widget.facts.of(card.url)),
      ];
      final linked = widget.controller.linkedLine(widget.group);
      return _Frame(
        bar: widget.card.task || pulls.isEmpty
            ? DesktopChrome.accent
            : pullRequestIconColor(
                pulls.first.state,
                null,
                brightness: Theme.of(context).brightness,
              ),
        children: [
          if (widget.card.task) ..._task(),
          for (final pull in pulls) SuperTabCardPullRequestRow(pull),
          if (linked != null) Text(linked, style: DesktopChrome.metadata()),
        ],
      );
    },
  );

  List<Widget> _task() {
    final checks = widget.group.checks;
    // A failed check keeps its evidence; only a pass names who passed it
    // (backend commands.ts `work.check`).
    final passed = checks.where((c) => c['passedBy'] != null).length;
    return [
      Text(widget.group.label, style: DesktopChrome.control(medium: true)),
      SuperTabCardLine([
        superTabCardStatus(widget.group.assignment),
        if (checks.isNotEmpty) '$passed of ${checks.length} checks passed',
      ]),
    ];
  }
}

/// The card's surface: a colored edge, as a Slack attachment has, then its
/// rows.
class _Frame extends StatelessWidget {
  const _Frame({required this.bar, required this.children});
  final Color bar;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: DesktopChrome.controlGap),
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 560),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: DesktopChrome.surface,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          border: Border.all(color: DesktopChrome.rim),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  width: DesktopChrome.controlGap / 2,
                  child: ColoredBox(color: bar),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.all(DesktopChrome.controlGap),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      spacing: DesktopChrome.controlGap / 2,
                      children: children,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
