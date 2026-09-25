import { SwitchBotManager } from './switchbot-manager.js';
import type { AppConfig } from './types.js';
let config: AppConfig;
let manager: SwitchBotManager | undefined;
process.on('message', async (request: any) => {
  try {
    config = request.config;
    manager ??= new SwitchBotManager(() => config, request.token, request.secret,
      (...debug) => process.send?.({ debug }));
    const result = request.action === 'scan'
      ? await manager.scan(request.timeoutMs)
      : await manager.command(request.deviceId, request.command, request.password, request.holdSeconds);
    process.send?.({ id: request.id, result });
  } catch (error) {
    process.send?.({ id: request.id, error: (error as Error).message });
  }
});
process.on('SIGTERM', () => { void manager?.cleanup().finally(() => process.exit(0)); if (!manager) process.exit(0); });
process.on('disconnect', () => process.exit(0));
