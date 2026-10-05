export function optionsFor(context, options) {
  if (context === 'conflict') {
    return options.filter((o) => o === 'Cancel' || o === 'Save copy');
  }
  return options;
}
