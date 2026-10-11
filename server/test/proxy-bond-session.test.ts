import { describe, it, expect } from 'vitest';
import { ProxyBondSession } from '../src/proxy-bond-session.js';

describe('explicit BLE registration session permission', () => {
  it('expires at two minutes, cannot be extended while pending, and is consumed once', () => {
    let now = 10;
    const lease = new ProxyBondSession(() => now);
    expect(lease.consume('AA:BB:CC:11:22:33')).toBe(null);
    expect(lease.prepare('AA:BB:CC:11:22:33')).toEqual({ pending: true, mode: 'ble', remainingSeconds: 120 });
    now += 119999;
    expect(() => lease.prepare('AA:BB:CC:11:22:33')).toThrow('already pending');
    expect(lease.consume('aa:bb:cc:11:22:33')).toBe('ble');
    expect(lease.consume('AA:BB:CC:11:22:33')).toBe(null);
    lease.prepare('AA:BB:CC:11:22:33'); now += 120000;
    expect(lease.consume('AA:BB:CC:11:22:33')).toBe(null);
  });
  it('keeps application registration distinct and consumes it once', () => {
    const lease = new ProxyBondSession();
    lease.prepare('AA:BB:CC:11:22:33', 'application');
    expect(lease.status().mode).toBe('application');
    expect(lease.consume('AA:BB:CC:11:22:33')).toBe('application');
    expect(lease.consume('AA:BB:CC:11:22:33')).toBe(null);
    expect(lease.status().mode).toBe(null);
  });
  it('refuses a different peer, cancellation and new instances retain no authorization', () => {
    const lease = new ProxyBondSession();
    lease.prepare('AA:BB:CC:11:22:33');
    expect(lease.consume('AA:BB:CC:44:55:66')).toBe(null);
    expect(lease.consume('AA:BB:CC:11:22:33')).toBe(null);
    lease.prepare('AA:BB:CC:11:22:33'); lease.cancel();
    expect(lease.status().pending).toBe(false);
    lease.prepare('AA:BB:CC:11:22:33');
    expect(new ProxyBondSession().status().pending).toBe(false);
  });
});
