import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import 'store_collections.dart';
import 'store_demo_dialog.dart';
import 'store_editorial.dart';
import 'store_listing.dart';

/// A permanent way to browse the catalog's recordings, including sessions that
/// arrive after this desktop release. The same cards lead Discover.
class StoreSessions extends StatelessWidget {
  const StoreSessions({
    super.key,
    required this.sessions,
    required this.onOpen,
  });

  final List<StoreSession> sessions;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        key: const PageStorageKey('store-sessions-scroll'),
        padding: EdgeInsets.all(box.maxWidth < 680 ? 20 : 36),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1440),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Featured harnesses',
                  style: grid.AppType.display(
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  sessions.isEmpty
                      ? 'Recorded sessions will appear here when they are available in your catalog.'
                      : '${sessions.length} harnesses to explore. Watch a real session, then try the same prompt.',
                  style: grid.AppType.body(
                    height: 1.5,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
                const SizedBox(height: 24),
                StoreSessionGrid(sessions: sessions, onOpen: onOpen),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class StoreSessionGrid extends StatelessWidget {
  const StoreSessionGrid({
    super.key,
    required this.sessions,
    required this.onOpen,
  });

  final List<StoreSession> sessions;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, box) {
        final scale = grid.appTextScaleOf(context);
        final columns = (box.maxWidth / (300 * scale)).floor().clamp(1, 3);
        final width = (box.maxWidth - (columns - 1) * 20) / columns;
        return Wrap(
          spacing: 20,
          runSpacing: 20,
          children: [
            for (final session in sessions)
              SizedBox(
                width: width,
                child: _SessionCard(
                  key: ValueKey('store-session:${session.entry.id}'),
                  session: session,
                  onOpen: () => onOpen(session.entry.id),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard({super.key, required this.session, required this.onOpen});

  final StoreSession session;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    final (:entry, :example) = session;
    final scale = grid.appTextScaleOf(context);
    final radius = BorderRadius.circular(16);
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: radius,
        border: Border.all(color: grid.AppPalette.divider),
      ),
      child: Material(
        color: grid.AppPalette.panelBg,
        borderRadius: radius,
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              label: 'Watch ${entry.name} recorded session',
              button: true,
              child: AspectRatio(
                aspectRatio: 16 / 10,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    // Use this recording's own poster, never generic cover art.
                    Image.network(
                      example.image!,
                      fit: BoxFit.contain,
                      excludeFromSemantics: true,
                      frameBuilder: (_, child, frame, _) => frame == null
                          ? _PosterFallback(session: session)
                          : child,
                      errorBuilder: (_, _, _) =>
                          _PosterFallback(session: session, failed: true),
                    ),
                    Positioned(
                      left: 12,
                      bottom: 12,
                      child: ExcludeSemantics(
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            color: const Color(0xe6111316),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 8,
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(
                                  LucideIcons.play300,
                                  size: 15,
                                  color: Colors.white,
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  'Watch session',
                                  style: grid.AppType.monoLabel(
                                    color: Colors.white,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    Positioned.fill(
                      child: Material(
                        type: MaterialType.transparency,
                        child: InkWell(
                          key: ValueKey('store-session-watch:${entry.id}'),
                          focusColor: grid.AppPalette.accentOnSurface
                              .withValues(alpha: .20),
                          hoverColor: grid.AppPalette.accentOnSurface
                              .withValues(alpha: .08),
                          onTap: () => showStoreDemo(
                            context,
                            entry: entry,
                            example: example,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      StoreAppIcon(entry: entry, size: 24),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          entry.name,
                          style: grid.AppType.label(
                            color: grid.AppPalette.textPrimary,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          entry.category ?? storeCategoryFor(entry),
                          textAlign: TextAlign.end,
                          style: grid.AppType.monoMeta(
                            color: grid.AppPalette.textFaint,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  SizedBox(
                    height: 60 * scale,
                    child: Text(
                      entry.tagline ??
                          entry.description ??
                          'See what you can make with ${entry.name}.',
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: grid.AppType.heading(
                        height: 1.3,
                        color: grid.AppPalette.textPrimary,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    height: 51 * scale,
                    child: Text(
                      example.caption ?? 'A recorded session. Open the harness for the prompt and more examples.',
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: grid.AppType.body(
                        height: 1.3,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  ),
                  TextButton.icon(
                    key: ValueKey('store-session-open:${entry.id}'),
                    onPressed: onOpen,
                    style: TextButton.styleFrom(
                      foregroundColor: grid.AppPalette.accentOnSurface,
                    ),
                    iconAlignment: IconAlignment.end,
                    icon: const Icon(LucideIcons.arrowRight300, size: 15),
                    label: const Text('Explore harness'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PosterFallback extends StatelessWidget {
  const _PosterFallback({required this.session, this.failed = false});

  final StoreSession session;
  final bool failed;

  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        StoreAppIcon(entry: session.entry, size: 48),
        const SizedBox(height: 12),
        Text(
          failed ? 'Preview unavailable' : 'Recorded session',
          style: grid.AppType.caption(color: grid.AppPalette.textSecondary),
        ),
      ],
    ),
  );
}
