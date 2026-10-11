import type { GraphQLExtension, PayloadRequest } from 'payload'

import { retryFailedJob } from '../delivery/retry-failed-job'

export const retryJobMutation: GraphQLExtension = (graphQL) => {
  const resultType = new graphQL.GraphQLObjectType({
    name: 'RetryJobResult',
    fields: {
      id: { type: graphQL.GraphQLInt },
      name: { type: graphQL.GraphQLString },
      status: { type: graphQL.GraphQLString },
    },
  })
  return {
    retryJob: {
      type: resultType,
      args: {
        id: { type: new graphQL.GraphQLNonNull(graphQL.GraphQLInt) },
      },
      resolve: async (_source: unknown, args: { id: number }, context: { req: PayloadRequest }) => {
        const job = await retryFailedJob({ id: args.id, req: context.req })
        return {
          id: Number(job.id),
          name: job.name,
          status: job.status,
        }
      },
    },
  }
}
