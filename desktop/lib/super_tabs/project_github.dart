import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'model.dart';

/// The spacing scale's steps (4, 8, 12) from the shared control gap, as the leaderboard rows take them.
const _gap = DesktopChrome.controlGap;
const _halfGap = _gap / 2;

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
      canApprove = row['canApprove'] == true,
      approvedFor = [
        for (final name in row['approvedFor'] as List? ?? const [])
          if (name is String) name,
      ],
      youCanPush = row['you'] is Map && (row['you'] as Map)['canPush'] is bool
          ? (row['you'] as Map)['canPush'] as bool
          : null,
      githubLogin =
          row['you'] is Map && (row['you'] as Map)['githubLogin'] is String
          ? (row['you'] as Map)['githubLogin'] as String
          : null;

  /// `covered`, `not-installed`, `not-approved` (installed, but nobody who can push to it approved it for this project:
  /// backend github/approvals.ts), `not-github`, `no-repository`, `unknown` (GitHub did not answer), `unread` (this
  /// app could not ask the server), or `unavailable` (the server has no GitHub App: nothing is shown).
  final String state;
  final String? repository;
  final String? installUrl;

  /// This server has the app's GitHub sign-in to approve a repository with.
  final bool canApprove;

  /// The reader's other projects the repository is approved for, when it is not approved for this one (backend
  /// github/projectAccess.ts): approving is per project, so a second one asks again.
  final List<String> approvedFor;

  /// What GitHub last said about the reader on the repository (backend github/approvals.ts `reader`): true once they
  /// allowed it in this Swarm, false once their sign-in was refused for this project, null before either.
  final bool? youCanPush;

  /// The reader's GitHub account, when [youCanPush] is known.
  final String? githubLogin;

  /// The sidebar's one line under the project, null when it needs none. Setting up access is a step to take, not a
  /// fault, so it reads as one (design 2026-10-30: the orange "Teammates can't push here yet" read as an error on a
  /// Swarm whose owner had done nothing wrong); a repository that is not on GitHub is the one real blocker.
  String? get problem => switch (state) {
    'not-installed' || 'not-approved' => 'Set up GitHub for teammates',
    'not-github' => "Teammates can't work here: not on GitHub",
    _ => null,
  };

  /// [problem] is a step to take rather than a blocker.
  bool get setupStep => state == 'not-installed' || state == 'not-approved';
}

/// Names in a sentence: "Notes", "Notes and Docs", "Notes, Docs and Site".
String _names(List<String> names) => names.length < 2
    ? names.join()
    : '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';

/// The project's GitHub access in full, with what to do about it: Project details' row, and the dialog the sidebar line
/// opens ([dialog]). Read when shown; [SuperTabController.readGitHubAccess] keeps it at most 5 minutes.
class ProjectGitHubAccess extends StatefulWidget {
  const ProjectGitHubAccess({
    super.key,
    required this.controller,
    required this.projectId,
    this.detailRow = false,
    this.dialog = false,
    this.projectName,
  });

  final SuperTabController controller;
  final String projectId;

  /// As a row of Project details: its label in the dialog's label column, rather than a heading above it.
  final bool detailRow;

  /// As the whole dialog the sidebar line opens: a heading and buttons for each state, closing itself
  /// (design 2026-10-30, "Swarm GitHub access flow").
  final bool dialog;

  /// The project's name, for the dialog's headings.
  final String? projectName;

  @override
  State<ProjectGitHubAccess> createState() => _ProjectGitHubAccessState();
}

