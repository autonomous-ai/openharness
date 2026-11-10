import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'channel_feed.dart';

/// Keeps a channel's [feed] reading while the channel is on screen and the app is in front, and not otherwise: it is the one
/// place that decides it, so a channel left, a tab behind another and a minimised window each ask GitHub for nothing. [foreground]
/// says whether the app is in front; without it (a build that is not told) it is.
class SwarmFeedPulse extends StatefulWidget {
  const SwarmFeedPulse({super.key, required this.feed, this.foreground});

  final SwarmChannelFeed feed;
  final ValueListenable<bool>? foreground;

  @override
  State<SwarmFeedPulse> createState() => _SwarmFeedPulseState();
}

class _SwarmFeedPulseState extends State<SwarmFeedPulse> {
  var _shown = true;

  @override
  void initState() {
    super.initState();
    widget.foreground?.addListener(_sync);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // A page that is not the one showing has its tickers muted ([SuperTabPages]).
    _shown = TickerMode.valuesOf(context).enabled;
    _sync();
  }

  @override
  void didUpdateWidget(SwarmFeedPulse old) {
    super.didUpdateWidget(old);
    if (old.foreground != widget.foreground) {
      old.foreground?.removeListener(_sync);
      widget.foreground?.addListener(_sync);
    }
    if (old.feed != widget.feed) old.feed.active = false;
    _sync();
  }

  void _sync() =>
      widget.feed.active = _shown && (widget.foreground?.value ?? true);

  @override
  void dispose() {
    widget.foreground?.removeListener(_sync);
    widget.feed.active = false;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

/// What stops the feed, in one quiet line over the channel's rows with its retry: "Install the GitHub CLI (gh) to see what your
/// agents do on GitHub.", "Sign in to GitHub: run gh auth login.", "GitHub is limiting requests. Reading again at 14:20." A
/// feed that reads says nothing.
class SwarmFeedState extends StatelessWidget {
  const SwarmFeedState({super.key, required this.feed});

  final SwarmChannelFeed feed;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: feed,
    builder: (context, _) {
      final error = feed.error;
      if (error == null) return const SizedBox.shrink();
      final again = feed.retryAt;
      final words = again == null
          ? error
          : '$error Reading again at ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(again.toLocal()))}.';
      return Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: grid.AppDesktop.panelPadding,
          vertical: grid.AppDesktop.controlGap,
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                words,
                key: const ValueKey('swarm-feed-state'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(),
              ),
            ),
            AppIconButton(
              key: const ValueKey('swarm-feed-retry'),
              icon: AppIcons.refreshCw,
              tooltip: 'Try again',
              onPressed: () => unawaited(feed.read(all: true)),
            ),
          ],
        ),
      );
    },
  );
}

/// The row among a channel's where the lists of GitHub have not been read further back ([SwarmChannelFeed.horizon]). The channel
/// reads the next page as the top comes near, as it reads its own older pages; where the row stands among the channel's own older
/// posts, above which no card is drawn, it is Show earlier, which reads it. While a page is read it is a small spinner.
class SwarmFeedEarlier extends StatelessWidget {
  const SwarmFeedEarlier({super.key, required this.feed});

  final SwarmChannelFeed feed;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: feed,
    builder: (context, _) => SizedBox(
      key: const ValueKey('swarm-feed-earlier'),
      height: 40,
      child: Center(
        child: feed.loadingMore
            ? const SizedBox.square(
                key: ValueKey('swarm-feed-earlier-loading'),
                dimension: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : TextButton(
                onPressed: () => unawaited(feed.more()),
                child: const Text('Show earlier'),
              ),
      ),
    ),
  );
}
