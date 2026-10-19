export class ReplyTracker {
  constructor(requestId, saved = {}) {
    this.requestId = requestId;
    this.currentTurn = saved.currentTurn ?? null;
    this.targetTurn = saved.targetTurn ?? null;
    this.userSeq = saved.userSeq ?? null;
    this.lastSeq = saved.lastSeq ?? -1;
    this.text = saved.text ?? '';
    this.ending = saved.ending ?? null;
  }

  event(event) {
    if (!event || !Number.isInteger(event.seq) || event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    if (event.type === 'turn/start') this.currentTurn = event.data.turn;
    if (event.type === 'user/message' && event.data?.source?.rpcId === this.requestId) {
      this.userSeq = event.seq;
      this.targetTurn = this.currentTurn;
    }
    if (this.targetTurn === null) return;
    if (event.type === 'assistant/message' && event.data.turn === this.targetTurn) {
      const text = (event.data.message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (text) this.text = text;
    }
    if (event.type === 'turn/end' && event.data.turn === this.targetTurn) this.ending = { kind: event.data.reason?.kind || 'unknown' };
  }

  frame(frame) {
    if (frame.type === 'snapshot') for (const record of frame.records) if (record.type === 'event') this.event(record.event);
    if (frame.type === 'event') this.event(frame.event);
  }

  snapshot() {
    return { currentTurn: this.currentTurn, targetTurn: this.targetTurn, userSeq: this.userSeq,
      lastSeq: this.lastSeq, text: this.text, ending: this.ending };
  }

  result() {
    if (!this.ending) return null;
    const completed = this.ending.kind === 'completed';
    return { state: completed ? 'completed' : ['aborted', 'interrupted'].includes(this.ending.kind) ? 'cancelled' : 'failed',
      text: this.text, turn: this.targetTurn, userSeq: this.userSeq,
      reason: this.ending.kind, ...(completed ? {} : { code: `turn_${this.ending.kind}` }) };
  }
}
