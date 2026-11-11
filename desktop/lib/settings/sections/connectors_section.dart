import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../connectors/connector_icons.dart';
import '../../connectors/connectors_controller.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_dialog.dart';
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/toolbar_pill.dart';
import '../../state/app_state.dart';
import '../../widgets/restart_agent_action.dart';
import '../../widgets/laid_out_list.dart';

/// Settings ▸ Connectors: connect a service once on this computer, and every
/// local agent (Claude Code, Codex, OpenCode) gets it. The same list and
/// sign-ins as `harness connections` and the Grid app's Connectors page; only
/// the service's own consent page opens in the browser.
class ConnectorsSection extends StatefulWidget {
  const ConnectorsSection({super.key, required this.notifier, this.controller});

  final AppNotifier notifier;

  /// Injected by tests; otherwise this computer's.
  final ConnectorsController? controller;

  @override
  State<ConnectorsSection> createState() => _ConnectorsSectionState();
}

class _ConnectorsSectionState extends State<ConnectorsSection> {
  late final ConnectorsController _controller =
      widget.controller ?? ConnectorsController(widget.notifier);
  final _search = TextEditingController();
  bool _connectedOnly = false;

  @override
  void initState() {
    super.initState();
    _controller.refresh();
  }

  @override
  void dispose() {
    if (widget.controller == null) _controller.dispose();
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SectionScaffold(
      title: 'Connectors',
      subtitle:
          'Connect your agents to tools outside this computer: a tracker, a design tool, a web service.',
      child: ListenableBuilder(
        listenable: Listenable.merge([_controller, _search]),
        builder: (context, _) => _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final theme = Theme.of(context);
    final query = _search.text.trim().toLowerCase();
    bool matches(ConnectorCard card) =>
        query.isEmpty ||
        '${card.name} ${card.description}'.toLowerCase().contains(query);
    // Connected through Harness, or through Claude Code or Codex on that computer.
    bool connected(ConnectorCard card) =>
        card.connected || _controller.connectedVia(card.code);
    final on = _controller.shownCards.where((c) => connected(c) && matches(c)).toList();
    final off = _controller.shownCards.where((c) => !connected(c) && matches(c)).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('connectors-search'),
                controller: _search,
                decoration: const InputDecoration(
                  hintText: 'Search connectors',
                  prefixIcon: Icon(AppIcons.search, size: AppIcons.inlineSize),
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: 8),
            AppIconButton(
              icon: AppIcons.refreshCw,
              tooltip: 'Refresh',
              spinning: _controller.loading,
              onPressed: _controller.refresh,
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              key: const ValueKey('connectors-add-custom'),
              onPressed: () => _addCustom(context),
              icon: const Icon(AppIcons.plus, size: AppIcons.inlineSize),
              label: const Text('Add custom'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            ToolbarPill(
              active: !_connectedOnly,
              onTap: () => setState(() => _connectedOnly = false),
              child: const Text('Browse'),
            ),
            const SizedBox(width: 8),
            ToolbarPill(
              active: _connectedOnly,
              onTap: () => setState(() => _connectedOnly = true),
              child: const Text('Connected'),
            ),
          ],
        ),
        if (!_controller.signedIn) ...[
          const SizedBox(height: 12),
          Text(
            'GitHub, Slack, Google and a few more sign in through your Harness account. Run harness login, then refresh to connect them.',
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
        if (_controller.error != null || _controller.notice.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            _controller.error ?? _controller.notice,
            key: const ValueKey('connectors-notice'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: _controller.error != null ? theme.colorScheme.error : theme.colorScheme.primary,
            ),
          ),
        ],
        // Agents read their tools when they start: one already running gets a connection made since
        // only on a restart. Always here, for the focused pane's harness: Settings closes onto that
        // pane, and the restart runs there, where it can be watched.
        if (_controller.focusedRestartable case final target?) ...[
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: Text(
                  'Restart "${target.agent.displayName}" to use the new tools from your connectors.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              OutlinedButton.icon(
                key: const ValueKey('connectors-restart'),
                icon: const Icon(AppIcons.rotateCw, size: AppIcons.inlineSize),
                label: const Text('Restart'),
                onPressed: () {
                  final navigator = Navigator.of(context);
                  navigator.pop();
                  unawaited(
                    restartHarness(
                      navigator.context,
                      widget.notifier,
                      target.machineId,
                      target.agent.id,
                    ),
                  );
                },
              ),
            ],
          ),
        ],
        const SizedBox(height: 8),
        Expanded(
          child: _controller.cards.isEmpty && _controller.loading
              ? const Center(child: Text('Loading connectors…'))
              : LaidOutListView(
                  children: [
                    _group(context, 'Connected', on,
                        query.isEmpty ? 'Nothing connected yet. Choose a service below.' : 'No connected service matches.'),
                    if (!_connectedOnly) _group(context, 'Available', off, 'No service matches.'),
                  ],
                ),
        ),
      ],
    );
  }

  Widget _group(BuildContext context, String title, List<ConnectorCard> cards, String empty) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${title.toUpperCase()}  ${cards.length}',
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              letterSpacing: 1,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          if (cards.isEmpty)
            Text(empty, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))
          else
            LayoutBuilder(
              builder: (context, box) {
                final columns = (box.maxWidth / 300).floor().clamp(1, 4);
                final width = (box.maxWidth - (columns - 1) * 12) / columns;
                return Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    for (final card in cards)
                      SizedBox(width: width, child: _ConnectorTile(
                        card: card,
                        waiting: _controller.pending.contains(card.code),
                        ways: _controller.hasWays(card.code) ? _ways(card) : null,
                        onConnect: _controller.hasWays(card.code)
                            ? () => _chooseWay(context, card)
                            : () => _controller.connect(card),
                        onDisconnect: () => _confirmDisconnect(context, card),
                      )),
                  ],
                );
              },
            ),
        ],
      ),
    );
  }

  Future<void> _confirmDisconnect(BuildContext context, ConnectorCard card) async {
    final yes = await showAppDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Disconnect ${card.name}?'),
        content: const Text(
          'Agents on this computer stop using this account. To revoke it everywhere, use the service\'s settings.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Disconnect')),
        ],
      ),
    );
    if (yes == true) await _controller.disconnect(card);
  }

  /// The ways [card] is connected, as the chips on its tile: Harness's own, then each engine's.
  List<_Way> _ways(ConnectorCard card) => [
    for (final engine in const ['claude', 'codex'])
      if (_controller.engines.contains(engine))
        if (_controller.via[card.code]?[engine] case final state?
            when state != 'not_connected')
          _Way(ConnectorsController.engineName(engine), state),
    if (card.connected) _Way('Harness', card.state),
  ];

  Future<void> _chooseWay(BuildContext context, ConnectorCard card) =>
      showAppDialog<void>(
        context: context,
        builder: (context) => _ChooseWayDialog(
          controller: _controller,
          code: card.code,
          onHarness: () => _controller.connect(card),
          onHarnessOff: () => _confirmDisconnect(context, card),
        ),
      );

  Future<void> _addCustom(BuildContext context) => showAppDialog<void>(
    context: context,
    builder: (context) => _AddCustomDialog(controller: _controller),
  );
}

