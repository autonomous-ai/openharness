export function updateNetworkConfig(config) {
  const updated = { ...config };
  if (config.showFailures !== undefined) {
    updated.showFailures = true;
  }
  return updated;
}
