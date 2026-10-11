# @aikit/admin-jobs

Two public entries:

- `@aikit/admin-jobs` is the Payload plugin, `defineJob`, and the Next route helpers (`handleQueueBatch`, `handleScheduled`, `decideInternalDispatch`). Node tests and `src/payload.config.ts` import this entry.
- `@aikit/admin-jobs/worker` is the outer Worker dispatch used by `custom-worker.ts`: `buildWorkerRequest`, `applyQueueResults`, and the OpenNext worker types.

The Worker entry does not import the plugin, so the Worker bundle does not pull Payload's upload code. The main entry does not import the Worker entry. `src/entries.int.spec.ts` walks both import graphs and fails when they cross.
