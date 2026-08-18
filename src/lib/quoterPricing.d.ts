/*
 * Type declarations for the shared pricing engine so server TypeScript can
 * import the SAME verbatim JS the client uses (single source of truth —
 * Phase 1A snapshots must reproduce client totals exactly).
 */

export interface QuoterLine {
  id: string;
  status: string;
  review?: boolean;
  cls?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface LineHoursResult {
  b: number;
  p: number;
  ri: number;
  blends: Array<{ panel: string; hrs: number }>;
  riList: Array<{ part: string; hrs: number }>;
  pdr?: boolean;
  pdrUsd?: number;
  capped?: boolean;
  bOverridden?: boolean;
  pOverridden?: boolean;
  riOverridden?: boolean;
  partial?: boolean;
  cap?: number;
}

export interface QuoteTotalsResult {
  B: number;
  P: number;
  RI: number;
  overlap: number;
  hrs: number;
  usdB: number;
  usdP: number;
  usdRI: number;
  usdPDR: number;
  usd: number;
  flagged: number;
  errors: number;
}

export declare const PANELS: string[];
export declare const DAMAGE: string[];
export declare const SEVS: string[];
export declare const PARTS: string[];
export declare function defaultRates(): Record<string, any>;
export declare function defaultFlags(): Array<Record<string, any>>;
export declare function rn(v: unknown): number;
export declare function pdrEligible(c: Record<string, unknown> | null | undefined): boolean;
export declare function lineHours(
  cls: Record<string, unknown> | null | undefined,
  rates: Record<string, any>,
): LineHoursResult;
export declare function quoteTotals(
  lines: QuoterLine[],
  rates: Record<string, any>,
): QuoteTotalsResult;
export declare function billingMap(lines: QuoterLine[]): Record<string, any>;
export declare function billingCls(panel: string, m: Record<string, any>): Record<string, any>;
export declare function bodyAlloc(
  panel: string,
  m: Record<string, any>,
  rates: Record<string, any>,
): { byId: Record<string, number>; total: number };
