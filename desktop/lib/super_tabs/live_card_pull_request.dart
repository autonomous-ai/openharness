import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/pull_request_icon.dart';
import '../widgets/desktop_chrome.dart';
import 'live_card_model.dart';
import 'pull_request_entry.dart';

/// What a card says of one pull request: GitHub's facts as this computer read
/// them, else the Swarm's own (its link, and a merge it recorded).
class SuperTabCardPullRequest {
  const SuperTabCardPullRequest(this.card, this.entry);
  final SuperTabPullRequestCard card;
  final SuperTabPullRequestEntry? entry;

  Uri get url => Uri.parse(card.url);
  String get name => '${url.pathSegments[1]} · PR #${url.pathSegments[3]}';

  /// A merge the Swarm recorded wins over what this computer last read.
  String get state => card.merged ? 'Merged' : entry?.state ?? '';

  /// Words beside the state: checks while it is open, and what blocks it.
  List<String> get details {
    final entry = this.entry;
    if (card.merged || entry == null || entry.finalState) return const [];
    return [
      if (entry.kind
          case PullRequestKind.conflicts ||
              PullRequestKind.changes ||
              PullRequestKind.behind)
        entry.label,
      if (entry.total > 0) entry.checksLabel,
    ];
  }
}

/// One pull request on a card: its mark and title, then where it stands.
/// Opens on GitHub.
class SuperTabCardPullRequestRow extends StatelessWidget {
  const SuperTabCardPullRequestRow(this.pull, {super.key});
  final SuperTabCardPullRequest pull;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final title = pull.entry?.title ?? '';
    final bits = [
      if (title.isNotEmpty) pull.name,
      if (pull.state.isNotEmpty) pull.state,
      ...pull.details,
    ];
    return Semantics(
      link: true,
      child: InkWell(
        key: ValueKey('super-card-pr-${pull.card.url}'),
        borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
        onTap: () => unawaited(openInBrowser(pull.url)),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: DesktopChrome.controlGap / 2,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SvgPicture.asset(
                pullRequestIconAsset(pull.state),
                width: grid.AppDesktop.iconSize,
                height: grid.AppDesktop.iconSize,
                colorFilter: ColorFilter.mode(
                  pullRequestIconColor(
                    pull.state,
                    null,
                    brightness: brightness,
                  ),
                  BlendMode.srcIn,
                ),
              ),
              const SizedBox(width: DesktopChrome.controlGap),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title.isNotEmpty ? title : pull.name,
                      style: DesktopChrome.control(medium: true),
                    ),
                    if (bits.isNotEmpty) SuperTabCardLine(bits),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A card's quiet line: its parts in metadata type, a dot between them.
class SuperTabCardLine extends StatelessWidget {
  const SuperTabCardLine(this.parts, {super.key});
  final List<String> parts;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: DesktopChrome.controlGap / 2,
    children: [
      for (final (i, part) in parts.indexed) ...[
        if (i > 0) Text('·', style: DesktopChrome.metadata()),
        Text(part, style: DesktopChrome.metadata()),
      ],
    ],
  );
}
