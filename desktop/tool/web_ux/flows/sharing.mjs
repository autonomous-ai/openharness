// Flows for a shared harness link (/s/…) in each state a visitor can meet.
//
// Fix group: shared links, clarity and trust. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder. The incomplete link is
// `shared-link` in states.mjs; these answer the link's read in the browser (capture.mjs `answerApi`).

const id = '0b6f6a8e-2c1d-4f3e-9a7b-5d4c3b2a1f00';
// 32 bytes, as a real owner key is pinned in the link's fragment.
const key = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const path = `/s/${id}#key=${key}`;
const read = (status, data) => ({ '/api/shared-agents/': { status, body: data ? { success: true, data } : { success: false } } });
const link = { id, machineId: 'm1', agentId: 'a1', name: 'Release notes', engine: 'claude', ownerPublicKey: key };

export const FLOWS = [
  // Signed out, on a private link.
  { name: 'shared-link-private', scenario: 'signin', path, api: read(401) },
  // Signed in, and refused: expired, turned off, or shared with another email.
  { name: 'shared-link-refused', scenario: 'workspace', path, api: read(403) },
  { name: 'shared-link-offline', scenario: 'signin', path, api: read(200, { ...link, online: false }) },
  { name: 'shared-link-changed', scenario: 'signin', path, api: read(200, { ...link, ownerPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=', online: true }) },
  // No answer at all: the read is blocked like any request off the served origin.
  { name: 'shared-link-failed', scenario: 'signin', path },
];
