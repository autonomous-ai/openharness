import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/dsh_catalog.dart';
import '../core/test_run.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/engine_identity.dart';

/// The body of a store page: what you ask, and what comes out — one after another, down the page.
///
/// Nothing competes with the examples. Each is a prompt set large and centred, the button that
/// tries it, a thread of light, and the real output at full width with one quiet line naming it.
/// The next follows after a breath of space; a person scrolls through what the harness does rather
/// than reading about it. An example without a picture (an editorial prompt, before the package
/// ships its own) is the prompt and its button alone.
///
/// Each block rises into place the first time it scrolls into view — unless Reduce Motion is on, or
/// under `flutter test`, where everything is simply there.
class StoreExampleFlow extends StatelessWidget {
  const StoreExampleFlow({
    super.key,
    required this.entry,
    required this.examples,
    this.onTry,
    this.animate,
  });

  final DshEntry entry;
  final List<StoreExample> examples;

  /// Opens New Harness with the prompt as its first message; null when there is nowhere to open it.
  final ValueChanged<String>? onTry;

  /// Rise into view on first sight; defaults to on outside tests.
  final bool? animate;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, example) in examples.indexed) ...[
          if (i > 0) const SizedBox(height: 132),
          _Reveal(
            animate: animate ?? !kUnderTest,
            child: _ExampleBlock(
              key: ValueKey('store-example:$i'),
              index: i,
              count: examples.length,
              entry: entry,
              example: example,
              onTry: onTry,
            ),
          ),
        ],
      ],
    );
  }
}

class _ExampleBlock extends StatefulWidget {
  const _ExampleBlock({
    super.key,
    required this.index,
    required this.count,
    required this.entry,
    required this.example,
    required this.onTry,
  });

  final int index;
  final int count;
  final DshEntry entry;
  final StoreExample example;
  final ValueChanged<String>? onTry;

  @override
  State<_ExampleBlock> createState() => _ExampleBlockState();
}

class _ExampleBlockState extends State<_ExampleBlock> {
  var _hovering = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    final example = widget.example;
    final i = widget.index;
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 820;
        final radius = BorderRadius.circular(wide ? 28 : 18);
        return Column(
          children: [
            Text(
              '${(i + 1).toString().padLeft(2, '0')} / ${widget.count.toString().padLeft(2, '0')}',
              style: grid.AppType.monoMeta(
                letterSpacing: 2,
                color: grid.AppPalette.accentOnSurface,
              ),
            ),
            const SizedBox(height: 20),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 880),
              child: Text(
                '“${example.prompt}”',
                key: ValueKey('store-example-prompt:$i'),
                textAlign: TextAlign.center,
                style: grid.AppType.title(
                  height: 1.24,
                  color: grid.AppPalette.textPrimary,
                ),
              ),
            ),
            const SizedBox(height: 28),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                FilledButton.icon(
                  key: ValueKey('store-try-prompt:$i'),
                  onPressed: widget.onTry == null
                      ? null
                      : () => widget.onTry!(example.prompt),
                  icon: const Icon(LucideIcons.sparkles300, size: 17),
                  label: const Text('Try this prompt'),
                  style: FilledButton.styleFrom(
                    backgroundColor: grid.AppPalette.accent,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, 46),
                    padding: const EdgeInsets.symmetric(horizontal: 22),
                    textStyle: grid.AppType.label(
                      fontWeight: grid.AppFont.semibold,
                    ),
                    shape: const StadiumBorder(),
                  ),
                ),
                const SizedBox(width: 8),
                AppIconButton(
                  key: ValueKey('store-copy-prompt:$i'),
                  icon: LucideIcons.copy300,
                  tooltip: 'Copy prompt',
                  onPressed: () async {
                    await Clipboard.setData(
                      ClipboardData(text: example.prompt),
                    );
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Prompt copied')),
                      );
                    }
                  },
                ),
              ],
            ),
            if (example.image != null) ...[
              // The prompt becoming the thing: a thread of the accent running down into the picture.
              Container(
                width: 1.5,
                height: 64,
                margin: const EdgeInsets.symmetric(vertical: 18),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      grid.AppPalette.accent.withValues(alpha: 0),
                      grid.AppPalette.accent.withValues(alpha: 0.8),
                    ],
                  ),
                ),
              ),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1120),
                child: MouseRegion(
                  onEnter: (_) => setState(() => _hovering = true),
                  onExit: (_) => setState(() => _hovering = false),
                  child: AnimatedScale(
                    scale: _hovering ? 1.012 : 1,
                    duration: const Duration(milliseconds: 420),
                    curve: Curves.easeOutCubic,
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 420),
                      curve: Curves.easeOutCubic,
                      decoration: BoxDecoration(
                        borderRadius: radius,
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(
                              alpha: _hovering ? 0.34 : 0.2,
                            ),
                            blurRadius: _hovering ? 60 : 40,
                            offset: const Offset(0, 24),
                          ),
                        ],
                      ),
                      child: ClipRRect(
                        borderRadius: radius,
                        child: AspectRatio(
                          aspectRatio: 16 / 10,
                          child: ColoredBox(
                            color: const Color(0xFF111316),
                            child: _Output(
                              key: ValueKey('store-example-image:$i'),
                              entry: widget.entry,
                              example: example,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (example.caption != null) ...[
                const SizedBox(height: 22),
                Text(
                  example.caption!,
                  textAlign: TextAlign.center,
                  style: grid.AppType.body(
                    height: 1.4,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ],
            ],
          ],
        );
      },
    );
  }
}

