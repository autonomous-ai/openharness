/** How many background commands an idle harness still runs, as every verb and the cleanup's log say it. No imports:
 *  the cleanup's edge host loads it. */
export const backgroundSaid = (n: number): string => `${n} background command${n === 1 ? '' : 's'} running`
