import type { JoinMode } from './verify-deployed-p2p-options.js'

export interface FailedResponseDiagnostic {
  status: number
  url: string
}

export interface NodeTimeoutSnapshot {
  label: 'nodeA' | 'nodeB'
  connectedPeerCount?: number
  connectionStates?: Array<{ peerId: string; state: string }>
  runtimeConfigProof?: {
    buildCommit?: unknown
    apiOrigin?: unknown
    signalingUrl?: unknown
    hasToken: boolean
    tokenLength: number
    urlHasToken: boolean
  }
  poll?: {
    status: number
    messageCount?: number
    error?: string
  }
  failedResponses: FailedResponseDiagnostic[]
  captureError?: string
}

export interface MeshTimeoutSnapshot {
  joinMode: JoinMode
  roomId: string
  failureReason: string
  deploymentIdentity?: {
    expectedCommit: string
    appCommit: string
    apiCommit: string
  }
  nodes: NodeTimeoutSnapshot[]
}

function redactBearerText(value: string): string {
  return value.replace(/((?:authorization\s*:\s*)?bearer)\s+[^\s&]+/gi, '$1 [redacted]')
}

function redactTokenText(value: string): string {
  return redactBearerText(value)
    .replace(/(nodexBetaToken|token|authorization|secret|key)=([^&\s]+)/gi, '$1=[redacted]')
}

export function safeResponseUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    for (const key of [...url.searchParams.keys()]) {
      if (/token|authorization|secret|key/i.test(key)) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    return redactBearerText(url.toString())
  } catch {
    return redactTokenText(rawUrl)
  }
}

export function formatMeshTimeoutError(snapshot: MeshTimeoutSnapshot): string {
  const safeRoomId = safeResponseUrl(snapshot.roomId)
  const sanitizedSnapshot: MeshTimeoutSnapshot = {
    ...snapshot,
    roomId: safeRoomId,
    failureReason: safeResponseUrl(snapshot.failureReason),
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      captureError: node.captureError ? safeResponseUrl(node.captureError) : undefined,
      runtimeConfigProof: node.runtimeConfigProof
        ? {
            ...node.runtimeConfigProof,
            apiOrigin: typeof node.runtimeConfigProof.apiOrigin === 'string'
              ? safeResponseUrl(node.runtimeConfigProof.apiOrigin)
              : node.runtimeConfigProof.apiOrigin,
            signalingUrl: typeof node.runtimeConfigProof.signalingUrl === 'string'
              ? safeResponseUrl(node.runtimeConfigProof.signalingUrl)
              : node.runtimeConfigProof.signalingUrl,
          }
        : undefined,
      poll: node.poll
        ? {
            ...node.poll,
            error: node.poll.error ? safeResponseUrl(node.poll.error) : undefined,
          }
        : undefined,
      failedResponses: node.failedResponses.map((response) => ({
        ...response,
        url: safeResponseUrl(response.url),
      })),
    })),
  }

  return `mesh connection timeout in ${snapshot.joinMode} mode for room ${safeRoomId}\n${JSON.stringify(sanitizedSnapshot, null, 2)}`
}
