import 'usage_window.dart';

/// How close a rate-limit window is to being spent.
///
/// Two thresholds, one step each: [warn] turns a figure amber and [critical]
/// turns it red. A third shade between them would be one nobody could name.
enum UsagePressure {
  calm,

  /// Muted amber. The window is worth noticing on the way past.
  warn,

  /// Red. The window is nearly spent.
  critical,
}

/// Where a window starts reading amber: this much left, or less.
///
/// The desktop's own numbers (`workspace_subscription_usage.dart`), on what is
/// LEFT rather than what is spent, so one subscription is the same colour on
/// the laptop and the phone. The figure beside it is already exact, so this
/// number is not carrying the quantity — it is carrying the moment the
/// quantity starts to matter.
const int kUsageLowRemaining = 20;

/// Where a window starts reading red: this much left, or less.
const int kUsageCriticalRemaining = 5;

/// What is left of a window that is [usedPercent] spent, 0–100.
double usageRemainingOf(double usedPercent) =>
    (100 - usedPercent).clamp(0, 100).toDouble();

/// What is left, as printed: `80%`. Floored, so a partly spent window never
/// reads `100%`; and a remainder under one percent reads `<1%`, never `0%`.
/// The same figure the model sheet prints (`ModelsMenuController`), so the two
/// cannot disagree.
String usageRemainingLabel(double usedPercent) {
  final left = usageRemainingOf(usedPercent);
  if (!left.isFinite) return '—';
  if (left > 0 && left < 1) return '<1%';
  return '${left.floor()}%';
}

/// Judged on the whole percent [usageRemainingLabel] prints, as the desktop
/// judges it: a window printed as `20%` is amber whatever its fraction was.
UsagePressure usagePressureOf(double usedPercent) {
  final left = usageRemainingOf(usedPercent);
  if (!left.isFinite) return UsagePressure.calm;
  final whole = left.floor();
  if (whole <= kUsageCriticalRemaining) return UsagePressure.critical;
  if (whole <= kUsageLowRemaining) return UsagePressure.warn;
  return UsagePressure.calm;
}

extension UsageWindowPressure on UsageWindow {
  UsagePressure get pressure => usagePressureOf(usedPercent);

  /// `80% remaining`, as the desktop words it.
  String get remainingLabel => '${usageRemainingLabel(usedPercent)} remaining';
}
