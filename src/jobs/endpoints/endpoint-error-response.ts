import { APIError } from 'payload'

export function endpointErrorResponse(error: unknown): Response {
  if (error instanceof APIError) {
    return Response.json(
      { errors: [{ message: error.message }] },
      { status: error.status || 400 },
    )
  }
  const message = error instanceof Error ? error.message : 'Job request failed.'
  return Response.json({ errors: [{ message }] }, { status: 500 })
}
