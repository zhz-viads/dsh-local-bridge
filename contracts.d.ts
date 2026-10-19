export interface BridgeRequest {
  v: 1;
  requestId: string;
  op: 'send' | 'list';
  createdAt: number;
  expiresAt: number;
  from?: 'codex' | 'claude' | 'dsh';
  sourceSessionId?: string;
  sessionId?: string;
  text?: string;
}

export interface BridgeResult {
  v: 1;
  requestId: string;
  hash: string;
  at: number;
  state: 'queued' | 'submitting' | 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';
  sessionId?: string;
  text?: string;
  turn?: number;
  userSeq?: number;
  code?: string;
  archived?: boolean;
}
