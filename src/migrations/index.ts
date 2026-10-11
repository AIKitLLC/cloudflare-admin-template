import * as migration_20250929_111647 from './20250929_111647'
import * as migration_20261010_080422_audit_logs from './20261010_080422_audit_logs'
import * as migration_20261010_080937_payload_kv from './20261010_080937_payload_kv'
import * as migration_20261010_080938_rbac_permission_matrix from './20261010_080938_rbac_permission_matrix'
import * as migration_20261010_100434_row_level_security from './20261010_100434_row_level_security'
import * as migration_20261010_110209_scope_path from './20261010_110209_scope_path'

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
  {
    up: migration_20261010_080937_payload_kv.up,
    down: migration_20261010_080937_payload_kv.down,
    name: '20261010_080937_payload_kv',
  },
  {
    up: migration_20261010_080938_rbac_permission_matrix.up,
    down: migration_20261010_080938_rbac_permission_matrix.down,
    name: '20261010_080938_rbac_permission_matrix',
  },
  {
    up: migration_20261010_100434_row_level_security.up,
    down: migration_20261010_100434_row_level_security.down,
    name: '20261010_100434_row_level_security',
  },
  {
    up: migration_20261010_110209_scope_path.up,
    down: migration_20261010_110209_scope_path.down,
    name: '20261010_110209_scope_path',
  },
]
