---
summary: "Implementation plan for bounded managed artifacts and separate cohesive runtime deployment"
read_when:
  - Extending managed artifact transfers or their compatibility bundle
---

# Managed Artifact Streaming Implementation Plan

**Goal:** Support larger generic managed files while preserving isolation and safe cohesive deployment.

**Architecture:** Host-owned quotas and managed storage own lifecycle and integrity. Optional sandbox streaming primitives preserve the filesystem boundary. Office365 deploys a checksum-pinned runtime patch separately from plugin activation.

**Tech stack:** TypeScript, Node streams, descriptor-bound storage, Vitest, Node deployment scripts, Python Office365 bridge.

1. Inspect `plugin-tool-files.ts`, the media store, sandbox bridges, plugin contracts, and existing deployment packaging.
2. Add `tools.artifacts` quotas and additive capability metadata; retain existing buffer contracts.
3. Stream imports with byte counters/cancellation; verify private disk snapshots before opening upload streams.
4. Add guarded streaming reads and exclusive streaming sandbox creation; gate tools by those capabilities.
5. Extend `plugin-tool-files.test.ts` at the actual media/sandbox boundary: generated >64 MiB, suspended cancellation, integrity, owner isolation, traversal, quota pressure, non-sandbox refusal.
6. Run focused agent-support tests, sandbox tests, config tests, health tests, typecheck, formatter, changed gate, build, and review. Record environmental limitations explicitly.
7. Build the Office365 administrator deployment workflow with exact base/checksum guards and native capability precedence. Verify effective tools for an existing sandbox session.
8. Generate the compatibility patch from the pinned pre-feature base to the final core commit. Commit core and Office365 separately on their feature branches.

Focused proof: `node node_modules/vitest/vitest.mjs run --config test/vitest/vitest.agents-support.config.ts src/agents/plugin-tool-files.test.ts`.
Deployment proof: `node --test tests/test_deploy.mjs tests/test_artifact_quota.mjs tests/version.test.mjs`.
