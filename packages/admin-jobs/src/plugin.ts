import type { Plugin } from 'payload'

import { Jobs } from './collection/Jobs'
import { retryJobMutation } from './graphql/retry-job-mutation'

const jobsView = '@aikit/admin-jobs/admin#JobsDashboardView'
const jobsLink = '@aikit/admin-jobs/admin#JobsNavLink'

export const adminJobs = (): Plugin => (incoming) => {
  const collections = [...(incoming.collections ?? [])]
  if (!collections.some((collection) => collection.slug === Jobs.slug)) {
    collections.push(Jobs)
  }
  return {
    ...incoming,
    collections,
    graphQL: {
      ...incoming.graphQL,
      mutations: incoming.graphQL?.mutations ?? retryJobMutation,
    },
    admin: {
      ...incoming.admin,
      components: {
        ...incoming.admin?.components,
        afterNavLinks: [...(incoming.admin?.components?.afterNavLinks ?? []), jobsLink],
        views: {
          ...incoming.admin?.components?.views,
          jobMonitor: {
            Component: jobsView,
            path: '/job-monitor',
            exact: true,
            meta: {
              title: 'Job Monitor',
            },
          },
        },
      },
    },
  }
}
