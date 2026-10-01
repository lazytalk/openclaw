---
summary: "Execution workspace and upgrade-safe managed artifact implementation plan"
read_when:
  - Extending artifact workspace backends or runtime capability verification
---

# Execution Workspaces Implementation Plan

**Goal:** Provide opt-in restricted host artifact processing and independently degradable Office365 artifact capability.

**Architecture:** Core owns storage, limits, identity and workspace confinement. Sandbox remains preferred; a separately scoped host backend uses the existing guarded filesystem library. Office365 probes generic SDK capabilities and caches explicit verification only for exact runtime identities. Administrator deployment uses a checksum-pinned core patch; plugin activation never installs runtime code.

**Tech stack:** TypeScript, fs-safe descriptor IO, async byte streams, Vitest, Node CLI and deployment scripts.

1. Add `ExecutionWorkspaceBridge` and sandbox adapter; provision host run directories beneath the state directory using owner hashes and random run identifiers. Reuse guarded reads/writes and reject traversal, aliases and external roots.
2. Add `tools.executionWorkspace.mode` (`sandbox` default, `restricted-host` opt-in), workspace selection, generic path aliases and cleanup/copy SDK methods. Preserve streaming storage and quotas.
3. Describe effective workspace capabilities and exact runtime identity in `ctx.files.capabilities`; advertise generic storage capabilities in gateway health without implying an active session workspace.
4. Add confined host round-trip, default-off, cross-owner/session, cleanup, escape and symlink tests; retain existing >64 MiB, cancellation, integrity and quota proofs.
5. Implement Office365 explicit local verification with copy, export, hash check and cleanup. Report feature health and invalidate verification on runtime/capability change; dependent tools fail independently.
6. Update cohesive deployment, manifest, docs and release packaging. Native compatible capability skips patching; unknown builds never get patched automatically.
7. Run focused tests, format/type/build checks and structured review. Commit core and plugin separately, generate pinned patch from the final core commit, package and push both branches.

Scope baseline: requested feature branches; generic core artifact owner and Office365 consumer/deployment owner. Additive SDK aliases preserve sandbox APIs. Host access is limited to the generated active run workspace; it is a file capability boundary, not process sandboxing.
