import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;
import 'package:harness_mobile/usage/usage_accounts.dart';
import 'package:harness_mobile/usage/usage_controller.dart';
import 'package:harness_mobile/usage/usage_pressure.dart';
import 'package:harness_mobile/usage/usage_window.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'phone_card.dart';
import 'phone_header.dart';

/// The last figure this page resolved, so the Settings row that opens it can
/// print something rather than a dash every single time.
///
/// ⚠️ **A cache, deliberately, and not a second poller.** That row is one line
/// in a list; giving it a [UsageController] of its own would put a minute-ly
/// relay round trip behind a screen whose whole job is to OFFER the screen that
/// already does that — two pollers asking the same machines the same question,
/// and a phone spending radio on a figure nobody asked to see. So the row shows
/// what this page last measured, and this page is where a fresh reading is
/// taken.
///
/// In memory only: a display convenience rather than a fact worth keeping
/// across launches, and a figure restored from disk would be printed with no
/// way to say how old it is.
final ValueNotifier<String?> lastUsageSummary = ValueNotifier<String?>(null);

/// What the agent accounts have spent, as a phone page.
///
/// ⚠️ **Deliberately NOT the desktop's layout.** There the same numbers live in
/// a 26px strip along the window's bottom edge with a hover panel behind it:
/// furniture you read on the way past, expanded by a pointer that a phone does
/// not have. A phone has no rail to put it on and no hover to open it with, so
/// this is a page — reached from Settings ▸ Usage — and the strip's one-figure
/// rule becomes the card's headline while the panel's every-window detail
/// becomes what the card expands to on a tap.
///
/// ⚠️ **Every figure here belongs to a REMOTE machine.** A phone holds no agent
/// CLI and no `claude login`, so [UsageController] reads no local source at all
/// — see its class comment. That is why each card names the machine it was read
/// on rather than treating an unlabelled figure as "mine" the way the desktop
/// does: on a phone there is no "mine".
class UsagePage extends StatefulWidget {
  const UsagePage({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<UsagePage> createState() => _UsagePageState();
}

class _UsagePageState extends State<UsagePage> {
  /// Owned by the page rather than by the app, which is the opposite of the
  /// desktop's choice and right for the opposite reason. There the rail
  /// unmounts whenever the sidebar folds, so a poller living in it would
  /// restart on every unfold; here the page is a pushed route that exists only
  /// while somebody is looking at it, and a minute-ly poll that outlived it
  /// would be a phone spending radio on a screen nobody has open.
  ///
  /// The timer dies with [dispose], so nothing leaks when the page pops.
  late final UsageController _usage = UsageController(
    remote: widget.notifier.readRemoteUsage,
  );

  @override
  void initState() {
    super.initState();
    _usage.addListener(_rememberSummary);
  }

  @override
  void dispose() {
    _usage.removeListener(_rememberSummary);
    _usage.dispose();
    super.dispose();
  }

  /// Hands the Settings row the figure this cycle came to.
  ///
  /// Only once a cycle has actually LANDED: a controller still on its first
  /// round trip would otherwise clear a perfectly good figure from the row
  /// behind this page the moment the page opened, and the reader would watch it
  /// blank and come back.
  void _rememberSummary() {
    if (!_usage.hasAnswer) return;
    lastUsageSummary.value = usageSummaryLabel(_usage.accounts);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            PhoneHeader(
              title: 'Usage',
              subtitle: Text(
                'What your agent accounts have spent',
                style: TextStyle(color: AppPalette.textSecondary, fontSize: 13),
              ),
            ),
            Expanded(
              child: ListenableBuilder(
                listenable: _usage,
                builder: (context, _) => _Body(usage: _usage),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.usage});

  final UsageController usage;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // Blank at the size of the answer, and only before the FIRST one: once
    // figures exist they stay through every refresh rather than flicking back
    // to skeletons once a minute.
    if (usage.loading && !usage.hasAnswer) {
      return const PhoneListSkeleton(rows: 2);
    }
    final accounts = [
      for (final account in usage.accounts)
        if (account.reading.hasFigures) account,
    ];
    if (accounts.isEmpty) {
      // ⚠️ Three different silences, drawn three different ways — the whole
      // point of keeping [UsageStatus.signedOut] apart from [UsageStatus.failed]
      // upstream. Retrying fixes one, signing in on the machine fixes another,
      // and linking a machine at all fixes the third; one shared "no data"
      // screen would send every reader down the wrong path two times in three.
      return RefreshIndicator(
        onRefresh: usage.refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: phoneListPadding(context),
          children: [
            SizedBox(height: MediaQuery.sizeOf(context).height * 0.18),
            _EmptyUsage(usage: usage),
          ],
        ),
      );
    }
    return PhoneCardList(
      onRefresh: usage.refresh,
      itemCount: accounts.length,
      itemBuilder: (context, index) {
        final account = accounts[index];
        return _AccountCard(
          // Keyed by the ACCOUNT rather than by its position, because
          // `_AccountCard` carries the one piece of state on this page — whether
          // it is expanded — and the order can change under it: a machine that
          // finishes connecting adds an account mid-session, and an unkeyed
          // stateful row would hand its open/closed state to whichever account
          // slid into its index.
          key: ValueKey(
            '${account.provider.name}:${account.machines.join(',')}',
          ),
          account: account,
        );
      },
    );
  }
}

/// Why there are no figures, in the reader's own terms.
///
/// The order matters: a machine that ANSWERED with "sign in" has told us
/// something specific about itself and outranks the generic failure beside it,
/// because it names the one action that would actually help. A page with no
/// machines at all never reaches either sentence.
class _EmptyUsage extends StatelessWidget {
  const _EmptyUsage({required this.usage});