/// One service: its icon and name, Signed in (or Reconnect), Connect or
/// Disconnect, and what it gives the agents.
class _ConnectorTile extends StatelessWidget {
  const _ConnectorTile({
    required this.card,
    required this.waiting,
    required this.onConnect,
    required this.onDisconnect,
    this.ways,
  });

  final ConnectorCard card;
  final bool waiting;
  final VoidCallback onConnect;
  final VoidCallback onDisconnect;

  /// Set for a service that also connects through Claude Code or Codex: the ways it is connected now, as chips, and
  /// [onConnect] opens the choice of ways instead of signing in through Harness.
  final List<_Way>? ways;

  @override
  Widget build(BuildContext context) {
    final ways = this.ways;
    if (ways != null) return _withWays(context, ways);
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final connected = card.state == 'connected';
    Widget badge(String text, Color color) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(6)),
      child: Text(text, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: color)),
    );
    final about = connected && !card.tools
        ? '${card.description} Agents use it with harness connections call.'
        : card.description;
    return Container(
      key: ValueKey('connector-${card.code}'),
      constraints: const BoxConstraints(minHeight: 112),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppPalette.cardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ConnectorMark(code: card.code, name: card.name),
              const SizedBox(width: 10),
              // The name and its badge take the row; the action keeps to the right edge.
              Expanded(
                child: Row(
                  children: [
                    Flexible(
                      child: Text(card.name, overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                    ),
                    if (connected) ...[
                      const SizedBox(width: 8),
                      Flexible(child: badge(card.account.isEmpty ? 'Signed in' : card.account, theme.colorScheme.primary)),
                    ],
                    if (card.state == 'reconnect') ...[
                      const SizedBox(width: 8),
                      badge('Reconnect', Colors.amber),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (waiting)
                Text('Waiting for sign-in…', style: theme.textTheme.labelSmall?.copyWith(color: muted))
              else if (card.connected) ...[
                if (card.state == 'reconnect' && !card.custom)
                  TextButton(onPressed: onConnect, child: const Text('Reconnect')),
                AppIconButton(icon: AppIcons.unplug, tooltip: 'Disconnect ${card.name}', onPressed: onDisconnect),
              ] else if (card.reason.isNotEmpty) ...[
                Flexible(child: Text(card.reason, textAlign: TextAlign.right,
                    style: theme.textTheme.labelSmall?.copyWith(color: muted))),
                const SizedBox(width: 6),
                AppIconButton(icon: AppIcons.plus, tooltip: card.reason, onPressed: null),
              ] else
                AppIconButton(icon: AppIcons.plus, tooltip: 'Connect ${card.name}', onPressed: onConnect),
            ],
          ),
          const SizedBox(height: 10),
          Text(about, maxLines: 2, overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: muted)),
        ],
      ),
    );
  }
}

