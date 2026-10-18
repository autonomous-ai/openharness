import '../approve_sign_in.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'scan_to_connect.dart';

/// What a Connect computer press has to say while it runs — `Pairing…`, or why it stopped — on the
/// line under the button that started it. Null takes the line away.
typedef ConnectComputerSay = void Function(String? message, {bool failed});

/// "Or scan the QR code on your computer", at the foot of Computers: the camera, then the computer
/// whose Add Phone code it read, looked up on the account and paired with by the code. True once it
/// is paired here. For a desktop from before the onboarding of 2026-10-12, which pairs a phone by
/// that code; every other computer is added by "On your computer, go to" (`your_computer.dart`).
///
/// [say] is the caller's line, and is called only while [context] is still mounted.
///
/// [steps]: under the camera's title, the steps on the computer that bring the code up — for a
/// caller whose own page does not say them ([ScanToConnectPage.steps]).
///
/// [handOff]: [context] is the home screen, which a computer turning up takes away. The code then
/// goes to the home screen ([AppNotifier.holdPendingPairing]) the moment the computer is known, and
/// its pairing page pairs by it; and so it does whatever [handOff] says when [context] has gone by
/// then.
Future<bool> scanAndPairComputer(
  BuildContext context,
  AppNotifier notifier, {
  required ConnectComputerSay say,
  bool handOff = false,
  Widget? camera,
  Widget? steps,
}) async {
  // ⚠️ Where an approval is asked from if [context] is gone by the time the camera hands back a
  // computer's sign-in code — taken away under it, at home, by a computer turning up. Its own
  // context then reads as unmounted (it threw, and the approval was dropped); the root
  // navigator's outlives any one page, and the approval's dialog stands on it anyway.
  final approveFrom = Navigator.of(context, rootNavigator: true).context;
  final code = await scanForCode(
    context,
    fallbackLabel: 'Not now',
    camera: camera,
    steps: steps,
    // The computer may be showing its sign-in QR instead: approving that signs it in, which is
    // what setting it up needs anyway.
    onSignInCode: (code) => unawaited(
      approveComputerSignIn(
        context.mounted ? context : approveFrom,
        notifier,
        code,
      ),
    ),
  );
  if (code == null) return false;
  final machineId = code.machineId, pairCode = code.pairCode;
  if (machineId == null || pairCode == null) {
    if (!context.mounted) return false;
    say('That’s not the Add Phone code.', failed: true);
    return false;
  }
  if (context.mounted) say('Pairing…');
  final lookup = await _lookUp(notifier, machineId, (
    message, {
    failed = false,
  }) {
    if (context.mounted) say(message, failed: failed);
  });
  if (lookup == _Lookup.missing) {
    // The account answered, and the computer is not on it: no code to hold for it.
    if (!context.mounted) return false;
    say(
      "That computer isn't on your account. Sign in to Harness on it "
      'with ${notifier.currentUser?.email ?? 'this account'}.',
      failed: true,
    );
    return false;
  }
  if (lookup == _Lookup.unreachable && context.mounted) {
    say(
      "Couldn't reach your account. Check your connection and scan again.",
      failed: true,
    );
    return false;
  }
  // Known — or, with [context] gone, not known either way: a list that answers without the
  // computer lets a held code go by itself (`AppNotifier._refreshMachines`).
  if (handOff || !context.mounted) {
    notifier.holdPendingPairing(machineId, pairCode);
    // The home screen's pairing page says how it goes from here. Where that page does not come up
    // (a computer the account reads as connected already), "Pairing…" would stand here for good.
    if (context.mounted) say(null);
    return false;
  }
  final error = await notifier.connectWithCode(machineId, pairCode);
  if (!context.mounted) return false;
  if (error == null) {
    HapticFeedback.mediumImpact();
    say(null);
    return true;
  }
  HapticFeedback.heavyImpact();
  say(error, failed: true);
  return false;
}

/// How long the account gets to say whether it has the scanned computer before the line says it is
/// still looking — and goes on looking ([_lookUp]).
const _lookUpPatience = Duration(seconds: 5);

/// Whether the account has [machineId], asked of the account when the list held here does not have
/// it yet.
///
/// ⚠️ **Slow is not "no".** The look used to be cut at 5 seconds and the list read as it stood: a
/// slow `/api/machines` came back as "That computer isn't on your account" — right under "Not you?
/// Sign out", about a computer that was on it — and the answer landing a moment later took the page
/// away with the scanned code. Past [_lookUpPatience] the line says it is still looking, and waits
/// for the account's actual answer. [say] minds whether its line is still there.
Future<_Lookup> _lookUp(
  AppNotifier notifier,
  String machineId,
  ConnectComputerSay say,
) async {
  if (notifier.machineStates.containsKey(machineId)) return _Lookup.found;
  final refresh = notifier.refreshMachines();
  try {
    final answered = await refresh
        .then((_) => true)
        .timeout(_lookUpPatience, onTimeout: () => false);
    if (!answered) {
      say('Still looking for that computer on your account…');
      await refresh;
    }
  } catch (_) {
    // A list that could not be read says nothing about whether the computer is on the account —
    // unless it already has it.
    return notifier.machineStates.containsKey(machineId)
        ? _Lookup.found
        : _Lookup.unreachable;
  }
  return notifier.machineStates.containsKey(machineId)
      ? _Lookup.found
      : _Lookup.missing;
}

/// What the account said of a scanned computer ([_lookUp]).
enum _Lookup {
  /// On the account.
  found,

  /// The account answered without it.
  missing,

  /// The account could not be asked.
  unreachable,
}
