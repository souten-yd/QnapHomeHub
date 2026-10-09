import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SharedRadioManager } from '../src/shared-radio.js';
const config = () => ({ hciDeviceId: 0, scanTimeoutMs: 10000, apiFallback: false, scanOnStartup: false, devices: [] });

describe('Advertisement listener ownership', () => {
  it('stops the listener before ordinary radio operations', async () => {
    for (const [owner, request] of [
      ['homehub', {}],
      ['selfcare', { action:'sync', adapter:'hci0', device:{ model:'HEM-6232T' } }]
    ] as const) {
      const manager = new SharedRadioManager(config, '', '') as any;
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
      await once(child, 'spawn');
      manager.watcher = child;
      manager.startBlueZ = async () => {};
      const operation = vi.fn(async () => {
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        return { ok: true };
      });
      manager.callRaw = operation; manager.callSelfCare = operation;
      await manager.arbiter.run(owner, request);
      expect(operation).toHaveBeenCalledOnce();
      await manager.cleanup();
    }
  });

  it('keeps the watcher alive only for listener-triggered HBF sync', async () => {
    const manager = new SharedRadioManager(config, '', '') as any;
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    await once(child, 'spawn');
    manager.watcher = child;
    manager.startBlueZ = async () => {};
    const request = { action:'sync', adapter:'hci0', advert_at:Date.now(),
      diagnostic:true, device:{ model:'HBF-228T' } };
    manager.callSelfCare = vi.fn(async () => {
      expect(child.exitCode).toBe(null);
      expect(child.signalCode).toBe(null);
      return { diagnostic:{} };
    });
    const result = await manager.arbiter.run('selfcare', request) as any;
    expect(result.diagnostic).toEqual({});
    expect(manager.preserveWatcherForSelfCare(request)).toBe(true);
    await manager.cleanup();
  });
  it('requests one bounded adapter recovery after repeated HBF connection timeouts', async () => {
    const manager = new SharedRadioManager(config, '', '') as any;
    const request = { action:'sync', adapter:'hci0', advert_at:Date.now(),
      diagnostic:true, device:{ model:'HBF-228T' } };
    const timeout = () => {
      const error = new Error('missing') as Error & { diagnostic?: unknown };
      error.diagnostic = { stage:'connection', connect_error:{ type:'TimeoutError', message:'TimeoutError' } };
      return error;
    };
    expect(manager.shouldRecoverHbfConnection(request, timeout())).toBe(false);
    expect(manager.consecutiveHbfConnectionTimeouts).toBe(1);
    expect(manager.shouldRecoverHbfConnection(request, timeout())).toBe(true);
    expect(manager.consecutiveHbfConnectionTimeouts).toBe(2);

    const unrelated = new Error('read failure') as Error & { diagnostic?: unknown };
    unrelated.diagnostic = { stage:'read' };
    expect(manager.shouldRecoverHbfConnection(request, unrelated)).toBe(false);
    expect(manager.consecutiveHbfConnectionTimeouts).toBe(0);

    const hemRequest = { ...request, device:{ model:'HEM-6232T' } };
    expect(manager.shouldRecoverHbfConnection(hemRequest, timeout())).toBe(false);
    expect(manager.consecutiveHbfConnectionTimeouts).toBe(0);
  });

  it('validates targets, clears removed events and expires abandoned leases', async () => {
    const manager = new SharedRadioManager(config, '', '') as any;
    await expect(manager.configureWatch({adapter:'hci1',addresses:[]})).rejects.toThrow('Invalid');
    await expect(manager.configureWatch({adapter:'hci0',addresses:['bad']})).rejects.toThrow('Invalid');
    await manager.configureWatch({adapter:'hci0',addresses:['AA:BB:CC:DD:EE:FF']});
    manager.watchSeen.set('AA:BB:CC:DD:EE:FF',{at:Date.now(),fingerprint:'abc123',rssi:-55});
    const watched = await manager.configureWatch({adapter:'hci0',addresses:['AA:BB:CC:DD:EE:FF']}) as any;
    expect(watched.events).toHaveLength(1);
    expect(watched.events[0]).toMatchObject({address:'AA:BB:CC:DD:EE:FF',fingerprint:'abc123',rssi:-55});
    expect((await manager.configureWatch({adapter:'hci0',addresses:[]})).events).toHaveLength(0);
    manager.watchAddresses = ['AA:BB:CC:DD:EE:FF'];
    manager.watchLease = 0;
    manager.stopWatcher = vi.fn(async()=>{});
    manager.startBlueZ = vi.fn(async()=>{});
    await manager.maintainWatch();
    expect(manager.stopWatcher).toHaveBeenCalledOnce();
    expect(manager.startBlueZ).not.toHaveBeenCalled();
  });
});
