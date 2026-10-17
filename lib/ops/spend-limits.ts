/**
 * The cap limits the forms share. The org-wide monthly SERP budget is edited
 * in two places (Settings → Organisation and Ops → Spend), so both validate
 * against these; a cap one form saved is never one the other refuses. Client
 * components import this file, so it imports nothing.
 */

/** The most staff can set any budget's cap to in Ops → Spend. */
export const BUDGET_CAP_MAX_USD = 100_000;

/** The most an organisation's monthly SERP budget can be, in either form. */
export const ORG_SERP_BUDGET_MAX_USD = 5_000;

/** What an owner may set the monthly SERP budget to themselves; staff go up to ORG_SERP_BUDGET_MAX_USD. */
export const ORG_SERP_BUDGET_OWNER_MAX_USD = 500;
