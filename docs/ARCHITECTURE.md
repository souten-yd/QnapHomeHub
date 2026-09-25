# Architecture

The default 0.3.0 Compose separates Web applications, stored health data, and USB radio ownership.

| Component | Responsibility |
| --- | --- |
| SelfCare QPKG, port 17863 | Users, health records, CSV/backup, Omron collection requests |
| HomeHub, port 8787 | Existing authentication, Bot configuration, Web/Matter API |
| radio, no TCP listener | One HCI controller, serialized BlueZ and Noble workers |
| Matterbridge, port 8283 | Matter/mDNS; internal-token-protected calls to HomeHub |
| updater, loopback 8788 | Docker operations; radio uses the same server image |

Both clients send fixed operations through `/radio/ble.sock`, mode 0600. The host mount is `data/radio/ble.sock`; it is accessible to the QPKG running as the NAS administrator. Application pairing keys travel only in local IPC and are not logged or returned by the health endpoint.

The radio process reuses HomeHub's SerialQueue. BlueZ stays available for SelfCare between jobs. A HomeHub job stops BlueZ, waits for process exit, brings the selected HCI up, forks the original SwitchBotManager, executes the existing operation, waits for the child to exit, and resumes BlueZ. No next owner opens while a previous process refuses to exit. Jobs waiting more than 60 seconds expire without executing. In-flight operations are not preempted. This preference preserves the frequent SelfCare collection path, rather than implementing a strict-priority or real-time scheduler.

HomeHub settings and secrets remain in their existing locations. The radio service reads settings for each operation. `data/bluetooth` persists BlueZ bonds. SelfCare owns its SQLite measurement database and application pairing keys. The radio service does not store measurement history.

The Omron reader is a separate GPL-3.0-or-later Python program communicating via JSON stdin/stdout. Its sources and notices are distributed under `server/ble`. Keep these files aligned with QnapSelfCare's `ble_worker.py` and `ble_protocol.py` when updating the protocol.

Only the radio container is privileged. Each Web service remains available when radio is down, although both BLE clients will report errors. Stopping HomeHub does not stop radio or SelfCare. Legacy deployments without HOMEHUB_SHARED_RADIO=1 retain the old direct SwitchBot manager; they must not share an HCI with radio. See SHARED-RADIO.md for migration.
