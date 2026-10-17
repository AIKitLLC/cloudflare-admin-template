import * as migration_20250929_111647 from './20250929_111647'
import * as migration_20261013_120000 from './20261013_120000'

export const migrations = [
  {
    up: migration_20250929_111647.up,
    down: migration_20250929_111647.down,
    name: '20250929_111647',
  },
  {
    up: migration_20261013_120000.up,
    down: migration_20261013_120000.down,
    name: '20261013_120000',
  },
]
