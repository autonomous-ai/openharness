import 'dart:io' show Platform;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'phone_sheet.dart' show confirmPhoneAction;

/// Whether back at the root of the app asks before leaving it.
///
/// Android only. iOS has no back button, and its edge swipe has nothing to go back to at a root —
/// so a root that refused to pop there would change nothing anyone could see, and it is left alone.
///
/// ⚠️ **A root that asks has to refuse the pop, and refusing costs the predictive-back peek.**
/// Android 13+ animates the app shrinking towards the home screen while back is held — but only
/// when the SYSTEM owns the press, which it does exactly when the root's `PopScope` lets it go.
/// A root that answers with a question has to keep the press, so the peek is gone at the root; it
/// still plays on every page above it.
final bool confirmsExitOnBack = Platform.isAndroid;

/// Android's back at the app's root — the terminal, or the first welcome screen signed out: asks
/// first, then sends the app to the background.
///
/// Every other back is spent before this is reached: the keyboard (the IME takes the press before
/// Flutter sees it), a sheet or dialog (on the root navigator, above the page that asks), Find over
/// the terminal, and a pushed page. Back while the question is up is its Cancel — the dialog is the
/// root navigator's top route, so the press pops it and never reaches the page that asked.
///
/// ⚠️ **"Exit" backgrounds the app rather than finishing it**, which is also what Android's own
/// back does at a launcher activity since Android 12. The engine stays up, so the machines'
/// sockets and the "agent finished" notices that ride them (`notify/system_notices.dart`) go on
/// working until the OS reclaims the process, and opening the app again lands where it was instead
/// of on a cold start that reconnects every machine. The agents themselves run on the computers
/// either way.
Future<void> confirmExitApp(BuildContext context) async {
  // One question at a time. The dialog is pushed synchronously, so a second press lands on it
  // rather than here — this only closes the gap should that ever stop being true.
  if (_asking) return;
  _asking = true;
  final bool confirmed;
  try {
    confirmed = await confirmPhoneAction(
      context,
      icon: LucideIcons.logOut300,
      title: 'Exit Harness?',
      message: 'Your harnesses keep running on your computers.',
      confirmLabel: 'Exit',
    );
  } finally {
    _asking = false;
  }
  if (!confirmed) return;
  await _moveToBack();
}

bool _asking = false;

/// `harness/app_task` (android `MainActivity.kt`).
const MethodChannel _appTask = MethodChannel('harness/app_task');

/// The task to the background; failing that, Flutter's own way out, so "Exit" never does nothing.
Future<void> _moveToBack() async {
  try {
    if (await _appTask.invokeMethod<bool>('moveToBack') ?? false) return;
  } on MissingPluginException {
    // No native handler — fall through.
  } catch (_) {
    // The channel failed — fall through.
  }
  await SystemNavigator.pop();
}
