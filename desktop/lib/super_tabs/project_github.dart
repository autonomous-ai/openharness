import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'model.dart';

/// Whether teammates' agents can push and open pull requests on a Swarm project's repository: the Harness GitHub App is
/// installed there (backend github/projectAccess.ts, docs/plans/2026-10-28-swarm-project-github-access.md). Before this,
/// nothing said so until a start failed and the Lead relayed it.
class SuperTabProjectGitHub {
  SuperTabProjectGitHub.fromJson(Map<String, dynamic> row)
    : state = row['state'] is String ? row['state'] as String : 'unavailable',
      repository = row['repository'] is String
          ? row['repository'] as String
          : null,
      installUrl = row['installUrl'] is String
          ? row['installUrl'] as String
          : null,
      canApprove = row['canApprove'] == true;

  /// `covered`, `not-installed`, `not-approved` (installed, but nobody who can push to it approved it for this project:
  /// backend github/approvals.ts), `not-github`, `no-repository`, `unknown` (GitHub did not answer), or `unavailable`
  /// (the server has no GitHub App: nothing is shown).
  final String state;
  final String? repository;
  final String? installUrl;

  /// This server has the app's GitHub sign-in to approve a repository with.
  final bool canApprove;

  /// What stops teammates' agents here, in the sidebar's one line; null when nothing does or it cannot be said.
  String? get problem => switch (state) {
    'not-installed' || 'not-approved' => "Teammates can't push here yet",
    'not-github' => "Teammates can't work here: not on GitHub",
    _ => null,
  };
}

/// The project's GitHub access in full, with what to do about it: Project details, and the dialog the sidebar line
/// opens. Read when shown; [SuperTabController.readGitHubAccess] keeps it at most 5 minutes.
class ProjectGitHubAccess extends StatefulWidget {
  const ProjectGitHubAccess({
    super.key,
    required this.controller,
    required this.projectId,
  });

  final SuperTabController controller;
  final String projectId;

  @override
  State<ProjectGitHubAccess> createState() => _ProjectGitHubAccessState();
}

