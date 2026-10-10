export const JOBS_SLUG = 'jobs'

export const JOBS_READ_KEY = 'jobs:read'
export const JOBS_TRIGGER_KEY = 'jobs:trigger'
export const JOBS_RETRY_KEY = 'jobs:retry'

export const JOB_DISPATCH_ACTIONS = ['trigger', 'retry'] as const

export const JOB_STATUSES = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED'] as const

export const JOB_QUEUE_BINDING = 'JOB_QUEUE'

export const PLACEHOLDER_QUEUE_NAME = 'placeholder-jobs'
export const PLACEHOLDER_DEAD_LETTER_QUEUE_NAME = 'placeholder-jobs-dlq'

export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_LEASE_MS = 30_000
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_CAP_MS = 15 * 60 * 1000

export const MAX_PAYLOAD_CHARS = 8_000
export const MAX_ERROR_CHARS = 4_000
export const MAX_LOG_ENTRIES = 40
export const MAX_LOG_ENTRY_CHARS = 500
export const MAX_LOGS_CHARS = 16_000

export const MAX_LIST_LIMIT = 50
export const MAX_LIST_PAGE = 20
export const MAX_WHERE_IN = 25
export const MAINTENANCE_BATCH = 25

export const JOB_SYSTEM_WRITE = 'jobSystemWrite'
export const JOB_TRIGGER_WRITE = 'jobTrigger'
export const JOB_RETRY_WRITE = 'jobRetry'
export const SKIP_JOB_ENQUEUE = 'skipJobEnqueue'

export const REDACTED = '[redacted]'
