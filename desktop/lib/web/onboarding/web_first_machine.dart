import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/command_row.dart';
import '../../state/app_state.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/link_another_machine_dialog.dart'
    show kLinkServerInstallCommand, kLinkServerLoginCommand;
import '../../widgets/web_download_button.dart';
import 'web_your_computers.dart';

/// What a browser shows while none of the account's computers is connected,
/// in place of the workspace — which used to open the machine picker: a search
/// box with `@` in it, Harnesses/Agents/Store tabs that could do nothing, and
/// two lines of help.
///
/// The account's computers first, if it has any ([WebYourComputers]): one
/// waiting on this browser connects right here. Then both ways to set one up,
/// side by side: the app for a desktop, the CLI for a server. Either signs in
/// on that computer, which then appears here on its own; the workspace takes
/// over the moment one connects.
class WebFirstMachine extends StatefulWidget {
  const WebFirstMachine({
    super.key,
    required this.app,
    this.openPage = openInNewTab,
  });

  final AppNotifier app;

  /// How the download page opens; tests pass a recorder.
  final Future<bool> Function(Uri uri) openPage;

  /// How often the page asks for the machine list while it waits. A computer
  /// signing in is announced to the account's other windows over their
  /// connections to its machines — and this one has none yet, so nothing
  /// would tell it before the five-minute safety net.
  static const watchEvery = Duration(seconds: 4);

  @override
  State<WebFirstMachine> createState() => _WebFirstMachineState();
}

class _WebFirstMachineState extends State<WebFirstMachine> {

  String? _copied;
  Timer? _copiedReset;
  late final Timer _watch;

  @override
  void initState() {
    super.initState();
    _watch = Timer.periodic(
      WebFirstMachine.watchEvery,
      (_) => unawaited(widget.app.rereadMachines()),
    );
  }

  @override
  void dispose() {
    _watch.cancel();
    _copiedReset?.cancel();
    super.dispose();
  }

  Future<void> _copy(String command) async {
    await Clipboard.setData(ClipboardData(text: command));
    if (!mounted) return;
    setState(() => _copied = command);
    _copiedReset?.cancel();
    _copiedReset = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = null);
    });
  }

  Widget _command(String command) => CommandRow(
    command: command,
    copied: _copied == command,
    onCopy: () => unawaited(_copy(command)),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final email = widget.app.currentUser?.email;
    final account = email == null || email.isEmpty ? 'this account' : email;
    final options = [
      _Option(
        icon: AppIcons.laptop,
        title: 'Desktop app',
        detail: 'On a Mac or Linux desktop. Open it and sign in as $account.',
        children: [
          FilledButton.icon(
            onPressed: () => widget.openPage(WebDownloadButton.uri),
            icon: const Icon(AppIcons.download, size: 16),
            label: const Text('Download app'),
          ),
        ],
      ),
      _Option(
        icon: AppIcons.squareTerminal,
        title: 'Command line',
        detail:
            'On a server, or anywhere you prefer a terminal. Run these there, '
            'and sign in as $account:',
        children: [
          _command(kLinkServerInstallCommand),
          const SizedBox(height: 8),
          _command(kLinkServerLoginCommand),
        ],
      ),
    ];
    final hasComputers = WebYourComputers.listed(widget.app).isNotEmpty;
    return LayoutBuilder(
      builder: (context, constraints) {
        final sideBySide = constraints.maxWidth >= 640;
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              header: true,
              child: Text(
                hasComputers ? 'Connect your computer' : 'Connect a computer',
                textAlign: TextAlign.center,
                style: grid.AppType.display(color: DesktopChrome.foreground),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              hasComputers
                  ? 'Your harnesses run on your computers. Connect this '
                        'browser to one to start.'
                  : 'Your harnesses run on a computer of yours. Set one up '
                        'and it appears here by itself.',
              textAlign: TextAlign.center,
              style: DesktopChrome.text(color: DesktopChrome.muted),
            ),
            const SizedBox(height: 28),
            if (hasComputers) ...[
              WebYourComputers(app: widget.app),
              const SizedBox(height: 18),
              Text(
                'Or set up another computer',
                style: DesktopChrome.heading(),
              ),
              const SizedBox(height: 12),
            ],
            sideBySide
                ? IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(child: options.first),
                        const SizedBox(width: 16),
                        Expanded(child: options.last),
                      ],
                    ),
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      options.first,
                      const SizedBox(height: 16),
                      options.last,
                    ],
                  ),
            const SizedBox(height: 24),
            const Center(child: _Waiting()),
          ],
        );
      },
    );
  }
}

/// One way in: what it is for, and what to do.
class _Option extends StatelessWidget {
  const _Option({
    required this.icon,
    required this.title,
    required this.detail,
    required this.children,
  });

  final IconData icon;
  final String title;
  final String detail;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: DesktopChrome.field,
      border: Border.all(color: DesktopChrome.rim),
      borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 18, color: DesktopChrome.foreground),
            const SizedBox(width: 10),
            Text(title, style: DesktopChrome.heading()),
          ],
        ),
        const SizedBox(height: 8),
        Text(detail, style: DesktopChrome.text(color: DesktopChrome.muted)),
        const SizedBox(height: 16),
        ...children,
      ],
    ),
  );
}

/// The workspace replaces this page when a computer connects; until then it
/// says so, so the page does not read as finished.
class _Waiting extends StatelessWidget {
  const _Waiting();

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox.square(
          dimension: 12,
          child: CircularProgressIndicator(
            strokeWidth: 1.5,
            color: DesktopChrome.muted,
          ),
        ),
        const SizedBox(width: 10),
        Text(
          'Waiting for your computer…',
          style: DesktopChrome.metadata(),
        ),
      ],
    ),
  );
}
