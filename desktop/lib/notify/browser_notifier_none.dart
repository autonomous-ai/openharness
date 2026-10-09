import 'system_notifications.dart';

/// Outside a browser there is no browser notifier.
SystemNotifier browserSystemNotifier() => const NoSystemNotifier();
