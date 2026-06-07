---
title: "Nodex — WebRTC Connectivity Model"
date: 2026-06-02
status: draft-after-paulo-research
source: "Research-after-meeting.txt"
---

# Nodex — WebRTC Connectivity Model

## Purpose

This document captures the connectivity constraints raised by Prof. Paulo and confirmed by the post-meeting research.

The key conclusion is:

> A browser P2P system is never purely decentralized in practice. It requires signaling/rendezvous/bootstrap, must handle NAT/CGNAT/firewall, and must treat relay/fallback as a first-class production path.

## Browser constraints

Browsers cannot open arbitrary raw TCP/QUIC sockets. Browser-to-browser communication depends on browser-supported transports, primarily:

- WebRTC Data Channels;
- secure WebSockets for signaling;
- WebTransport in some scenarios;
- HTTPS-based fallback.

WebRTC does not define how peers discover each other or exchange SDP. The application must provide signaling.

## Required components

### 1. Signaling server

Responsibilities:

- register active peers;
- provide rooms/topics/key-interest rendezvous;
- exchange SDP offers/answers;
- exchange ICE candidates;
- provide peer discovery metadata;
- optionally seed invalidation messages.

The signaling server does not need to carry data payloads in the ideal case, but it is still central infrastructure.

### 2. STUN

Purpose:

- discover public-facing network candidate addresses;
- help peers attempt direct connection through NAT.

Limitation:

- not enough for all NAT types;
- CGNAT and symmetric NAT may still fail.

### 3. TURN / relay

Purpose:

- relay traffic when direct peer-to-peer fails.

Implication:

- if too much traffic uses TURN, Nodex loses much of its infrastructure-cost advantage;
- TURN must be measured as an explicit metric, not hidden.

### 4. Peer discovery / rendezvous

Nodex needs a discovery mechanism analogous in spirit to Syncthing/libp2p:

- unique peer identity;
- room/topic/key discovery;
- active peer liveness;
- interest announcements;
- relay availability;
- directness/cost scoring.

## Failure modes

Nodex must handle:

- peers behind CGNAT;
- corporate/university firewalls;
- networks allowing only ports 80/443;
- tab suspension;
- user closing the browser;
- mobile network changes;
- Page Visibility lifecycle changes;
- relay-only paths;
- high latency between peers;
- peer resource exhaustion;
- user refusal or browser restriction.

## Required metrics

Every real test should record:

- signaling success rate;
- ICE gathering time;
- direct connection success rate;
- TURN/relay fallback rate;
- connection setup latency;
- data channel open latency;
- median and p95 payload transfer latency;
- connection drops;
- rejoin success after tab close/suspend;
- network type if available;
- user-agent/browser;
- country/city/ISP if consented and safe;
- CPU/memory/bandwidth usage.

## Architecture implications

### 1. Direct P2P is an optimization, not a guarantee

The architecture must remain correct if direct peer connections fail.

### 2. Relay fallback must be planned

Fallback options:

- TURN relay;
- server-origin fallback;
- edge/cache fallback;
- WebSocket central relay for small metadata only.

### 3. Data path should be adaptive

Candidate path selection:

1. local cache if valid;
2. direct peer if available and valid;
3. relay peer path if cost acceptable;
4. server/edge fallback.

### 4. Metadata is cheaper than payload

Even when payload must fallback to server, metadata gossip can still reduce some work by quickly discovering freshness, invalidation, or local unavailability.

## Security and privacy considerations

Browser P2P can expose peer IPs and resource usage. Nodex must consider:

- IP exposure;
- consent to use bandwidth/CPU;
- abuse/pollution of segments;
- malicious peers serving stale or corrupt payloads;
- unauthorized data requests;
- fingerprinting risk from peer metadata.

Required controls:

- integrity hash validation;
- server-issued policy metadata;
- authorization checks before serving;
- peer scoring and banning;
- resource caps;
- no sensitive/personalized data by default.

## Research tasks

1. Inspect current Nodex WebRTC implementation and document exact signaling flow.
2. Produce a diagram of SDP/ICE candidate exchange.
3. Identify whether STUN/TURN is configured and how fallback behaves.
4. Test across at least three network classes:
   - same LAN;
   - different residential networks;
   - restrictive/corporate/university-like network.
5. Measure direct vs relay success.
6. Determine whether cost advantage survives when relay is used.

## Claim discipline

Allowed:

> Nodex uses browser P2P opportunistically and falls back when direct connectivity is unavailable.

Not allowed:

> Nodex avoids server infrastructure entirely.

Not allowed:

> WebRTC reliably bypasses all NAT/firewall scenarios.
