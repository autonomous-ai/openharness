import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import 'setup_hotspot.dart';

/// Intern 3's task dialogs (Set up, Unlock, and each thing done to one that is online) share one
/// frame: a heading, the step's body, a status line beside the actions. A click outside does not
/// close one, since a setup half done leaves the device waiting; Close always does.
Future<T?> showInternDialog<T>(BuildContext context, WidgetBuilder builder) =>
    showAppDialog<T>(
      context: context,
      barrierDismissible: false,
      builder: builder,
    );

class InternDialogFrame extends StatelessWidget {
  const InternDialogFrame({
    super.key,
    required this.title,
    required this.children,
    required this.actions,
    this.message,
    this.error = false,
  });

  final String title;
  final List<Widget> children;
  final List<Widget> actions;

  /// What is happening, or why it stopped ([error]), announced as it changes.
  final String? message;
  final bool error;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final message = this.message;
    return DesktopPromptSurface(
      width: 480,
      body: DesktopPromptScrollBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              header: true,
              child: Text(title, style: DesktopChrome.heading()),
            ),
            const SizedBox(height: 16),
            ...children,
          ],
        ),
      ),
      footer: message == null
          ? null
          : Semantics(
              liveRegion: true,
              child: SelectableText(
                message,
                key: const Key('intern-message'),
                minLines: 1,
                maxLines: 4,
                style: DesktopChrome.control(
                  color: error
                      ? Theme.of(context).colorScheme.error
                      : DesktopChrome.muted,
                ),
              ),
            ),
      actions: actions,
    );
  }
}

/// A dialog's action: quiet by default, [primary] for the step's one way on, [danger] for one
/// that cannot be taken back.
Widget internButton(
  String label,
  VoidCallback? onPressed, {
  Key? key,
  bool primary = false,
  bool danger = false,
}) => primary || danger
    ? FilledButton(
        key: key,
        onPressed: onPressed,
        style: danger ? grid.dangerButtonStyle() : null,
        child: Text(label),
      )
    : TextButton(key: key, onPressed: onPressed, child: Text(label));

/// Where the person is in a setup, on every step, as the phone shows it: each step numbered, a
/// check once done, the current one in the accent; [details] says what each asks, before it starts.
class InternSteps extends StatelessWidget {
  const InternSteps({
    super.key,
    required this.steps,
    required this.current,
    this.details = false,
  });

  /// Each step's name and what it asks of the person.
  final List<(String, String)> steps;

  /// The step the person is on; past the last, every step is done.
  final int current;
  final bool details;

