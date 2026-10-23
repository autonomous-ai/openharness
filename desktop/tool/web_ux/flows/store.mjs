// Flows for the Store and a product page.
//
// Fix group: 2, Store on phones. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
const toStore = {
  wide: [['exact', 'Harness Store']],
  compact: [['exact', 'Menu'], ['exact', 'Store']],
};
const claude = ['text', 'Work with Claude directly'];

export const FLOWS = [
  { name: 'store', scenario: 'workspace', ...toStore },
  {
    name: 'store-product',
    scenario: 'workspace',
    wide: [...toStore.wide, claude],
    compact: [...toStore.compact, claude],
  },
];
