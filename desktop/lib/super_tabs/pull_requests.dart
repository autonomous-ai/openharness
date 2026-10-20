import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/pull_request_status.dart';
import '../shared/theme/app_icons.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';

List<Uri> superTabPullRequestLinks(String text) => {
  for (final match in RegExp(
    r'https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)\b',
  ).allMatches(text))
    Uri.parse(match.group(0)!),
}.toList();

class SuperTabPullRequestLinks extends StatelessWidget {
  const SuperTabPullRequestLinks(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final links = superTabPullRequestLinks(text);
    if (links.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        children: [
          for (final link in links.take(4))
            OutlinedButton.icon(
              onPressed: () => unawaited(
                launchUrl(link, mode: LaunchMode.externalApplication),
              ),
              icon: const Icon(AppIcons.externalLink, size: 14),
              label: Text(
                '${link.pathSegments[1]} · PR #${link.pathSegments[3]}',
              ),
            ),
        ],
      ),
    );
  }
}

/// Links are evidence of a PR reference, never evidence that checks passed or
/// that its task is finished. Only the owning machine supplies current state.
class SuperTabPullRequests extends StatefulWidget {
  const SuperTabPullRequests({super.key, required this.controller, this.app});
  final SuperTabController controller;
  final AppNotifier? app;
  @override
  State<SuperTabPullRequests> createState() => _SuperTabPullRequestsState();
}

class _SuperTabPullRequestsState extends State<SuperTabPullRequests> {
  final _observed = <String, PullRequestStatus>{};
  bool _all = false, _loading = false;
  String? _scope;
  int _revision = 0;
  Timer? _timer;
  SuperTabController get c => widget.controller;
  List<SuperTabConversation> get _groups =>
      c.snapshot?.conversations
          .where((g) => _all || g.id == c.selectedId)
          .toList() ??
      const [];

  @override
  void initState() {
    super.initState();
    c.addListener(_changed);
    _changed();
  }

  @override
  void didUpdateWidget(SuperTabPullRequests oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != c) {
      oldWidget.controller.removeListener(_changed);
      c.addListener(_changed);
      _scope = null;
      _changed();
    }
  }

  void _changed() {
    final scope = '${c.accountId}:${c.tabId}:${_all ? '*' : c.selectedId}';
    if (scope != _scope) {
      _scope = scope;
      _observed.clear();
      unawaited(_refresh());
    } else if (mounted) {
      setState(() {});
    }
  }

  Future<void> _refresh() async {
    final revision = ++_revision;
    _timer?.cancel();
    setState(() => _loading = true);
    final groups = _groups;
    if (_all) {
      // The controller owns paging and caches; this never changes selection.
      for (final group in groups) {
        if (!mounted || revision != _revision) return;
        await c.loadMessages(group.id);
      }
    }
    final agents =
        c.snapshot?.agents
            .where((a) => groups.any((g) => g.agentIds.contains(a.id)))
            .toList() ??
        const <SuperTabAgent>[];
    final values = <String, PullRequestStatus>{};
    for (var i = 0; i < agents.length; i += 2) {
      await Future.wait(
        agents.skip(i).take(2).map((agent) async {
          try {
            final answer = await widget.app?.readAgentPullRequest(
              agent.machineId,
              agent.harnessId,
            );
            final value = PullRequestStatus.fromResult(answer);
            if (value != null) values[agent.id] = value;
          } catch (_) {
            /* Missing access is unknown, not a passed check. */
          }
        }),
      );
      if (!mounted || revision != _revision) return;
    }
    if (!mounted || revision != _revision) return;
    setState(() {
      _observed
        ..clear()
        ..addAll(values);
      _loading = false;
    });
    if (widget.app != null && widget.app!.foreground.value) {
      _timer = Timer(const Duration(seconds: 60), _refresh);
    }
  }

  @override
  void dispose() {
    _revision++;
    _timer?.cancel();
    c.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final links = <String, ({Uri url, Set<String> groups, String? state})>{};
    void include(Uri url, String group, String? state) {
      final key = url.toString(), prior = links[url.toString()];
      links[key] = (
        url: url,
        groups: {...?prior?.groups, group},
        state: state ?? prior?.state,
      );
    }

    for (final group in _groups) {
      for (final message in c.messages(group.id)) {
        for (final match in RegExp(
          r'https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)\b',
        ).allMatches(message.text)) {
          include(Uri.parse(match.group(0)!), group.title, null);
        }
      }
      for (final agentId in group.agentIds) {
        if (_observed[agentId] case final pr?) {
          include(pr.url, group.title, pr.state);
        }
      }
    }
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Pull requests',
                  style: DesktopChrome.text(medium: true),
                ),
              ),
              DropdownButton<bool>(
                value: _all,
                underline: const SizedBox.shrink(),
                items: const [
                  DropdownMenuItem(value: false, child: Text('This group')),
                  DropdownMenuItem(value: true, child: Text('All groups')),
                ],
                onChanged: (value) {
                  if (value == null) return;
                  setState(() => _all = value);
                  _changed();
                },
              ),
            ],
          ),
        ),
        if (_loading) const LinearProgressIndicator(minHeight: 2),
        Expanded(
          child: links.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      _loading ? 'Reading pull requests…' : 'Pull requests shared in the conversation appear here.',
                      textAlign: TextAlign.center,
                      style: DesktopChrome.text(color: DesktopChrome.muted),
                    ),
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 20,
                    vertical: 12,
                  ),
                  itemCount: links.length,
                  separatorBuilder: (_, _) =>
                      Divider(height: 24, color: DesktopChrome.rim),
                  itemBuilder: (context, i) {
                    final pr = links.values.elementAt(i),
                        parts = pr.url.pathSegments;
                    return ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(
                        '${parts[0]}/${parts[1]} #${parts[3]}',
                        style: DesktopChrome.control(medium: true),
                      ),
                      subtitle: Text(
                        [
                          if (_all) pr.groups.join(' · '),
                          pr.state ?? 'View status on GitHub',
                        ].join('\n'),
                        style: DesktopChrome.metadata(),
                      ),
                      trailing: TextButton(
                        onPressed: () => launchUrl(
                          pr.url,
                          mode: LaunchMode.externalApplication,
                        ),
                        child: const Text('Open on GitHub'),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }
}