  final UsageController usage;

  @override
  Widget build(BuildContext context) {
    final readings = [
      for (final machine in usage.machines) ...machine.readings,
    ];
    if (readings.isEmpty) {
      // Nothing answered at all. On a phone that is almost always the same
      // thing as "no machine is linked and connected yet", which is the action
      // worth naming — a Retry here would retry a question nobody was asked.
      return EmptyState(
        icon: LucideIcons.monitorSmartphone300,
        title: 'No usage data',
        message: usage.stale
            ? 'The machines you linked did not answer this time. Pull down to try again.'
            : 'Link a machine and connect to it — usage is read on the machine '
                  'your agents run on, not on this phone.',
      );
    }
    final signedOut = [
      for (final reading in readings)
        if (reading.status == UsageStatus.signedOut) reading,
    ];
    if (signedOut.isNotEmpty) {
      return EmptyState(
        icon: LucideIcons.logIn300,
        title: 'Not signed in',
        message:
            '${_providers(signedOut)} on your linked machines have no session '
            'to read. Sign in there with the agent CLI — this phone cannot do '
            'it for them.',
      );
    }
    final failed = [
      for (final reading in readings)
        if (reading.status == UsageStatus.failed) reading,
    ];
    if (failed.isNotEmpty) {
      return EmptyState(
        icon: LucideIcons.triangleAlert300,
        title: 'Could not read usage',
        // The machine's own sentence when there is exactly one, because it is
        // the side that knows what went wrong; past that a list of them would
        // be longer than the screen.
        message: failed.length == 1
            ? (failed.first.message ?? 'Pull down to try again.')
            : '${_providers(failed)} did not answer. Pull down to try again.',
      );
    }
    return const EmptyState(
      icon: LucideIcons.chartNoAxesColumn300,
      title: 'No usage to show',
      message: 'The machines that answered reported no rate-limit windows.',
    );
  }

  /// The providers named once each, in [UsageProvider] order — two machines
  /// signed out of the same account are one sentence, not two.
  static String _providers(List<ProviderUsage> readings) {
    final seen = <UsageProvider>{for (final reading in readings) reading.provider};
    final labels = [
      for (final provider in UsageProvider.values)
        if (seen.contains(provider)) provider.label,
    ];
    if (labels.isEmpty) return 'Your accounts';
    if (labels.length == 1) return labels.single;
    return '${labels.take(labels.length - 1).join(', ')} and ${labels.last}';
  }
}

/// One account: its provider, where it was read, its weekly figure — and, once
/// expanded, every window it reports.
///
/// Expanding in place rather than pushing a page of its own: an account has at
/// most three windows, which is less than a page's worth of anything, and the
/// comparison a reader came for is between the accounts rather than inside one.
class _AccountCard extends StatefulWidget {
  const _AccountCard({super.key, required this.account});