class _Output extends StatelessWidget {
  const _Output({super.key, required this.entry, required this.example});
  final DshEntry entry;
  final StoreExample example;

  @override
  Widget build(BuildContext context) {
    final placeholder = Center(
      child: Opacity(
        opacity: 0.5,
        child: EngineMark(engine: entry.id, displayName: entry.name, size: 72),
      ),
    );
    return Image.network(
      example.image!,
      fit: BoxFit.cover,
      filterQuality: FilterQuality.medium,
      semanticLabel: example.caption ?? 'What ${entry.name} made',
      frameBuilder: (context, child, frame, synchronous) => synchronous
          ? child
          : AnimatedOpacity(
              opacity: frame == null ? 0 : 1,
              duration: const Duration(milliseconds: 500),
              curve: Curves.easeOut,
              child: child,
            ),
      loadingBuilder: (context, child, progress) =>
          progress == null ? child : placeholder,
      errorBuilder: (_, _, _) => placeholder,
    );
  }
}

/// Rises into place the first time any of it is on screen, and stays.
class _Reveal extends StatefulWidget {
  const _Reveal({required this.animate, required this.child});
  final bool animate;
  final Widget child;

  @override
  State<_Reveal> createState() => _RevealState();
}

class _RevealState extends State<_Reveal> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 700),
  );
  ScrollPosition? _position;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (!widget.animate || still) {
      _controller.value = 1;
      return;
    }
    final position = Scrollable.maybeOf(context)?.position;
    if (position != _position) {
      _position?.removeListener(_check);
      _position = position?..addListener(_check);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _check());
  }

  /// Starts the rise once the block's top edge is inside the viewport.
  void _check() {
    if (!mounted || _controller.value > 0 || _controller.isAnimating) return;
    final box = context.findRenderObject() as RenderBox?;
    final scrollable = Scrollable.maybeOf(context);
    final viewport = scrollable?.context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize || viewport == null || !viewport.hasSize) {
      _controller.forward();
      return;
    }
    final top = box.localToGlobal(Offset.zero, ancestor: viewport).dy;
    if (top < viewport.size.height * 0.9) {
      _position?.removeListener(_check);
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _position?.removeListener(_check);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final t = Curves.easeOutCubic.transform(_controller.value);
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, 36 * (1 - t)),
            child: child,
          ),
        );
      },
      child: widget.child,
    );
  }
}