class _ProjectGitHubAccessState extends State<ProjectGitHubAccess>
    with WidgetsBindingObserver {
  bool _checking = false;
  bool _copied = false;
  bool _askCopied = false;
  bool _busy = false;
  String? _error;

  /// GitHub's page is open in the browser: said here until the person is back and it is read again.
  bool _inBrowser = false;

  /// The page last opened in the browser, for "Open GitHub again".
  String? _openedLink;

  /// The state GitHub's page was opened for: the waiting screen stays until it changes or the person cancels.
  String? _openedFor;

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
    if (mounted) {
      setState(() {
        _checking = false;
        // Coming back to the app is not finishing on GitHub (2026-10-30: the waiting screen vanished the moment
        // Harness came to the front, so nobody ever saw it). It ends when GitHub's answer changes, or on Cancel.
        if (_answerOf(widget.controller.githubAccessOf(widget.projectId)) !=
            _openedFor) {
          _inBrowser = false;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final access = widget.controller.githubAccessOf(widget.projectId);
        if (access?.state == 'unavailable') {
          return widget.dialog ? _dialogFor(null) : const SizedBox.shrink();
        }
        if (widget.dialog) return _dialogFor(access);
        // Read as the dialog opens: said, so the section does not appear from nothing a moment later.
        if (access == null) {
          return _framed(
            Text(
              'Checking…',
              key: ValueKey('super-project-github-text-${widget.projectId}'),
              style: DesktopChrome.text().copyWith(color: DesktopChrome.muted),
            ),
          );
        }
        final repository = access.repository ?? 'its repository';
        final sentence = Text(
          _sentence(access, repository),
          key: ValueKey('super-project-github-text-${widget.projectId}'),
          style: DesktopChrome.text(),
        );
        final pending =
            access.state == 'not-installed' || access.state == 'not-approved';
        return _framed(
          Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (access.state == 'covered')
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: _halfGap / 2),
                      child: Icon(
                        AppIcons.check,
                        size: grid.AppControl.iconSize,
                        color: grid.AppPalette.online,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(child: sentence),
                  ],
                )
              else
                sentence,
              if (_inBrowser && pending)
                Padding(
                  padding: const EdgeInsets.only(top: _halfGap),
                  child: Text(
                    'Finish in GitHub in your browser. This updates when you come back.',
                    key: const Key('super-project-github-waiting'),
                    style: DesktopChrome.text().copyWith(
                      color: DesktopChrome.muted,
                    ),
                  ),
                ),
              if (_error != null) _errorText(),
              if (pending ||
                  access.state == 'unknown' ||
                  access.state == 'unread')
                Padding(
                  padding: const EdgeInsets.only(top: _gap),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      ..._installButtons(access),
                      if (_canApprove(access)) _approveButton(),
                      if (!pending) _tryAgainButton(),
                    ],
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  /// What GitHub has said, as the waiting screen compares it: a refused sign-in ends the wait as an approval does.
  static String? _answerOf(SuperTabProjectGitHub? access) =>
      access == null ? null : '${access.state}/${access.youCanPush}';

  bool _canApprove(SuperTabProjectGitHub access) =>
      access.state == 'not-approved' && access.canApprove;

  /// The project's GitHub access in one sentence, for Project details' row.
  String _sentence(
    SuperTabProjectGitHub access,
    String repository,
  ) => switch (access.state) {
    'covered' =>
      "Teammates' agents can push and open pull requests on $repository.",
    'not-installed' =>
      "Teammates' agents can't push to $repository yet. An owner of ${_owner(repository)} installs Harness on GitHub there.",
    'not-approved' =>
      access.canApprove && access.approvedFor.isNotEmpty
          // Approving is per project: one approved for the reader's other projects says so (group #646, item 8).
          ? "Teammates' agents can't push to $repository from this project yet. It's allowed for "
                '${_names(access.approvedFor)}. Allow it here too?'
          : access.canApprove
          ? "Teammates' agents can't push to $repository from this project yet. Anyone who can push to it can "
                'allow it.'
          : "Teammates' agents can't push to $repository from this project yet. This Harness server can't allow "
                'repositories yet.',
    'not-github' => "Teammates' agents can't work on this project: its repository isn't on GitHub.",
    'no-repository' =>
      'This project has no repository address yet. Its owner or Lead sets it.',
    'unread' => "Couldn't check GitHub access just now.",
    _ => "Couldn't reach GitHub to check $repository.",
  };

  static String _owner(String repository) => repository.split('/').first;

  Widget _errorText() => Padding(
    padding: const EdgeInsets.only(top: _halfGap),
    child: Text(
      _error!,
      key: const Key('super-project-github-error'),
      style: DesktopChrome.text().copyWith(color: grid.AppPalette.warn),
    ),
  );

  List<Widget> _installButtons(SuperTabProjectGitHub access) {
    final install = access.installUrl;
    if (install == null || access.state != 'not-installed') return const [];
    return [
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
    ];
  }

  Widget _approveButton() => FilledButton(
    key: const Key('super-project-github-approve'),
    onPressed: _busy ? null : () => _approve('project'),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('Continue in GitHub'),
        const SizedBox(width: 6),
        Icon(AppIcons.arrowUpRight, size: grid.AppControl.iconSize),
      ],
    ),
  );

  Widget _tryAgainButton() => TextButton(
    key: const Key('super-project-github-check'),
    onPressed: _checking ? null : _check,
    child: Text(_checking ? 'Checking…' : 'Try again'),
  );

  /// The dialog the sidebar line opens: one screen per state, each saying what happens next.
  Widget _dialogFor(SuperTabProjectGitHub? access) {
    final name = widget.projectName ?? 'this project';
    final repository = access?.repository ?? 'its repository';
    void close() => Navigator.maybePop(context);
    final pending =
        access?.state == 'not-installed' || access?.state == 'not-approved';
    if (access == null) {
      return _screen(
        heading: 'GitHub access',
        body: [_body(access == null ? 'Checking…' : '', muted: true)],
        actions: [_closeButton(close)],
      );
    }
    if (_inBrowser && pending) {
      return _screen(
        key: const Key('super-project-github-waiting'),
        leading: SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: grid.AppPalette.accentOnSurface,
          ),
        ),
        heading: 'Finish in GitHub',
        body: [
          _body(
            access.state == 'not-installed'
                ? 'GitHub is open in your browser. Install Harness on ${_owner(repository)} there. '
                      'This updates by itself when you come back.'
                : 'GitHub is open in your browser. Click Authorize on the “Harness for Autonomous” page. '
                      'This updates by itself when you come back.',
          ),
          if (access.state == 'not-approved')
            _box(
              title: "What GitHub's page means",
              text:
                  "“Act on your behalf” is GitHub's wording for any app you sign in to. Harness uses it to "
                  'confirm you can push to $repository.',
            ),
        ],
        aside: [
          if (_openedLink != null)
            TextButton(
              key: const Key('super-project-github-reopen'),
              onPressed: () => launchUrl(
                Uri.parse(_openedLink!),
                mode: LaunchMode.externalApplication,
              ),
              child: const Text('Open GitHub again'),
            ),
        ],
        actions: [
          OutlinedButton(
            key: const Key('super-project-github-cancel'),
            onPressed: () => setState(() => _inBrowser = false),
            child: const Text('Cancel'),
          ),
        ],
      );
    }
    switch (access.state) {
      case 'covered':
        return _screen(
          leading: Icon(
            AppIcons.check,
            size: grid.AppControl.iconSize + 4,
            color: grid.AppPalette.online,
          ),
          heading: "Teammates' agents can push to $name",
          body: [
            _body(
              'From now on they push branches and open pull requests on $repository from their own machines.',
              key: ValueKey('super-project-github-text-${widget.projectId}'),
            ),
          ],
          actions: [
            FilledButton(
              key: const Key('super-project-github-done'),
              onPressed: close,
              child: const Text('Done'),
            ),
          ],
        );
      case 'not-approved' when access.canApprove && access.youCanPush == false:
        // GitHub said this reader can't push (design 2b): asking them to sign in again would end the same way.
        final message =
            'Could you open $name in Harness and click “Set up GitHub for teammates”? Our agents need it to push '
            'to $repository.';
        return _screen(
          key: const Key('super-project-github-ask-screen'),
          heading: 'Someone with write access needs to allow this',
          body: [
            _body(
              "Your GitHub account${access.githubLogin == null ? '' : ' (${access.githubLogin})'} can't push to "
              "$repository, so teammates' agents can't push there through you. Ask someone in this Swarm who can "
              'push to open the project and allow it.',
              key: ValueKey('super-project-github-text-${widget.projectId}'),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Message to send them',
                  style: DesktopChrome.control(medium: true),
                ),
                const SizedBox(height: _gap),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: grid.AppSurface.wellFill,
                    borderRadius: BorderRadius.circular(
                      DesktopChrome.rowRadius,
                    ),
                    border: Border.all(color: DesktopChrome.rim),
                  ),
                  child: SelectableText(
                    message,
                    style: DesktopChrome.text(size: 13),
                  ),
                ),
              ],
            ),
            _body(
              "This project updates by itself once they've allowed it.",
              muted: true,
            ),
          ],
          actions: [
            OutlinedButton(onPressed: close, child: const Text('Close')),
            FilledButton(
              key: const Key('super-project-github-ask'),
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: message));
                if (mounted) setState(() => _askCopied = true);
              },
              child: Text(_askCopied ? 'Message copied' : 'Copy message'),
            ),
          ],
        );
      case 'not-approved' when access.canApprove:
        final canPush = access.youCanPush == true;
        return _screen(
          heading: "Let teammates' agents push to $name",
          body: [
            _body(
              "Agents on your teammates' machines push branches and open pull requests through the Harness GitHub app. "
              '${canPush ? 'You have write access, so you can allow it.' : 'Anyone who can push to $repository can allow it.'}'
              '${access.approvedFor.isEmpty ? '' : " It's already allowed for ${_names(access.approvedFor)}."}',
              key: ValueKey('super-project-github-text-${widget.projectId}'),
            ),
            _repository(repository, canPush: canPush),
            _allows('Push branches and open pull requests'),
            _allows('Only in this repository, only for this project'),
            _body(
              "GitHub opens next so you can confirm it's you. Come back here when it's done.",
              muted: true,
            ),
            if (_error != null) _errorText(),
          ],
          actions: [
            OutlinedButton(onPressed: close, child: const Text('Not now')),
            _approveButton(),
          ],
        );
      case 'not-approved':
        return _screen(
          heading: "GitHub access isn't available yet",
          body: [
            _body(
              "Teammates' agents can't push to $repository from this project yet: this Harness server "
              "can't allow repositories yet.",
              key: ValueKey('super-project-github-text-${widget.projectId}'),
            ),
          ],
          actions: [_closeButton(close)],
        );
      case 'not-installed':
        return _screen(
          heading: 'Install Harness on GitHub for $name',
          body: [
            _body(
              "Teammates' agents push through the Harness GitHub app, which isn't on ${_owner(repository)} yet. "
              'An owner of ${_owner(repository)} can install it.',
              key: ValueKey('super-project-github-text-${widget.projectId}'),
            ),
            _repository(repository),
            if (_error != null) _errorText(),
          ],
          aside: [..._installButtons(access).skip(1)],
          actions: [
            OutlinedButton(onPressed: close, child: const Text('Not now')),
            ..._installButtons(access).take(1),
          ],
        );
      default:
        return _screen(
          heading: 'GitHub access',
          body: [
            _body(
              _sentence(access, repository),
              key: ValueKey('super-project-github-text-${widget.projectId}'),
            ),
          ],
          actions: [
            if (access.state == 'unknown' || access.state == 'unread')
              _tryAgainButton(),
            _closeButton(close),
          ],
        );
    }
  }

  Widget _closeButton(VoidCallback close) =>
      OutlinedButton(onPressed: close, child: const Text('Close'));

  Widget _screen({
    Key? key,
    Widget? leading,
    required String heading,
    required List<Widget> body,
    List<Widget> aside = const [],
    required List<Widget> actions,
  }) => KeyedSubtree(
    key: ValueKey('super-project-github-${widget.projectId}'),
    child: Column(
      key: key,
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            if (leading != null) ...[leading, const SizedBox(width: 10)],
            Expanded(
              child: Text(
                heading,
                key: const Key('super-project-github-heading'),
                // The design's dialog heading: the title role, semibold.
                style: grid.AppType.title(color: DesktopChrome.foreground),
              ),
            ),
          ],
        ),
        for (final part in body) ...[
          const SizedBox(height: DesktopChrome.groupGap),
          part,
        ],
        if (aside.isNotEmpty) ...[
          const SizedBox(height: _halfGap),
          TextButtonTheme(
            data: TextButtonThemeData(
              style: TextButton.styleFrom(
                foregroundColor: grid.AppPalette.accentOnSurface,
                backgroundColor: Colors.transparent,
                side: BorderSide.none,
                padding: EdgeInsets.zero,
                minimumSize: const Size(0, 32),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
            ),
            child: Wrap(spacing: _gap * 2, children: aside),
          ),
        ],
        const SizedBox(height: DesktopChrome.groupGap + _gap),
        // Wraps under large text rather than overflowing the dialog.
        SizedBox(
          width: double.infinity,
          child: Wrap(
            alignment: WrapAlignment.end,
            spacing: _gap - 2,
            runSpacing: _halfGap,
            children: actions,
          ),
        ),
      ],
    ),
  );

  /// A paragraph in the secondary text colour, as the design has it; [note] smaller, [primary] for what is allowed.
  Widget _body(
    String text, {
    Key? key,
    bool muted = false,
    bool primary = false,
  }) => Text(
    text,
    key: key,
    style: DesktopChrome.text(
      color: primary ? null : DesktopChrome.muted,
      size: muted ? 13 : 14,
    ),
  );

  Widget _repository(String repository, {bool canPush = false}) => Container(
    padding: const EdgeInsets.symmetric(
      horizontal: grid.AppDesktop.groupGap,
      vertical: grid.AppDesktop.controlGap,
    ),
    decoration: BoxDecoration(
      color: grid.AppSurface.wellFill,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: Row(
      children: [
        Icon(
          AppIcons.book,
          size: grid.AppControl.iconSize,
          color: DesktopChrome.muted,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(repository, style: DesktopChrome.text(medium: true)),
        ),
        // Known only once GitHub has said so: they allowed it for another project of the Swarm.
        if (canPush)
          Container(
            key: const Key('super-project-github-can-push'),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: grid.AppPalette.online.withValues(alpha: .14),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              'You can push',
              style: DesktopChrome.metadata(color: grid.AppPalette.online),
            ),
          ),
      ],
    ),
  );

  Widget _allows(String text) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.only(top: grid.AppDesktop.listRowGap),
        child: Icon(
          AppIcons.check,
          size: grid.AppControl.iconSize,
          color: grid.AppPalette.online,
        ),
      ),
      const SizedBox(width: 10),
      Expanded(child: _body(text, primary: true)),
    ],
  );

  Widget _box({required String title, required String text}) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
    decoration: BoxDecoration(
      color: grid.AppSurface.wellFill,
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: DesktopChrome.control(medium: true)),
        const SizedBox(height: 4),
        Text(text, style: DesktopChrome.metadata()),
      ],
    ),
  );

  /// Under its heading, or as Project details' row.
  Widget _framed(Widget content) => KeyedSubtree(
    key: ValueKey('super-project-github-${widget.projectId}'),
    child: widget.detailRow
        ? SuperTabDetailRow(label: 'GitHub access', child: content)
        : Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('GitHub access', style: DesktopChrome.control(medium: true)),
              const SizedBox(height: 4),
              content,
            ],
          ),
  );

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
    if (mounted) {
      setState(() {
        _busy = false;
        _inBrowser = true;
        _openedLink = link;
        _openedFor = _answerOf(
          widget.controller.githubAccessOf(widget.projectId),
        );
      });
    }
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
      if (mounted) {
        setState(() {
          _inBrowser = true;
          _openedLink = links.authorizeUrl;
          _openedFor = _answerOf(
            widget.controller.githubAccessOf(widget.projectId),
          );
        });
      }
    } on SuperTabFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = "Couldn't open GitHub. Try again.");
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

