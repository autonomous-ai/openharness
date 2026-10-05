/**
 * An individual's plates, drawn with the generated copies of the shader and the models
 * (daemons/README.md "Individual art"; `plates/*.g.ts`, written by daemons/tools/generate.mjs).
 *
 * The unit is one size and one version: every mood's loop, all of them sharing one crop, exactly as
 * `bakeModel` crops a species plate (so nothing jumps when the mood changes). It IS `bakeModel`, given
 * the roster's rules narrowed to that size and version: the crop is per size and version there too, so
 * the frames are the ones a whole-individual bake gives, byte for byte.
 *
 * This is CPU work measured in seconds (a reveal frame of a busy model takes most of one), so harnessd
 * runs it in a worker thread (pair/plateWorker.ts); nothing here touches the event loop's I/O.
 */
import { bakeModel } from './plates/plate.g.js'
import { rollTraits } from './plates/render.g.js'
import { PLATE_MODELS, PLATE_ROSTER, PLATE_SOURCE } from './plates/models.g.js'

export type PlateSize = 'portrait' | 'reveal'

/** One frame: its rows, and each cell's material (`m` marking, `a` extra, `e` odd eye, `.` the body). */
export interface PlateFrame { rows: string; mats: string }

/** Every mood's loop at one size and version: `{ idle: [8 frames], work: [4], … }`. */
export type PlateUnit = Record<string, PlateFrame[]>

export interface PlateJob { id: string; seed: number; size: PlateSize; version: string }

type Rules = typeof PLATE_ROSTER.rules
type Model = (inputs: { t: number; mood: string; age: string; traits: unknown }) => unknown

/** What the plates were drawn from: a cache entry from another source is drawn again. */
export const plateSource = (): string => PLATE_SOURCE

export const plateRules = (): Rules => PLATE_ROSTER.rules

/** A species harnessd can draw (it has a model). */
export function hasPlateModel(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATE_MODELS, id)
}

export function renderPlateUnit(job: PlateJob): PlateUnit {
  if (!hasPlateModel(job.id)) throw new Error(`no model for ${job.id}`)
  const rules = PLATE_ROSTER.rules
  const cols = rules.plate.cols[job.size]
  if (!cols || !(rules.versions as readonly string[]).includes(job.version)) throw new Error(`no ${job.size} ${job.version} plate`)
  const model = (PLATE_MODELS as unknown as Record<string, { model: Model }>)[job.id].model
  const traits = rollTraits(PLATE_ROSTER, job.id, job.seed)
  const narrowed = { ...rules, versions: [job.version], plate: { ...rules.plate, cols: { [job.size]: cols } } }
  // The generated JavaScript's default destructuring infers only `mats` in TypeScript. Describe its
  // actual options at this boundary; the model and shader remain generated from the reference.
  const bake = bakeModel as (model: Model, rules: unknown, options: { traits: unknown; mats: boolean }) => Record<string, Record<string, PlateUnit>>
  const baked = bake(model, narrowed, { traits, mats: true })
  return baked[job.size][job.version]
}