extension on _ConnectorTile {
  /// The tile of a service with more than one way in: which ways it is connected by, and Manage (or +) for the rest.
  Widget _withWays(BuildContext context, List<_Way> ways) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    return Container(
      key: ValueKey('connector-${card.code}'),
      constraints: const BoxConstraints(minHeight: 112),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppPalette.cardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ConnectorMark(code: card.code, name: card.name),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  card.name,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 8),
              if (waiting)
                Text('Waiting for sign-in…', style: theme.textTheme.labelSmall?.copyWith(color: muted))
              else if (ways.isEmpty)
                AppIconButton(
                  key: ValueKey('connector-choose-${card.code}'),
                  icon: AppIcons.plus,
                  tooltip: 'Connect ${card.name}',
                  onPressed: onConnect,
                )
              else
                TextButton(
                  key: ValueKey('connector-choose-${card.code}'),
                  onPressed: onConnect,
                  child: const Text('Manage'),
                ),
            ],
          ),
          if (ways.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [for (final way in ways) _WayChip(way: way)],
            ),
          ],
          const SizedBox(height: 10),
          Text(
            card.description,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
        ],
      ),
    );
  }
}

/// One way a service is connected: who holds it ("Claude", "Codex", "Harness") and its state.
@immutable
class _Way {
  const _Way(this.who, this.state);

  final String who;

  /// `connected`, `reconnect`, or `installed` (Codex: the Google sign-in comes on first use).
  final String state;
}

class _WayChip extends StatelessWidget {
  const _WayChip({required this.way});

  final _Way way;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final again = way.state == 'reconnect';
    final color = again ? Colors.amber : theme.colorScheme.primary;
    final text = switch (way.state) {
      'reconnect' => '${way.who} · Reconnect',
      'installed' => '✓ ${way.who} · sign-in on first use',
      _ => '✓ ${way.who}',
    };
    return Container(
      key: ValueKey('connector-way-${way.who.toLowerCase()}'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(6)),
      child: Text(text, style: theme.textTheme.labelSmall?.copyWith(color: color)),
    );
  }
}

/// Gmail, Calendar or Drive: connect it through Harness, or through Claude Code's or Codex's own account on that
/// computer, each with what it lets an agent do and which agents get it. Only the engines that computer has are offered.
class _ChooseWayDialog extends StatelessWidget {
  const _ChooseWayDialog({
    required this.controller,
    required this.code,
    required this.onHarness,
    required this.onHarnessOff,
  });

