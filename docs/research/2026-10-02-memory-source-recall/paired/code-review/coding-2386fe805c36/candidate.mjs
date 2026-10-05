export function optionsFor(context, options) {
  if (context === 'conflict') {
    return options.filter((option) => option === 'Cancel' || option === 'Save copy');
  }
  return [...options];
}
