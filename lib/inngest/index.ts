export { inngest, auditRequested, auditCompleted, auditFailed } from "./client";
import { auditFunction } from "./audit";

/** Every function served from /api/inngest. Add new jobs here. */
export const functions = [auditFunction];
