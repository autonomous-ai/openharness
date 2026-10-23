// Flows for the Store and a product page.
//
// Fix group: 2, Store on phones. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
const toStore = {
  wide: [['exact', 'Harness Store']],
  compact: [['exact', 'Menu'], ['exact', 'Store']],
};
const claude = ['text', 'Work with Claude directly'];
// The rail's entry on a computer and a tablet, its chip on a phone.
const allHarnesses = ['exact', 'All harnesses'];
// A shelf a browser has no computer to fill: it says where to see it.
const viewers = ['exact', 'Viewers'];

export const FLOWS = [
  { name: 'store', scenario: 'workspace', ...toStore },
  {
    name: 'store-product',
    scenario: 'workspace',
    wide: [...toStore.wide, claude],
    compact: [...toStore.compact, claude],
  },
  {
    name: 'store-all',
    scenario: 'workspace',
    wide: [...toStore.wide, allHarnesses],
    compact: [...toStore.compact, allHarnesses],
  },
  {
    name: 'store-viewers',
    scenario: 'workspace',
    wide: [...toStore.wide, viewers],
    compact: [...toStore.compact, viewers],
  },
];