  final UsageAccount account;

  @override
  State<_AccountCard> createState() => _AccountCardState();
}

class _AccountCardState extends State<_AccountCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final reading = widget.account.reading;
    // ⚠️ ONE window in the headline — the weekly one, never all of them. See
    // [ProviderUsage.railWindow]: Claude reports three and Codex one, so a
    // headline showing every window would make one account three figures tall
    // and the other one, two cards that read as different KINDS of thing.
    final headline = reading.railWindow;
    final colour = engineIdentity(reading.provider.engineId).color;
    // Every window BUT the headline is what expanding adds; a card whose
    // provider reports only the one has nothing to expand and says so by not
    // offering the chevron at all.
    final expandable = reading.windows.length > 1;
    return Container(
      decoration: BoxDecoration(
        color: AppGlass.rowFill,
        borderRadius: BorderRadius.circular(AppCard.radius),
        border: Border.all(color: AppGlass.hair),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppCard.radius),
          onTap: expandable ? () => setState(() => _expanded = !_expanded) : null,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _CardHeader(
                  account: widget.account,
                  expandable: expandable,
                  expanded: _expanded,
                ),
                if (headline != null) ...[
                  const SizedBox(height: 12),
                  _WindowRow(window: headline, color: colour),
                ],
                if (_expanded)
                  for (final window in reading.windows)
                    if (!identical(window, headline)) ...[
                      const SizedBox(height: 14),
                      _WindowRow(window: window, color: colour),
                    ],
                if (reading.fetchedAt != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    _freshness(reading.fetchedAt!),
                    style: TextStyle(
                      color: AppPalette.textFaint,
                      fontSize: 11.5,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// How long ago the figures were read, at the granularity the poll actually
  /// has. Anything finer would be a precision the once-a-minute refresh behind
  /// it cannot back up.
  static String _freshness(DateTime at) {
    final since = DateTime.now().difference(at);
    if (since.inMinutes < 1) return 'Updated just now';
    if (since.inMinutes < 60) return 'Updated ${since.inMinutes}m ago';
    return 'Updated ${since.inHours}h ago';
  }
}

class _CardHeader extends StatelessWidget {
  const _CardHeader({
    required this.account,
    required this.expandable,
    required this.expanded,
  });

  final UsageAccount account;
  final bool expandable;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final machines = account.machines;
    return Row(
      children: [
        // The mark the agent list already draws beside every agent of this
        // engine — the account's own logo, in its own colour. A second glyph
        // here would make one account look like two things.
        EngineMark(engine: account.provider.engineId, size: 16),
        const SizedBox(width: 9),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                account.provider.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppPalette.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
              // WHERE this was read. Unlike the desktop, which leaves its own
              // computer's figure unlabelled because that is the one a person
              // reads as "mine", every figure on a phone was read somewhere
              // else — so every figure says where, and an account shared by
              // several machines names them all rather than picking one.
              if (machines.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  machines.join(', '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 12.5,
                  ),
                ),
              ],
            ],
          ),
        ),
        if (expandable)
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: AnimatedRotation(
              turns: expanded ? 0.5 : 0,
              duration: AppMotion.press,
              curve: AppMotion.curve,
              child: Icon(
                LucideIcons.chevronDown300,
                size: 20,
                color: AppPalette.textFaint,
              ),
            ),
          ),
      ],
    );
  }
}

/// One window: what it is, how full it is, and when it empties.
class _WindowRow extends StatelessWidget {
  const _WindowRow({required this.window, required this.color});

  final UsageWindow window;