  final ConnectorsController controller;
  final String code;
  final VoidCallback onHarness;
  final VoidCallback onHarnessOff;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final theme = Theme.of(context);
      final muted = theme.colorScheme.onSurfaceVariant;
      final card = controller.shownCards.firstWhere((c) => c.code == code);
      final scopes = controller.scopes[code] ?? const {};
      Widget row({
        required String key,
        required String title,
        required String scope,
        required String who,
        String? note,
        required String state,
        required bool waiting,
        required VoidCallback? onConnect,
        required VoidCallback onRemove,
        String? unavailable,
      }) {
        final on = state != 'not_connected';
        final status = switch (state) {
          'connected' => '✓ Connected',
          'installed' => '✓ Installed',
          'reconnect' => 'Needs sign-in again',
          _ => null,
        };
        return Padding(
          key: ValueKey('connector-way-row-$key'),
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                        if (status != null) ...[
                          const SizedBox(width: 8),
                          Text(
                            status,
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: state == 'reconnect' ? Colors.amber : theme.colorScheme.primary,
                            ),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(scope, style: theme.textTheme.bodySmall),
                    const SizedBox(height: 2),
                    Text(who, style: theme.textTheme.bodySmall?.copyWith(color: muted)),
                    if (note != null) ...[
                      const SizedBox(height: 2),
                      Text(note, style: theme.textTheme.bodySmall?.copyWith(color: muted)),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 12),
              if (waiting)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text('Working…', style: theme.textTheme.labelSmall?.copyWith(color: muted)),
                )
              else if (unavailable != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(unavailable, style: theme.textTheme.labelSmall?.copyWith(color: muted)),
                )
              else if (on && state != 'reconnect')
                TextButton(
                  key: ValueKey('connector-way-remove-$key'),
                  onPressed: onRemove,
                  child: const Text('Remove'),
                )
              else
                FilledButton(
                  key: ValueKey('connector-way-connect-$key'),
                  onPressed: onConnect,
                  child: Text(state == 'reconnect' ? 'Reconnect' : 'Connect'),
                ),
            ],
          ),
        );
      }

      final engines = [
        for (final engine in const ['claude', 'codex'])
          if (controller.engines.contains(engine)) engine,
      ];
      return AlertDialog(
        title: Text('Connect ${card.name}'),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final engine in engines) ...[
                  row(
                    key: engine,
                    title: ConnectorsController.engineName(engine),
                    scope: scopes[engine] ?? '',
                    who: engine == 'claude'
                        ? 'Claude Code only · via claude.ai'
                        : 'Codex only · via ChatGPT',
                    state: controller.via[code]?[engine] ?? 'not_connected',
                    waiting: controller.pending.contains('$code:$engine'),
                    onConnect: () => controller.connectVia(card, engine),
                    onRemove: () => controller.disconnectVia(card, engine),
                  ),
                  Divider(height: 1, color: AppPalette.divider),
                ],
                // Not for a service only an engine connects (Microsoft 365).
                if (controller.harnessWay(code))
                  row(
                    key: 'harness',
                    title: 'Harness',
                    // A daemon from before the short scopes: the service's own description.
                    scope: scopes['harness'] ?? card.description,
                    who: 'All agents · via Harness',
                    state: card.state,
                    waiting: controller.pending.contains(code),
                    unavailable: card.connected || card.reason.isEmpty ? null : card.reason,
                    onConnect: onHarness,
                    onRemove: onHarnessOff,
                  ),
                const SizedBox(height: 12),
                Text(
                  'Company account? Your admin may need to allow it.',
                  style: theme.textTheme.bodySmall?.copyWith(color: muted),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Done')),
        ],
      );
    },
  );
}

/// A service's icon, bundled with the app (assets/connector-icons), or its
/// initial when it has none (a custom server).
class ConnectorMark extends StatelessWidget {
  const ConnectorMark({super.key, required this.code, required this.name, this.size = 26});

  final String code;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final path = connectorIcons[code];
    final Widget mark;
    if (path == null) {
      mark = Center(
        child: Text(name.isEmpty ? '?' : name.characters.first.toUpperCase(),
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: size * 0.5, color: Colors.white)),
      );
    } else if (path.endsWith('.svg')) {
      mark = SvgPicture.asset(path, fit: BoxFit.contain);
    } else {
      mark = Image.asset(path, fit: BoxFit.contain);
    }
    return Container(
      width: size,
      height: size,
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: path == null ? AppPalette.accentMuted : AppPalette.cardBgHover,
        borderRadius: BorderRadius.circular(6),
      ),
      child: mark,
    );
  }
}

class _AddCustomDialog extends StatefulWidget {
  const _AddCustomDialog({required this.controller});
  final ConnectorsController controller;

  @override
  State<_AddCustomDialog> createState() => _AddCustomDialogState();
}

class _AddCustomDialogState extends State<_AddCustomDialog> {
  final _name = TextEditingController();
  final _url = TextEditingController();
  final _headers = TextEditingController();
  String? _error;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _headers.dispose();
    super.dispose();
  }

  Map<String, String>? _parsedHeaders() {
    final result = <String, String>{};
    for (final line in _headers.text.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty)) {
      final at = line.indexOf(':');
      if (at < 1) return null;
      result[line.substring(0, at).trim()] = line.substring(at + 1).trim();
    }
    return result;
  }

  Future<void> _save() async {
    final headers = _parsedHeaders();
    if (headers == null) {
      setState(() => _error = 'Write each header as Name: value.');
      return;
    }
    setState(() { _saving = true; _error = null; });
    final error = await widget.controller.addCustom(_name.text.trim(), _url.text.trim(), headers);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
    } else {
      setState(() { _saving = false; _error = error; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: const Text('Add custom'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('A remote MCP server. If it asks you to sign in, Harness opens its sign-in page.',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
            const SizedBox(height: 16),
            TextField(key: const ValueKey('custom-name'), controller: _name, decoration: const InputDecoration(labelText: 'Name')),
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('custom-url'),
              controller: _url,
              decoration: const InputDecoration(labelText: 'Remote MCP server URL', hintText: 'https://example.com/mcp'),
            ),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text('Advanced', style: theme.textTheme.bodySmall),
              children: [
                TextField(
                  controller: _headers,
                  minLines: 2,
                  maxLines: 4,
                  decoration: const InputDecoration(
                    labelText: 'Headers (Name: value, one per line)',
                    hintText: 'Authorization: Bearer …',
                  ),
                ),
              ],
            ),
            if (_error != null) Text(_error!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: _saving ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Continue')),
      ],
    );
  }
}
