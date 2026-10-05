export function updateNetworkConfig(config) {
  const result = { ...config };
  if (config.showFailures !== undefined) {
    result.showFailures = true;
  }
  return result;
}
