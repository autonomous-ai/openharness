import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/github_repository.dart';
import '../shared/theme/app_icons.dart';

/// The pull request links in [text], one per owner, repository and number
/// (GitHub names are not case sensitive), in order.
List<Uri> superTabPullRequestLinks(String text) {
  final seen = <String>{};
  return [
    for (final match in RegExp(
      r'https://github\.com/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)\b',
    ).allMatches(text))
      if (int.tryParse(match.group(3)!) case final number?
          when number <= 9007199254740991 &&
              seen.add(
                '${match.group(1)}/${match.group(2)}/$number'.toLowerCase(),
              ))
        Uri.parse(match.group(0)!),
  ];
}

/// The project's own `owner/repo`, lowercased, when [address] is a GitHub
/// repository in any form git writes one (core/github_repository.dart).
String? _ownRepository(String? address) {
  final identity = address == null ? null : repositoryIdentity(address);
  if (identity == null) return null;
  final slash = identity.indexOf('/');
  return slash > 0 && isGitHubHost(identity.substring(0, slash))
      ? identity.substring(slash + 1)
      : null;
}

/// What each pull request chip says: `repo · PR #n`, with `owner/repo` when
/// the pull request is not in the project's own repository ([repositoryUrl]),
/// or, when the project's is unknown, when two owners share a repository name.
List<String> superTabPullRequestLabels(
  List<Uri> links, {
  String? repositoryUrl,
}) {
  final own = _ownRepository(repositoryUrl);
  final owners = <String, Set<String>>{};
  for (final link in links) {
    owners
        .putIfAbsent(link.pathSegments[1].toLowerCase(), () => {})
        .add(link.pathSegments[0].toLowerCase());
  }
  return [
    for (final link in links)
      () {
        final owner = link.pathSegments[0], repo = link.pathSegments[1];
        final elsewhere = own != null
            ? '$owner/$repo'.toLowerCase() != own
            : owners[repo.toLowerCase()]!.length > 1;
        return '${elsewhere ? '$owner/$repo' : repo} · PR #${link.pathSegments[3]}';
      }(),
  ];
}

class SuperTabPullRequestLinks extends StatelessWidget {
  const SuperTabPullRequestLinks(this.text, {super.key, this.repositoryUrl});
  final String text;

  /// The project's repository address, when known.
  final String? repositoryUrl;
  @override
  Widget build(BuildContext context) {
    final links = superTabPullRequestLinks(text);
    if (links.isEmpty) return const SizedBox.shrink();
    final labels = superTabPullRequestLabels(
      links,
      repositoryUrl: repositoryUrl,
    );
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        children: [
          for (final (i, link) in links.take(4).indexed)
            OutlinedButton.icon(
              onPressed: () => unawaited(
                launchUrl(link, mode: LaunchMode.externalApplication),
              ),
              icon: const Icon(AppIcons.externalLink, size: 14),
              label: Text(labels[i]),
            ),
        ],
      ),
    );
  }
}
