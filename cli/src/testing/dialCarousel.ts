export type DialMessage = Record<string, unknown> & { t?: string }

/**
 * How often the model's refresh task looks for a list to apply. The firmware's task (app_main.c `refresh_task`) is
 * woken by the list's `agents.end` and applies it within milliseconds: a moment after the list, never at once.
 */
export const CAROUSEL_REFRESH_MS = 50
/** The tiles the round dial holds and the rows its list buffer keeps (cable_client.h `CABLE_MAX_AGENTS`, `MAX_PROJECTS`). */
export const CAROUSEL_TILES = 16

/**
 * The dial's carousel as the firmware keeps it, so a test reads what a person would see on the glass. Diego, 2026-11-20
 * 17:32:40: a list pushed over a full carousel lost its one agent, the 16 old tiles were removed, and the face showed
 * "Choose a pane"; only a model that adds before it removes, at 16 tiles, shows that. Not modelled, as no test needs
 * it: the refresh held while voice uploads (`audio_client_active`) and the clear on a session going down.
 */
export class DialCarousel {
  /** The list as it streams in (cable_client.c `s_agents`); `building` from `agents.begin` to `agents.end`. */
  private buffer: string[] = []
  private building = false
  /** A list ended and is not applied yet (`ui_request_agent_reload`). */
  private reload = false
  readonly tiles: string[] = []
  /** The tile on the face; -1 is the firmware's `s.active = -1`, drawn as "Choose a pane" (ui_habitat.c `caption`). */
  active = -1
  refused = 0
  private shown = ''
  /** An app picked here whose ring has not landed (ui_habitat.c `s.app_landing`). */
  private landing = ''
  /** A focus for a tile the carousel does not hold yet (ui_habitat.c `s.pending_focus`). */
  private pendingFocus = ''

  heard(message: DialMessage): void {
    switch (message.t) {
      // cable_client.c `handle_agents_begin`: a new list replaces the buffer, even one not applied yet.
      case 'agents.begin':
        this.buffer = []
        this.building = true
        return
      // cable_client.c `handle_agent`: while building, at most 16 rows, a repeated id skipped.
      case 'agent': {
        const id = message.id
        if (this.building && this.buffer.length < CAROUSEL_TILES && typeof id === 'string' && id && !this.buffer.includes(id)) this.buffer.push(id)
        return
      }
      // cable_client.c `handle_agents_end`: the list is whole and the refresh task is asked to apply it.
      case 'agents.end':
        this.building = false
        this.reload = true
        return
      // ui_habitat.c `ui_apps_replace`: an `apps` showing another app than the one picked means the pick was ignored,
      // and must not land the face later.
      case 'apps':
        this.shown = typeof message.shown === 'string' ? message.shown : ''
        if (this.landing !== this.shown) this.landing = ''
        return
      // cable_client.c `focus` → ui_habitat.c `ui_focus_project`, applied on arrival, before the list it may name.
      case 'focus':
        if (typeof message.agentId === 'string' && message.agentId) this.focus(message.agentId)
        return
    }
  }

  /** ui_habitat.c `app_pick`: the app already shown lands nothing, its face stays as it was. */
  picked(app: string): void {
    if (app !== this.shown) this.landing = app
  }

  /**
   * app_main.c `refresh_task` → `refresh_projects`. A list still building is not read (`cable_agent_snapshot` returns
   * -1): its own `agents.end` asks again.
   */
  refresh(): void {
    if (!this.reload || this.building) return
    this.reload = false
    const list = [...this.buffer]
    // Adds first (`ui_project_set_name` → `ensure`), refused once 16 tiles are there...
    for (const id of list) {
      if (this.tiles.includes(id)) continue
      if (this.tiles.length >= CAROUSEL_TILES) this.refused += 1
      else this.tiles.push(id)
    }
    // ...then removes, from the end, the tiles the list does not name.
    for (let i = this.tiles.length - 1; i >= 0; i--) if (!list.includes(this.tiles[i]!)) this.remove(i)
    if (list.length > 1) this.order(list)
    // ui_habitat.c `ui_land_after_reload`: the ring of an app picked here puts its first tile on the face.
    if (this.landing && this.landing === this.shown) {
      this.landing = ''
      this.active = this.tiles.length ? 0 : -1
    }
    // ui_habitat.c `ui_apply_pending_focus`: a focus that came before its tile lands once the tile is there.
    if (this.pendingFocus && this.tiles.includes(this.pendingFocus)) this.focus(this.pendingFocus)
  }

  private focus(id: string): void {
    const i = this.tiles.indexOf(id)
    if (i < 0) { this.pendingFocus = id; return }
    this.pendingFocus = ''
    this.active = i
  }

  /** ui_habitat.c `ui_project_remove`: the face moves with the tiles after it, or to the last when its own went. */
  private remove(i: number): void {
    this.tiles.splice(i, 1)
    if (this.active > i) this.active--
    else if (this.active >= this.tiles.length) this.active = this.tiles.length - 1
  }

  /** ui_habitat.c `ui_project_apply_order`: the list's order by swaps, the face kept on its agent by id. */
  private order(ids: string[]): void {
    const selected = this.active >= 0 && this.active < this.tiles.length ? this.tiles[this.active] : undefined
    for (let i = 0; i < ids.length && i < this.tiles.length; i++) {
      const j = this.tiles.indexOf(ids[i]!)
      if (j >= 0 && j !== i) [this.tiles[i], this.tiles[j]] = [this.tiles[j]!, this.tiles[i]!]
    }
    this.active = selected === undefined ? -1 : this.tiles.indexOf(selected)
  }
}
