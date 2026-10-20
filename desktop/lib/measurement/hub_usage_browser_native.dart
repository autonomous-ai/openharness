/// Hub counting is the browser's: a native build sends nothing.
bool hubUsageAllowed() => false;

bool pageVisible() => true;

void postHubUsage(String body, String? authorization) {}

void Function() watchPage({
  required void Function(bool visible) visibility,
  required void Function() leave,
}) => () {};
