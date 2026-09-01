export {
  inngest,
  auditRequested,
  auditCompleted,
  auditFailed,
  demandMineRequested,
  demandMineCompleted,
  serpTrackRequested,
  serpTrackCompleted,
} from "./client";
import { auditFunction } from "./audit";
import { demandFunctions } from "./demand";

/** Every function served from /api/inngest. Add new jobs here. */
export const functions = [auditFunction, ...demandFunctions];
