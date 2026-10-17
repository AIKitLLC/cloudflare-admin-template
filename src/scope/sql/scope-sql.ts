import { sql } from '@payloadcms/db-d1-sqlite'

export { sql }

export type ScopeSql = ReturnType<typeof sql>