class _ProjectGitHubAccessState extends State<ProjectGitHubAccess>
    with WidgetsBindingObserver {
  bool _checking = false;
  bool _copied = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.readGitHubAccess(widget.projectId);
  }

  @override
  void didUpdateWidget(ProjectGitHubAccess old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller ||
        old.projectId != widget.projectId) {
      widget.controller.readGitHubAccess(widget.projectId);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Back from GitHub's install page: asked again at once.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final known = widget.controller.githubAccessOf(widget.projectId);
    if (state == AppLifecycleState.resumed &&
        known != null &&
        known.state != 'covered') {
      _check();
    }
  }

  Future<void> _check() async {
    setState(() => _checking = true);
    await widget.controller.readGitHubAccess(widget.projectId, refresh: true);
    if (mounted) setState(() => _checking = false);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final access = widget.controller.githubAccessOf(widget.projectId);
        if (access == null || access.state == 'unavailable') {
          return const SizedBox.shrink();
        }
        final repository = access.repository ?? 'its repository';
        final text = switch (access.state) {
          'covered' =>
            "GitHub ✓ Teammates' agents can push and open pull requests on $repository.",
          'not-installed' =>
            "Teammates' agents can't push to $repository yet. Install Harness on GitHub there: "
                "an owner of ${repository.split('/').first}, or the repository's owner, can.",
          'not-approved' =>
            access.canApprove
                ? "Teammates' agents can't use $repository in this project yet. Someone who can push to it "
                      'approves it, signing in to GitHub.'
                : "Teammates' agents can't use $repository in this project yet. This Harness server can't approve "
                      'repositories yet.',
          'not-github' => "Teammates' agents can't work on this project: its repository isn't on GitHub.",
          'no-repository' => 'This project has no repository address yet. Its owner or Lead sets it.',
          _ => "Couldn't reach GitHub to check $repository.",
        };
        final install = access.installUrl;
        final approve = access.state == 'not-approved' && access.canApprove;
        return Column(
          key: ValueKey('super-project-github-${widget.projectId}'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('GitHub access', style: DesktopChrome.control(medium: true)),
            const SizedBox(height: 4),
            Text(
              text,
              key: ValueKey('super-project-github-text-${widget.projectId}'),
              style: DesktopChrome.text(),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  _error!,
                  key: const Key('super-project-github-error'),
                  style: DesktopChrome.text().copyWith(
                    color: grid.AppPalette.warn,
                  ),
                ),
              ),
            if (access.state == 'not-installed' ||
                access.state == 'not-approved' ||
                access.state == 'unknown')
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    if (install != null && access.state == 'not-installed') ...[
                      FilledButton(
                        key: const Key('super-project-github-install'),
                        onPressed: _busy ? null : () => _install(install),
                        child: const Text('Install on GitHub'),
                      ),
                      TextButton(
                        key: const Key('super-project-github-copy'),
                        onPressed: () async {
                          await Clipboard.setData(ClipboardData(text: install));
                          if (mounted) setState(() => _copied = true);
                        },
                        child: Text(_copied ? 'Link copied' : 'Copy link'),
                      ),
                    ],
                    if (approve) ...[
                      FilledButton(
                        key: const Key('super-project-github-approve'),
                        onPressed: _busy ? null : () => _approve('project'),
                        child: const Text('Approve for this project'),
                      ),
                      TextButton(
                        key: const Key('super-project-github-approve-swarm'),
                        onPressed: _busy ? null : () => _approve('swarm'),
                        child: const Text('Approve for every project here'),
                      ),
                    ],
                    TextButton(
                      key: const Key('super-project-github-check'),
                      onPressed: _checking ? null : _check,
                      child: Text(_checking ? 'Checking…' : 'Check again'),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }

  /// Installs Harness on GitHub with a link that also approves the repository for this project once installed (GitHub
  /// signs the installer in and sends them back); an older server's plain link otherwise.
  Future<void> _install(String plain) async {
    setState(() => _busy = true);
    String link = plain;
    try {
      link =
          (await widget.controller.approveGitHub(
            widget.projectId,
            'project',
          )).installUrl ??
          plain;
    } catch (_) {
      // The plain link still installs; approving is then a step of its own.
    }
    await launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication);
    if (mounted) setState(() => _busy = false);
  }

  /// Signs the person in to GitHub through the app, which approves the repository if they can push to it.
  Future<void> _approve(String scope) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final links = await widget.controller.approveGitHub(
        widget.projectId,
        scope,
      );
      await launchUrl(
        Uri.parse(links.authorizeUrl),
        mode: LaunchMode.externalApplication,
      );
    } on SuperTabFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = "Couldn't start approving. Try again.");
      }
    }
    if (mounted) setState(() => _busy = false);
  }
}

/// The sidebar's one line under a project whose teammates' agents cannot push there, in a Swarm with another person
/// in it; clicking it shows [ProjectGitHubAccess].
class ProjectGitHubLine extends StatefulWidget {
  const ProjectGitHubLine({
    super.key,
    required this.controller,
    required this.project,
  });

  final SuperTabController controller;
  final SuperTabProject project;

  @override
  State<ProjectGitHubLine> createState() => _ProjectGitHubLineState();
}

class _ProjectGitHubLineState extends State<ProjectGitHubLine> {
  @override
  void initState() {
    super.initState();
    if (widget.controller.snapshot?.hasTeammates == true) {
      widget.controller.readGitHubAccess(widget.project.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        if (c.snapshot?.hasTeammates != true) return const SizedBox.shrink();
        // A Swarm that gained a person since: read now (at most every 5 minutes, answered or not).
        c.readGitHubAccess(widget.project.id);
        final problem = c.githubAccessOf(widget.project.id)?.problem;
        if (problem == null) return const SizedBox.shrink();
        return InkWell(
          key: ValueKey('super-project-github-line-${widget.project.id}'),
          onTap: () => showProjectGitHubAccess(context, c, widget.project),
          child: Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              problem,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata().copyWith(
                color: grid.AppPalette.warn,
              ),
            ),
          ),
        );
      },
    );
  }
}

Future<void> showProjectGitHubAccess(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
) => showAppDialog<void>(
  context: context,
  builder: (context) => AlertDialog(
    key: const Key('super-project-github-dialog'),
    title: Text(project.name),
    content: SizedBox(
      width: 400,
      child: ProjectGitHubAccess(controller: c, projectId: project.id),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Close'),
      ),
    ],
  ),
);
