export {
  inngest,
  auditRequested,
  auditCompleted,
  auditFailed,
  demandMineRequested,
  demandMineCompleted,
  serpTrackRequested,
  serpTrackCompleted,
  connectorSyncRequested,
  connectorSyncCompleted,
  connectorWebhookReceived,
  approvalDecided,
  contentPipelineRequested,
  contentPublished,
  contentPipelineFailed,
  approvalRequested,
  opportunitiesScanRequested,
} from "./client";
import { auditFunction } from "./audit";
import { connectorFunctions } from "./connectors";
import { demandFunctions } from "./demand";
import { pipelineFunctions } from "./pipeline";

/** Every function served from /api/inngest. Add new jobs here. */
export const functions = [auditFunction, ...demandFunctions, ...connectorFunctions, ...pipelineFunctions];
