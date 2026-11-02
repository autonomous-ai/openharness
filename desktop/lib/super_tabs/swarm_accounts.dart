import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';

/// One account of this computer the owner can offer to the Swarm or take back.
class SwarmAccount {
  const SwarmAccount({
    required this.engine,
    required this.path,
    required this.label,
    required this.offered,
  });
  final String engine;
  final String path;
  final String label;
  final bool offered;
}

/// The one place an account is offered to the Swarm. Everything else (linking a
/// folder, Add Claude account, picking a row in Change agent) keeps it private:
/// an offer lets other people's PMs spend it, so it is a choice of its own.
Future<void> showSwarmAccounts(
  BuildContext context,
  AppNotifier app,
  String machineId,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SwarmAccountsDialog(
    load: () => app.swarmAccounts(machineId),
    setOffered: (account, offered) =>
        app.setAccountOffered(machineId, account.engine, account.path, offered),
  ),
);

class SwarmAccountsDialog extends StatefulWidget {
  const SwarmAccountsDialog({
    super.key,
    required this.load,
    required this.setOffered,
  });
  final Future<List<SwarmAccount>> Function() load;

  /// Null when done, or what to tell the owner.
  final Future<String?> Function(SwarmAccount account, bool offered) setOffered;

  @override
  State<SwarmAccountsDialog> createState() => _SwarmAccountsDialogState();
}

class _SwarmAccountsDialogState extends State<SwarmAccountsDialog> {
  List<SwarmAccount>? _accounts;
  var _loading = true, _readFailed = false, _busy = false;
  String? _error;

  /// Only the newest read may change the list.
  var _read = 0;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    final read = ++_read;
    setState(() {
      _loading = true;
      _readFailed = false;
    });
    List<SwarmAccount>? accounts;
    try {
      accounts = await widget.load();
    } catch (_) {
      accounts = null;
    }
    if (!mounted || read != _read) return;
    setState(() {
      _loading = false;
      _readFailed = accounts == null;
      if (accounts != null) _accounts = accounts;
    });
  }

  Future<void> _set(SwarmAccount account, bool offered) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.setOffered(account, offered);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
    if (error == null) await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final accounts = _accounts;
    return AlertDialog(
      title: const Text('Swarm accounts'),
      content: SizedBox(
        width: 400,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Other people’s PMs on this Mac can run on an offered account and spend its usage.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: 12),
              if (_readFailed) ...[
                const Text('Couldn’t read this computer’s accounts.'),
                TextButton(onPressed: _reload, child: const Text('Try again')),
              ] else if (accounts == null)
                const Center(child: CircularProgressIndicator())
              else if (accounts.isEmpty)
                const Text('No other accounts on this computer yet.')
              else
                for (final account in accounts)
                  ListTile(
                    key: ValueKey(
                      'swarm-account-${account.engine}-${account.path}',
                    ),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      '${account.engine == 'claude' ? 'Claude' : 'Codex'} · ${account.label}',
                    ),
                    subtitle: Text(account.offered ? 'Offered' : 'Not offered'),
                    trailing: TextButton(
                      onPressed: _busy || _loading
                          ? null
                          : () => _set(account, !account.offered),
                      child: Text(account.offered ? 'Withdraw' : 'Offer'),
                    ),
                  ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!),
              ],
              const SizedBox(height: 12),
              Text(
                'A PM already on a withdrawn account keeps running until someone moves it.',
                style: DesktopChrome.metadata(),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.maybePop(context),
          child: const Text('Done'),
        ),
      ],
    );
  }
}
