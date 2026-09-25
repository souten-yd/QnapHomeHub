import { describe, expect, it, vi } from 'vitest';
import { RadioArbiter } from '../src/radio-arbiter.js';
import { stopProcess } from '../src/shared-radio.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

describe('Shared USB radio ownership', () => {
  it('waits for HomeHub exit before SelfCare and restores SelfCare after a Bot command', async () => {
    const events: string[] = [];
    const arbiter = new RadioArbiter({
      stopHomeHub: async () => { events.push('stop-homehub'); },
      stopBlueZ: async () => { events.push('stop-bluez'); },
      resumeSelfCare: async () => { events.push('warm-selfcare'); },
      homeHub: async <T>() => { events.push('bot'); return 'bot-result' as T; },
      selfCare: async <T>() => { events.push('omron'); return 'records' as T; },
    });
    expect(await arbiter.run('selfcare', {})).toBe('records');
    expect(await arbiter.run('homehub', {})).toBe('bot-result');
    expect(events).toEqual(['stop-homehub', 'omron', 'stop-bluez', 'bot', 'stop-homehub', 'warm-selfcare']);
  });
  it('never opens the next owner when the previous owner refuses to stop', async () => {
    const homeHub = vi.fn(); const selfCare = vi.fn();
    const arbiter = new RadioArbiter({ stopHomeHub: async () => { throw new Error('still alive'); },
      stopBlueZ: async () => {}, homeHub, selfCare });
    await expect(arbiter.run('selfcare', {})).rejects.toThrow('still alive');
    expect(selfCare).not.toHaveBeenCalled();
    expect(arbiter.status().pending).toBe(0);
  });
  it('serializes concurrent requests and recovers after an operation fails', async () => {
    let active = 0; let maximum = 0;
    const task = async <T>(request: unknown) => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--; if (request === 'fail') throw new Error('failed'); return request as T; };
    const arbiter = new RadioArbiter({ stopHomeHub: async () => {}, stopBlueZ: async () => {}, homeHub: task, selfCare: task });
    const result = await Promise.allSettled([arbiter.run('selfcare', 'fail'), arbiter.run('homehub', 'next')]);
    expect(result.map(r => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(maximum).toBe(1);
  });
  it('does not execute a stale Bot request after a long-running SelfCare operation', async () => {
    let finish!: () => void;
    let began!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const homeHub = vi.fn();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const arbiter = new RadioArbiter({ stopHomeHub: async () => {}, stopBlueZ: async () => {},
        homeHub, selfCare: async <T>() => { began(); await waiting; return 'done' as T; } });
      const active = arbiter.run('selfcare', {});
      await started;
      const stale = expect(arbiter.run('homehub', {})).rejects.toThrow('expired');
      clock.mockReturnValue(60001);
      finish();
      await active;
      await stale;
      expect(homeHub).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('waits for an actual child process to exit before releasing ownership', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); console.log('ready'); setInterval(() => {}, 1000)"]);
    try {
      await once(child.stdout!, 'data');
      await stopProcess(child);
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  });
});
