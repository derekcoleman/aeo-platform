/**
 * Bump when a rule's key, scoring, or threshold changes. Persisted on every
 * audit_runs row so trend lines know when a score moved because the site
 * changed versus because the rules did.
 */
export const RULE_REGISTRY_VERSION = "2026.09.1";

export * from "./types";
export * from "./page";
export * from "./site";