  /// The account's own colour, so the bar and the mark at the top of the card
  /// are visibly the same account's.
  final Color color;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final resetsIn = window.resetsInLabel();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                window.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppPalette.textSecondary,
                  fontSize: 12.5,
                  fontWeight: AppFont.medium,
                ),
              ),
            ),
            Text(
              '${window.usedPercent.round()}% used',
              style: TextStyle(
                // Amber past 80, red past 90. The figure is exact either way,
                // so the colour is not carrying the number — it is carrying the
                // moment the number starts to matter.
                color: usagePressureInk(window.pressure, AppPalette.textPrimary),
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                fontFeatures: AppFont.tabularFigures,
              ),
            ),
          ],
        ),
        const SizedBox(height: 7),
        UsageBar(usedPercent: window.usedPercent, color: color),
        // No reset time means no countdown — never "resets in 0m", which would
        // read as a measurement rather than as the silence it is.
        if (resetsIn != null) ...[
          const SizedBox(height: 6),
          Text(
            'Resets in $resetsIn',
            style: TextStyle(color: AppPalette.textFaint, fontSize: 11.5),
          ),
        ],
      ],
    );
  }
}

/// The colour a nearly-spent window is drawn in, over the [UsagePressure.calm]
/// colour it wears the rest of the time.
///
/// One function for the figure and the bar under it, so a window cannot be
/// amber in one and plain in the other.
///
/// ⚠️ [AppColors.danger] rather than `AppPalette.dangerFill`: this is ink on a
/// surface, and the fill is tuned to carry white lettering ON it.
Color usagePressureInk(UsagePressure pressure, Color calm) =>
    switch (pressure) {
      UsagePressure.calm => calm,
      UsagePressure.warn => AppPalette.warn,
      UsagePressure.critical => AppColors.danger,
    };

/// How full one window is.
///
/// Drawn 6px and fully rounded, in the **account's own colour** — the same
/// colour as the mark at the head of the card. Turns amber past
/// [kUsageWarnPercent] and red past [kUsageCriticalPercent], from the same
/// [usagePressureOf] the figure above it uses: a bar that changed hue at a
/// different number would make one window look like two readings.
class UsageBar extends StatelessWidget {
  const UsageBar({
    super.key,
    required this.usedPercent,
    required this.color,
    this.height = 6,
  });

  final double usedPercent;

  /// The account's colour. Overridden once the window is nearly spent, because
  /// "which account" matters less at that point than "how close".
  final Color color;

  final double height;

  /// The narrowest the filled part may be drawn.
  ///
  /// Below this a band of colour reads as a rendering artefact rather than a
  /// quantity, so a small percentage is over-represented on purpose. A window
  /// at 2% is *not* a window at 0%, and the bar has to be able to say so — the
  /// exact figure is printed right above it, so nothing is lost by rounding up.
  static const double _minFill = 4;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final fill = usagePressureInk(usagePressureOf(usedPercent), color);
    return ClipRRect(
      borderRadius: BorderRadius.circular(height / 2),
      child: SizedBox(
        height: height,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final full = constraints.maxWidth;
            final measured = full * (usedPercent / 100).clamp(0.0, 1.0);
            // Zero stays zero: an untouched window draws no colour at all, or
            // the bar would claim usage nobody has spent.
            final width = measured <= 0
                ? 0.0
                : measured.clamp(_minFill, full).toDouble();
            // BOTH children are positioned, deliberately. A Stack takes its
            // size from its non-positioned children, so an unpositioned fill
            // would drag the track in to the fill's own width — the right
            // length in the wrong colour.
            return Stack(
              children: [
                Positioned.fill(child: ColoredBox(color: AppSurface.recess)),
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: width,
                  child: ColoredBox(color: fill),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// The summary a settings row prints for the whole page — the tightest weekly
/// figure across every account, because the one worth a glance from a list of
/// rows is the account closest to running out.
///
/// Null when there is nothing to summarise, which the row draws as `—` rather
/// than as a zero it never measured.
String? usageSummaryLabel(List<UsageAccount> accounts) {
  double? worst;
  for (final account in accounts) {
    final window = account.reading.railWindow;
    if (window == null || !account.reading.hasFigures) continue;
    if (worst == null || window.usedPercent > worst) {
      worst = window.usedPercent;
    }
  }
  return worst == null ? null : '${worst.round()}% used';
}
