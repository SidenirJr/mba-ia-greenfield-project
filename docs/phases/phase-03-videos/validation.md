---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-05T17:46:44-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T17:46:44-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "'10GB' upload limit has no unit (GB vs GiB) — UPLOAD_MAX_BYTES undefined"
    resolved_by: phase-03-videos/TD-02
  - id: AMB-2
    status: resolved
    summary: "Upload resume (project-plan §4) is not a Fase 03 bullet — in or out of scope?"
    resolved_by: phase-03-videos/TD-02
  - id: MD-1
    status: resolved
    summary: "No TD decides which video formats/content types the upload accepts"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Job Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Upload Strategy for Files up to 10GB"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Presigned URL Host and Endpoint Configuration"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Processing Trigger and Job Idempotency"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Worker Location and Runtime"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Metadata Extraction and FFmpeg Invocation"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Public Video Identifier (Unique URL)"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Video Status Lifecycle, Failure Handling, Abandoned Uploads"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Bucket Layout, Object Keys and Provisioning"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Authorization Model"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Test Strategy and Fixtures"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Object Storage Engine"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Thumbnail Frame, Format and Size"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Accepted Upload Formats and Content Types"
    resolved_by: phase-03-videos/TD-15
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-15)_ — No TD decided which video formats/content types the upload accepts; TD-15 (Accepted Upload Formats and Content Types) now covers it (decided: B, `video/*` + ffprobe as validator).
- **AMB-1** _(resolved_by phase-03-videos/TD-02)_ — Capability "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" gives no unit: 10 GB (10,000,000,000 bytes) vs 10 GiB (10,737,418,240 bytes). The value drives the upload limit (`UPLOAD_MAX_BYTES`), the part planner and the test fixtures, so a reasonable implementer must ask "which one?". No single TD owns it (it surfaces only inside TD-12's Recommendation).
- **AMB-2** _(resolved_by phase-03-videos/TD-02)_ — Upload resume after a connection failure comes from `docs/project-plan.md` §4 "Pontos de Atenção" ("permita retomar em caso de falha de conexão"), not from the Fase 03 capability bullets copied into `## Scope`. It is unclear whether resume is a requirement of this phase or a recorded note (out of scope). It changes the endpoint set (part-URL re-issue, `ListParts`) and the test matrix.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Job Queue Technology.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Upload Strategy for Files up to 10GB (includes part-size/limit parameters and abandoned-upload approach).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — Presigned URL Host and Endpoint Configuration.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Processing Trigger and Job Idempotency.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Worker Location and Runtime (includes open sub-question: does the worker service autostart on `docker compose up`).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Metadata Extraction and FFmpeg Invocation (includes open sub-question: which metadata is persisted and how).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Public Video Identifier (Unique URL).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Streaming and Download Delivery (includes open sub-questions: who may stream/download before Phase 04 defines visibility; whether `206` is emitted by storage or by the API).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Video Status Lifecycle, Failure Handling, Abandoned Uploads (includes open question: "rascunho" naming collision with Phase 04's publication flow).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — Bucket Layout, Object Keys and Provisioning.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Authorization Model.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Test Strategy and Fixtures.
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Object Storage Engine (upstream MinIO is archived; engine must be confirmed).
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 pending — Thumbnail Frame, Format and Size (includes open sub-question: thumbnail failure after successful metadata extraction).
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — TD-15 pending — Accepted Upload Formats and Content Types.
