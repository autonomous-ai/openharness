import 'package:flutter/material.dart';

import '../models/model_search_catalog.dart' show thisComputerName;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'pm_accounts.dart';

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
    loadPm: () => app.pmAccounts(machineId),
    setPmUse: (ids, on) => app.setPmAccountUse(machineId, ids, on),
    loadMoves: () => app.pmAccountMoves(machineId),
  ),
);

class SwarmAccountsDialog extends StatefulWidget {
  const SwarmAccountsDialog({
    super.key,
    required this.load,
    required this.setOffered,
    this.loadPm,
    this.setPmUse,
    this.loadMoves,
  });
  final Future<List<SwarmAccount>> Function() load;

  /// The Claude accounts a PM may use; null from it (an older CLI) or no function hides that part.
  final Future<List<PmAccount>?> Function()? loadPm;

  /// Null when done, or what to tell the owner.
  final Future<String?> Function(List<String> ids, bool on)? setPmUse;
  final Future<List<PmMove>?> Function()? loadMoves;

  /// Null when done, or what to tell the owner.
  final Future<String?> Function(SwarmAccount account, bool offered) setOffered;

  @override
  State<SwarmAccountsDialog> createState() => _SwarmAccountsDialogState();
}

class _SwarmAccountsDialogState extends State<SwarmAccountsDialog> {
  List<SwarmAccount>? _accounts;
  List<PmAccount>? _pm;
  List<PmMove> _moves = const [];
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
    List<PmAccount>? pm;
    var moves = const <PmMove>[];
    try {
      pm = await widget.loadPm?.call();
      if (pm != null) moves = await widget.loadMoves?.call() ?? const [];
    } catch (_) {
      pm = null;
    }
    if (!mounted || read != _read) return;
    setState(() {
      _loading = false;
      _readFailed = accounts == null;
      if (accounts != null) _accounts = accounts;
      _pm = pm;
      _moves = moves;
    });
  }

  Future<void> _setPm(PmAccount account, bool on) async {
    final set = widget.setPmUse;
    if (_busy || set == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await set([account.id], on);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
    if (error == null) await _reload();
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
        width: _pm == null ? 400 : 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Other people’s PMs on ${thisComputerName()} can run on an offered account and spend its usage.',
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
              if (_pm case final pm?) ...[
                const SizedBox(height: DesktopChrome.groupGap),
                _PmAccountsSection(
                  accounts: pm,
                  moves: _moves,
                  busy: _busy || _loading,
                  onTick: _setPm,
                ),
              ],
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

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

bool _sameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

String _clock(BuildContext context, DateTime at) =>
    MaterialLocalizations.of(context)
        .formatTimeOfDay(TimeOfDay.fromDateTime(at));

/// "6 PM" for today, "Nov 10" for another day.
String _when(BuildContext context, DateTime at, {bool withTime = false}) {
  if (_sameDay(at, DateTime.now())) {
    return withTime ? 'Today ${_clock(context, at)}' : _clock(context, at);
  }
  final day = '${_months[at.month - 1]} ${at.day}';
  return withTime ? '$day ${_clock(context, at)}' : day;
}

/// Neutral above 20% left, amber from 6 to 20, red at 5 or less.
Color _meterColor(int left) => left <= 5
    ? grid.AppPalette.usageCritical
    : left <= 20
    ? grid.AppPalette.usageLow
    : DesktopChrome.muted;

class _PmAccountsSection extends StatelessWidget {
  const _PmAccountsSection({
    required this.accounts,
    required this.moves,
    required this.busy,
    required this.onTick,
  });
  final List<PmAccount> accounts;
  final List<PmMove> moves;
  final bool busy;
  final void Function(PmAccount account, bool on) onTick;

  String _name(String id) {
    for (final a in accounts) {
      if (a.id == id) return a.email ?? a.label;
    }
    return id;
  }

  String _why(PmMove m) => switch (m.why) {
    'low' =>
      '${m.window == 'weekly' ? 'week' : '5-hour window'} at ${m.leftPercent ?? 0}%',
    'out' => 'limit hit',
    'reset' => 'back after the pause',
    'fallback' => 'move undone',
    _ => m.why,
  };

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('PM may use', style: DesktopChrome.text(medium: true)),
        const SizedBox(height: DesktopChrome.controlGap),
        if (accounts.isEmpty)
          Text(
            'No Claude accounts on this computer yet.',
            style: DesktopChrome.metadata(),
          )
        else
          for (final account in accounts)
            _PmAccountRow(
              account: account,
              busy: busy,
              onTick: (on) => onTick(account, on),
            ),
        const SizedBox(height: DesktopChrome.controlGap),
        Text(
          'A PM moves to the ticked account with the most quota left when its own has under 5% left in its 5-hour or weekly window, at its next pause between two turns. Accounts that are signed out or out of quota are skipped.',
          style: DesktopChrome.metadata(),
        ),
        if (moves.isNotEmpty) ...[
          const SizedBox(height: DesktopChrome.groupGap),
          Text('Moves', style: DesktopChrome.text(medium: true)),
          const SizedBox(height: DesktopChrome.controlGap),
          for (final m in [...moves]..sort((a, b) => b.at.compareTo(a.at)))
            Text(
              [
                _when(context, m.at, withTime: true),
                '${_name(m.from)} → ${_name(m.to)}',
                _why(m),
                if (m.awayMs != null) '${(m.awayMs! / 1000).round()} s',
              ].join(' · '),
              style: DesktopChrome.metadata(),
            ),
        ],
      ],
    );
  }
}

class _PmAccountRow extends StatelessWidget {
  const _PmAccountRow({
    required this.account,
    required this.busy,
    required this.onTick,
  });
  final PmAccount account;
  final bool busy;
  final void Function(bool on) onTick;

  @override
  Widget build(BuildContext context) {
    final until = account.outUntil;
    final chip = account.pmHere.isNotEmpty
        ? 'PM is here'
        : !account.signedIn
        ? 'Sign in again'
        : until != null
        ? 'Out until ${_when(context, until)}'
        : 'Ready';
    final chipColor = chip == 'Sign in again' || until != null
        ? grid.AppPalette.usageCritical
        : DesktopChrome.muted;
    return Row(
      key: ValueKey('pm-account-${account.id}'),
      children: [
        Checkbox(
          key: ValueKey('pm-use-${account.id}'),
          value: account.pmMayUse,
          semanticLabel: 'PM may use ${account.label}',
          onChanged: busy ? null : (on) => onTick(on ?? false),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${account.email ?? account.label}${account.isDefault ? ' · default login' : ''}',
                style: DesktopChrome.control(),
                overflow: TextOverflow.ellipsis,
              ),
              Wrap(
                spacing: DesktopChrome.groupGap,
                children: [
                  for (final (name, shown) in const [
                    ('5-hour', '5-hour'),
                    ('weekly', 'Week'),
                  ])
                    if (account.window(name) case final w?)
                      Text(
                        '$shown ${w.leftPercent}% left',
                        style: DesktopChrome.metadata(
                          color: _meterColor(w.leftPercent),
                        ),
                      ),
                ],
              ),
            ],
          ),
        ),
        Text(
          chip,
          key: ValueKey('pm-chip-${account.id}'),
          style: DesktopChrome.metadata(color: chipColor),
        ),
      ],
    );
  }
}
