// src/plugins/fundingArb/types.ts
export interface MarketSnapshot {
    market: string;
    hourlyPct: number;  // % per hour
    aprPct: number;     // annualized %
  }
  
  export interface FundingArbStatus {
    running: boolean;
    mode: 'PAPER' | 'LIVE';
    thresholdApr: number;
    startedAt?: Date | null;
    lastRunAt?: Date | null;
    markets: MarketSnapshot[];
    lastMessage?: string;
  }
  