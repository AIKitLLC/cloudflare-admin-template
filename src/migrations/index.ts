import * as migration_20250929_111647 from './20250929_111647'
import * as migration_20261010_080422_audit_logs from './20261010_080422_audit_logs'

export const migrations = [
  {
    up: migration_20250929_111647.up,
    down: migration_20250929_111647.down,
    name: '20250929_111647',
  },
  {
    up: migration_20261010_080422_audit_logs.up,
    down: migration_20261010_080422_audit_logs.down,
    name: '20261010_080422_audit_logs',
  },
]
