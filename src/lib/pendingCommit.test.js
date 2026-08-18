// Durable pending-commit slot: written before the network call, cleared only
// after confirmed server success, survives reload, tolerates garbage.
import { beforeEach, describe, expect, it } from 'vitest';
import { savePendingCommit, loadPendingCommit, clearPendingCommit } from './pendingCommit';

beforeEach(() => localStorage.clear());

describe('pendingCommit storage', () => {
  it('round-trips a create commit', () => {
    savePendingCommit({ type: 'create', payload: { vin: '1FTFW1E81NKD72360', items: {} } });
    const v = loadPendingCommit();
    expect(v.type).toBe('create');
    expect(v.payload.vin).toBe('1FTFW1E81NKD72360');
    expect(typeof v.ts).toBe('number');
  });

  it('round-trips a recheck commit with its QC number', () => {
    savePendingCommit({ type: 'recheck', qc: 'FQ-1042', payload: { items: [] } });
    const v = loadPendingCommit();
    expect(v.qc).toBe('FQ-1042');
  });

  it('clear removes the slot', () => {
    savePendingCommit({ type: 'create', payload: {} });
    clearPendingCommit();
    expect(loadPendingCommit()).toBeNull();
  });

  it('rejects garbage and malformed entries instead of crashing', () => {
    localStorage.setItem('fq_pending_commit_v1', 'not json {');
    expect(loadPendingCommit()).toBeNull();
    localStorage.setItem('fq_pending_commit_v1', JSON.stringify({ type: 'weird', payload: {} }));
    expect(loadPendingCommit()).toBeNull();
    // a recheck without its QC number is unusable
    localStorage.setItem('fq_pending_commit_v1', JSON.stringify({ type: 'recheck', payload: {} }));
    expect(loadPendingCommit()).toBeNull();
  });
});
