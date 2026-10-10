import { defineJob } from './define-job'

export const systemPingJob = defineJob({
  name: 'system.ping',
  maxAttempts: 1,
  leaseMs: 15_000,
  validate(input: unknown): { note: string } {
    const note =
      input && typeof input === 'object' && 'note' in input
        ? (input as { note?: unknown }).note
        : ''
    if (typeof note !== 'string') {
      throw new Error('note must be a string.')
    }
    if (note.length > 200) {
      throw new Error('note must be 200 characters or fewer.')
    }
    return { note }
  },
  async execute(context) {
    context.log(context.payload.note ? `ping ${context.payload.note}` : 'ping')
  },
})
