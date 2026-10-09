/**
 * Which services the Connectors page offers. The list is the Grid app's: the connector gateway's
 * `GET /v1/grid/connectors`, live when signed in, else the bundled snapshot (assets/catalog.json,
 * rebuilt by scripts/update-connector-catalog.ts).
 *
 * `dcr`: this computer registers its own OAuth client with the service's MCP server and signs in through
 * 127.0.0.1 (oauth.ts). `app`: the service lets no computer register itself, so sign-in goes through the
 * gateway with the Harness account (gateway.ts). A service either list says can sign in from this computer
 * does so; one that needs the gateway is left out only when the gateway, asked, does not offer it.
 */
import { CATALOG_ITEMS } from './generated/catalog.js'
import { CODE } from './store.js'

export interface CatalogItem { code: string, label: string, auth: 'dcr' | 'app', description: string, mcp_url?: string }
export interface GatewayRow { code: string, label?: string, auth_type?: string, mcp_url?: string, description?: string }

export const CATALOG: Record<string, CatalogItem> = Object.fromEntries(CATALOG_ITEMS.map(item => [item.code, item]))

export function label(code: string): string {
  return CATALOG[code]?.label ?? code
}

export function services(offered?: Record<string, GatewayRow>): Record<string, CatalogItem> {
  const live = offered && Object.keys(offered).length > 0
  const items: Record<string, CatalogItem> = {}
  for (const [code, item] of Object.entries(CATALOG)) {
    if (item.auth === 'dcr' || !live) items[code] = { ...item }
  }
  for (const [code, row] of Object.entries(offered ?? {})) {
    const auth = row.auth_type
    if ((auth !== 'app' && auth !== 'dcr') || !CODE.test(code)) continue
    const item: CatalogItem = items[code] ?? { ...(CATALOG[code] ?? { code, label: code, auth, description: '' }) }
    if (item.auth !== 'dcr') item.auth = auth
    const url = row.mcp_url ?? ''
    if (url && (auth === 'dcr' || !item.mcp_url)) item.mcp_url = url
    item.label = row.label || item.label || code
    // The bundled description wins: the gateway's has carried placeholder text ("Notion description
    // abcd"), and a service's own words do not change between releases. A service Harness does not know
    // yet has only the gateway's.
    item.description = item.description || row.description || ''
    if (item.auth === 'dcr' && !item.mcp_url) continue
    items[code] = item
  }
  return items
}
