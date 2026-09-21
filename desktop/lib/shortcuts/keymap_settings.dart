import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_select_field.dart';
import 'app_keymap.dart';
import 'keymap.dart';

Future<void> openKeyboardConfig(BuildContext context) async {
  final store = KeymapTheme.of(context, listen: false)?.store;
  if (store == null) return;
  try {
    final file = await store.ensureFile();
    if (!await launchUrl(file.uri)) {
      throw StateError(
        'No editor is associated with .jsonc files. Open ${file.path} in your editor.',
      );
    }
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text('Couldn’t open keyboard config. $error')),
      );
    }
  }
}

class KeymapSettings extends StatelessWidget {
  const KeymapSettings({
    super.key,
    required this.contextKind,
    required this.onContextChanged,
  });
  final KeymapContext contextKind;
  final ValueChanged<KeymapContext> onContextChanged;

  @override
  Widget build(BuildContext context) {
    final keymap = KeymapTheme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            AppSelectField<KeymapContext>(
              value: contextKind,
              // Keep the context readable when the user enlarges text. The
              // surrounding Wrap still limits the field to the pane width.
              width: 160 * MediaQuery.textScalerOf(context).scale(13.5) / 13.5,
              options: const [
                SelectOption(
                  value: KeymapContext.workspace,
                  label: 'Workspace',
                ),
                SelectOption(
                  value: KeymapContext.terminal,
                  label: 'Agent input',
                ),
                SelectOption(value: KeymapContext.picker, label: 'Search'),
                SelectOption(
                  value: KeymapContext.project,
                  label: 'Project menu',
                ),
              ],
              onChanged: onContextChanged,
            ),
            if (keymap?.store != null)
              TextButton.icon(
                onPressed: () => openKeyboardConfig(context),
                icon: const Icon(Icons.edit_outlined, size: 16),
                label: const Text('Edit keyboard config'),
                style: TextButton.styleFrom(
                  foregroundColor: grid.AppPalette.textPrimary,
                ),
              ),
          ],
        ),
        if (keymap?.path != null) ...[
          const SizedBox(height: 8),
          Text(
            'Saves apply automatically. Invalid edits keep your last working shortcuts.',
            style: TextStyle(
              color: grid.AppPalette.textSecondary,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 4),
          SelectableText(
            keymap!.path!,
            style: TextStyle(color: grid.AppPalette.textFaint, fontSize: 11),
          ),
        ],
        if (keymap?.error != null) ...[
          const SizedBox(height: 8),
          SelectableText(
            keymap!.error!,
            style: const TextStyle(color: Colors.orangeAccent, fontSize: 12),
          ),
        ],
        const SizedBox(height: 16),
      ],
    );
  }
}
