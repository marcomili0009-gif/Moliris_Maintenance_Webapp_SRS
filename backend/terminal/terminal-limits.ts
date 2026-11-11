// Requisiti soddisfatti: RNF-PERF-002, RNF-PERF-003, RNF-REL-005, §11.7

export interface TerminalConcurrencyLimits {
  maxConcurrentServer: number;
  maxConcurrentPerUser: number;
  maxConcurrentPerRobot: number;
  sessionTimeoutMinutes: number;
  maxBufferedBytes: number;
}

export const DEFAULT_TERMINAL_LIMITS: TerminalConcurrencyLimits = {
  maxConcurrentServer: 20,
  maxConcurrentPerUser: 5,
  maxConcurrentPerRobot: 3,
  sessionTimeoutMinutes: 15, // RF-01: 15 minuti di timeout inattività terminale
  maxBufferedBytes: 256 * 1024, // 256 KB di buffer di backpressure controllato (RNF-PERF-002)
};
