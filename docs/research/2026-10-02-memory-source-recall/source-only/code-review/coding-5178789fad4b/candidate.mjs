export function navigationState(current, event) {
  if (event === 'start_visit') return 'compact';
  if (event === 'expand') return 'expanded';
  if (event === 'collapse') return 'compact';
  if (event === 'navigate') return current;
  return current;
}
