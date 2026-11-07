import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../core/open_in_browser.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/pull_request_icon.dart';
import '../../widgets/desktop_chrome.dart';
import '../controller.dart';
import '../identity.dart';
import '../model.dart';
import 'personal_task_card.dart';
import 'personal_tasks.dart';

/// Above a task's chat in the middle, opened from its Tasks card (anh Dee, 11-07): the full title, then its status,
/// who asked, its agent and its pull request.
class SuperTabTaskHeader extends StatelessWidget {
  const SuperTabTaskHeader({
    super.key,
    required this.controller,
    required this.task,
  });

  final SuperTabController controller;
  final SuperTabPersonalTask task;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final snapshot = controller.snapshot;
    final person = snapshot?.people
        .where((p) => p.id == task.requesterId)
        .firstOrNull;
    final agent = snapshot?.agent(task.agentId ?? '');
    final pr = task.pullRequestUrl;
    const avatar = 18.0;
    Widget fact(List<Widget> children) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (i, child) in children.indexed) ...[
          if (i > 0) const SizedBox(width: grid.AppDesktop.menuInset),
          child,
        ],
      ],
    );
    Widget words(String text) => Text(text, style: DesktopChrome.metadata());
    // As wide as the middle, so a short title starts at its left edge instead of centred in its column.
    return Container(
      key: const ValueKey('super-task-header'),
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(
        grid.AppDesktop.controlGap,
        grid.AppDesktop.controlGap,
        grid.AppDesktop.controlGap,
        grid.AppDesktop.menuInset,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            task.title,
            style: DesktopChrome.control(color: DesktopChrome.foreground)
                .copyWith(fontWeight: grid.AppFont.semibold, height: 1.35),
          ),
          const SizedBox(height: grid.AppDesktop.menuInset),
          Wrap(
            spacing: grid.AppDesktop.groupGap,
            runSpacing: grid.AppDesktop.menuInset,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              fact([
                SuperTabTaskStatusMark(task.status),
                words(superTabTaskStatusLabel(task.status)),
              ]),
              if (task.requesterId case final id?)
                fact([
                  if (person != null)
                    SuperTabAvatar.person(person, size: avatar)
                  else
                    SuperTabAvatar(
                      identity: 'person:$id',
                      name: task.requester['name'] as String? ?? 'Person',
                      size: avatar,
                      picture: SuperTabAvatarPicture.fromJson(
                        task.requester['avatar'],
                      ),
                    ),
                  words(
                    person?.shownName ??
                        task.requester['name'] as String? ??
                        'Person',
                  ),
                ]),
              if (task.agentId case final id?)
                fact([
                  if (agent != null)
                    SuperTabAvatar.agent(
                      agent,
                      size: avatar,
                      engineBadge: false,
                    )
                  else
                    SuperTabAvatar(
                      identity: 'agent:$id',
                      name: task.agent['name'] as String? ?? 'Agent',
                      size: avatar,
                      picture: SuperTabAvatarPicture.fromJson(
                        task.agent['avatar'],
                      ),
                      pattern: true,
                    ),
                  words(
                    agent?.displayName ??
                        agent?.name ??
                        task.agent['name'] as String? ??
                        'Agent',
                  ),
                ]),
              if (pr != null)
                InkWell(
                  borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                  onTap: () => unawaited(openInBrowser(Uri.parse(pr))),
                  child: fact([
                    SvgPicture.asset(
                      pullRequestIconAsset('Open'),
                      width: 14,
                      height: 14,
                      colorFilter: ColorFilter.mode(
                        DesktopChrome.muted,
                        BlendMode.srcIn,
                      ),
                    ),
                    Text(
                      _pullRequestLabel(pr),
                      style: DesktopChrome.metadata(
                        color: DesktopChrome.foreground,
                      ),
                    ),
                  ]),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// "#3464" for a GitHub pull request link; "Pull request" for any other.
String _pullRequestLabel(String url) {
  final segments = Uri.tryParse(url)?.pathSegments ?? const <String>[];
  final number = segments.length >= 2 && segments[segments.length - 2] == 'pull'
      ? int.tryParse(segments.last)
      : null;
  return number == null ? 'Pull request' : '#$number';
}
