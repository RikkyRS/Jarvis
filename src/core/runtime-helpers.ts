import type { CycleRow } from "../infrastructure/db.js";
import type { Cycle } from "./cycle/index.js";

export function fromRow(row: CycleRow): Cycle {
  return {
    id: row.id,
    uuid: row.uuid,
    number: row.number,
    slug: row.slug,
    objective: row.objective,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: JSON.parse(row.payload) as Cycle["payload"],
  };
}