class _ProjectGitHubLineState extends State<ProjectGitHubLine>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.controller.snapshot?.hasTeammates == true) {
      widget.controller.readGitHubAccess(widget.project.id);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Back from GitHub, where the person installed or approved: the line asks again at once. It kept saying
  // "Teammates can't push here yet" for up to 5 minutes after an approval (2026-10-28).
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final c = widget.controller;
    if (state == AppLifecycleState.resumed &&
        c.snapshot?.hasTeammates == true &&
        c.githubAccessOf(widget.project.id)?.problem != null) {
      c.readGitHubAccess(widget.project.id, refresh: true);
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
        final access = c.githubAccessOf(widget.project.id);
        final problem = access?.problem;
        if (problem == null) return const SizedBox.shrink();
        return InkWell(
          key: ValueKey('super-project-github-line-${widget.project.id}'),
          onTap: () => showProjectGitHubAccess(context, c, widget.project),
          child: Padding(
            padding: const EdgeInsets.only(bottom: _halfGap),
            child: Row(
              children: [
                if (access!.setupStep) ...[
                  Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: grid.AppPalette.accentOnSurface,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 6),
                ],
                Flexible(
                  child: Text(
                    problem,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(
                      color: access.setupStep ? null : grid.AppPalette.warn,
                    ),
                  ),
                ),
              ],
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
    scrollable: true,
    content: SizedBox(
      width: 464,
      child: ProjectGitHubAccess(
        controller: c,
        projectId: project.id,
        dialog: true,
        projectName: project.name,
      ),
    ),
  ),
);
