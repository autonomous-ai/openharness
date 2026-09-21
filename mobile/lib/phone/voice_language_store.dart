import 'dart:async';
import 'dart:ui' show Locale, PlatformDispatcher;

import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';

import 'phone_sheet.dart';
import 'voice_language.dart';

/// The language voice input is transcribed in — a code from [voiceLanguages] — remembered across
/// launches.
///
/// One app-wide value, not one per pager: it is picked in Settings or from a long press on the mic,
/// and every terminal after that hears in it. Loaded by `loadPersistedSettings()` before the first
/// frame, so the first take is never sent in the phone's language by a late read.
class VoiceLanguageStore extends ValueNotifier<String> {
  VoiceLanguageStore({
    LocalKeyValueStore? storage,
    List<Locale>? preferredLocales,
  }) : _storage = storage ?? HarnessFileStore.shared,
       super(
         defaultVoiceLanguage(
           preferredLocales ?? PlatformDispatcher.instance.locales,
         ),
       );

  /// The key the per-pager controller used, kept so an existing choice survives the move here.
  static const _key = 'voice_input_language';

  final LocalKeyValueStore _storage;

  /// An unreadable file, or a code the backend no longer serves, keeps the phone's own language.
  Future<void> load() async {
    try {
      final saved = await _storage.read(_key);
      if (isVoiceLanguage(saved)) value = saved!;
    } on Exception {
      // The phone's own language still works; only the memory is missing.
    }
  }

  Future<void> select(String code) async {
    if (!isVoiceLanguage(code) || code == value) return;
    value = code;
    try {
      await _storage.write(_key, code);
    } on Exception {
      // Kept in memory for this run.
    }
  }
}

final voiceLanguageStore = VoiceLanguageStore();

/// Picks the language voice input is transcribed in.
Future<void> showVoiceLanguagePicker(
  BuildContext context, {
  VoiceLanguageStore? store,
}) {
  final languages = store ?? voiceLanguageStore;
  return showPhoneSheet(
    context,
    title: 'Voice input language',
    actions: [
      for (final language in voiceLanguages)
        PhoneSheetAction(
          icon: language.code == languages.value
              ? LucideIcons.check300
              : LucideIcons.languages300,
          label: language.name,
          onTap: () => unawaited(languages.select(language.code)),
        ),
    ],
  );
}
