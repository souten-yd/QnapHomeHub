/** Volatile, explicit authorization for one HBF operation, distinguishing BLE-only from application registration. */
export type RegistrationMode = 'ble' | 'application';
export class ProxyBondSession {
  private mode: RegistrationMode = 'ble';
  private target?: string;
  private deadline = 0;
  constructor(private readonly now = () => performance.now()) {}

  cancel() { this.target = undefined; this.deadline = 0; }
  status() {
    if (this.now() >= this.deadline) this.cancel();
    return { pending: Boolean(this.target), mode: this.target ? this.mode : null, remainingSeconds: this.target ? Math.ceil((this.deadline - this.now()) / 1000) : 0 };
  }
  prepare(target: string, mode: RegistrationMode = 'ble') {
    if (this.status().pending) throw new Error('A BLE registration session is already pending');
    this.target = target;
    this.mode = mode;
    this.deadline = this.now() + 120000;
    return this.status();
  }
  consume(address: string) {
    const allowed = this.status().pending && address.toUpperCase() === this.target ? this.mode : null;
    // Called only for the configured M5GO sync, before worker startup. Failures
    // consume permission too; ordinary retries must never repeat BLE pairing.
    this.cancel();
    return allowed;
  }
}