  @override
  Widget build(BuildContext context) {
    final accent = DesktopChrome.accent;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < steps.length; i++)
            Semantics(
              key: Key('intern-step:$i'),
              selected: i == current,
              child: Padding(
                padding: EdgeInsets.symmetric(vertical: details ? 5 : 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox.square(
                      dimension: 20,
                      child: i < current
                          ? Icon(AppIcons.circleCheck, size: 20, color: accent)
                          : DecoratedBox(
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: i == current ? accent : null,
                                border: i == current
                                    ? null
                                    : Border.all(color: DesktopChrome.hint),
                              ),
                              child: Center(
                                child: Text(
                                  '${i + 1}',
                                  style: DesktopChrome.text(
                                    size: 11,
                                    medium: true,
                                    color: i == current
                                        ? DesktopChrome.onSelection
                                        : DesktopChrome.hint,
                                  ),
                                ),
                              ),
                            ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            steps[i].$1,
                            style: DesktopChrome.text(
                              size: 13,
                              medium: i == current,
                              color: i == current
                                  ? DesktopChrome.foreground
                                  : i < current
                                  ? DesktopChrome.muted
                                  : DesktopChrome.hint,
                            ),
                          ),
                          if (details)
                            Text(steps[i].$2, style: DesktopChrome.metadata()),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A wait the person can see moving: it fills over [span], the most the step waits, as the
/// phone's does. Finite, so a wait that ends sooner simply takes it away.
class InternWaitBar extends StatelessWidget {
  const InternWaitBar({super.key, required this.span});

  final Duration span;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: ClipRRect(
      borderRadius: BorderRadius.circular(3),
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: span,
        builder: (context, done, _) => LinearProgressIndicator(
          value: done,
          minHeight: 6,
          color: DesktopChrome.accent,
          backgroundColor: DesktopChrome.accent.withValues(alpha: .18),
        ),
      ),
    ),
  );
}

/// The person says a thing is done that the app cannot see happen (this computer joined the box's
/// Wi-Fi in its own menu): the step's button waits for it. The whole row takes the click.
class InternCheck extends StatelessWidget {
  const InternCheck({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final onChanged = this.onChanged;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: MergeSemantics(
        child: InkWell(
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          onTap: onChanged == null ? null : () => onChanged(!value),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                Checkbox(
                  value: value,
                  onChanged: onChanged == null
                      ? null
                      : (checked) => onChanged(checked == true),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(label, style: DesktopChrome.text(size: 13)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Body copy: a sentence of the step.
class InternText extends StatelessWidget {
  const InternText(this.text, {super.key, this.muted = true});
  final String text;
  final bool muted;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(
      text,
      style: DesktopChrome.text(
        color: muted ? DesktopChrome.muted : DesktopChrome.foreground,
      ),
    ),
  );
}

/// A labelled field: a password (hidden, with its eye) or plain text.
class InternField extends StatefulWidget {
  const InternField({
    super.key,
    required this.label,
    required this.controller,
    this.fieldKey,
    this.hint,
    this.password = false,
    this.autofocus = false,
    this.enabled = true,
    this.maxLength,
    this.onSubmitted,
  });

  final String label;
  final TextEditingController controller;
  final Key? fieldKey;
  final String? hint;
  final bool password, autofocus, enabled;
  final int? maxLength;
  final ValueChanged<String>? onSubmitted;

  @override
  State<InternField> createState() => _InternFieldState();
}

class _InternFieldState extends State<InternField> {
  bool _shown = false;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.label, style: DesktopChrome.control(medium: true)),
        const SizedBox(height: 6),
        TextField(
          key: widget.fieldKey,
          controller: widget.controller,
          autofocus: widget.autofocus,
          enabled: widget.enabled,
          obscureText: widget.password && !_shown,
          enableSuggestions: !widget.password,
          autocorrect: false,
          maxLength: widget.maxLength,
          style: DesktopChrome.text(size: 13),
          textAlignVertical: TextAlignVertical.center,
          onSubmitted: widget.onSubmitted,
          decoration: InputDecoration(
            hintText: widget.hint,
            counterText: '',
            hintStyle: DesktopChrome.text(size: 13, color: DesktopChrome.hint),
            suffixIconConstraints: const BoxConstraints(
              minWidth: 40,
              minHeight: 36,
            ),
            suffixIcon: widget.password
                ? AppIconButton(
                    tooltip: _shown ? 'Hide password' : 'Show password',
                    icon: _shown ? AppIcons.eyeOff : AppIcons.eye,
                    onPressed: () => setState(() => _shown = !_shown),
                  )
                : null,
          ),
        ),
      ],
    ),
  );
}

/// The Wi-Fi an Intern 3 sees, to choose one: strongest first, a lock on the ones with a password.
class InternNetworkList extends StatelessWidget {
  const InternNetworkList({
    super.key,
    required this.networks,
    required this.onChoose,
    this.active,
  });

  final List<SetupNetwork> networks;
  final ValueChanged<SetupNetwork> onChoose;

  /// The one it is on now, marked.
  final String? active;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final network in networks)
        InkWell(
          key: Key('intern-network:${network.ssid}'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          onTap: () => onChoose(network),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    network.ssid,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.text(size: 13),
                  ),
                ),
                if (network.ssid == active)
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: Text('Current', style: DesktopChrome.metadata()),
                  ),
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Text(
                    '${network.signal}%',
                    style: DesktopChrome.metadata(),
                  ),
                ),
                SizedBox(
                  width: 24,
                  child: network.secure
                      ? Icon(
                          AppIcons.lock,
                          size: 14,
                          color: DesktopChrome.muted,
                        )
                      : null,
                ),
              ],
            ),
          ),
        ),
    ],
  );
}
