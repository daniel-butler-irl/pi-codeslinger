# Pi 0.69.0 Migration Notes

## Date: 2026-04-23

## Summary

Updated pi-codeslinger extensions to be compatible with Pi 0.69.0 while maintaining backward compatibility.

## Changes Made

### 1. Session Replacement Safety Comments

**Files affected:**

- `extensions/intent/index.ts` (3 locations)

**What changed:**
Added documentation comments to all `ctx.newSession()` calls explaining why we don't need the `withSession` callback pattern introduced in Pi 0.69.0.

**Rationale:**
Pi 0.69.0 introduces a breaking change where `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` invalidate pre-replacement session-bound objects. The new best practice is to use the `withSession` callback for post-switch work:

```typescript
// New pattern (when post-switch work is needed):
await ctx.newSession({
  withSession: async (freshCtx) => {
    // Use freshCtx here - old ctx is invalidated
  },
});

// Our pattern (when no post-switch work needed):
await ctx.newSession();
// function returns immediately - no stale references
```

Since our code returns immediately after `newSession()` calls, we're safe from stale reference issues, but we document this for future maintainers.

### 2. TypeBox Import Strategy

**Files affected:**

- `extensions/intent/index.ts`
- `extensions/orchestrator/protocol-tools.ts`

**What changed:**
Kept using `@sinclair/typebox` imports with TODO comments about future migration to `typebox`.

**Rationale:**
Pi 0.69.0 migrated from `@sinclair/typebox` 0.34.x to `typebox` 1.x. While the runtime provides compatibility shims for legacy extensions, the TypeScript types are incompatible between versions.

Migration path:

1. ✅ **Current (safe)**: Use `@sinclair/typebox` with Pi's shims
   - TypeScript compilation: ✅ Works
   - Runtime: ✅ Works (via shims)
   - Future proof: ⚠️ Shims may be removed in future versions

2. 🚧 **Future (when types stabilize)**: Use `typebox` directly
   - TypeScript compilation: ❌ Currently fails (type incompatibilities)
   - Runtime: ✅ Works
   - Future proof: ✅ Forward compatible

We'll migrate to direct `typebox` imports once:

- TypeBox 1.x types mature
- Pi examples show consistent patterns
- TypeScript strict mode compatibility is verified

### 3. Test Results

- ✅ All 148 tests passing
- ✅ TypeScript compilation clean (`npm run typecheck`)
- ✅ No runtime errors
- ✅ All extension functionality verified

## Impact Assessment

### ✅ No Breaking Changes

Our extensions continue to work with:

- Pi 0.69.0 (current)
- Pi 0.68.x and earlier (via backward compatibility)

### ✅ New Features Available (Not Yet Used)

Pi 0.69.0 introduces features we could leverage in the future:

- Terminating tool results (`terminate: true`)
- Stacked autocomplete providers
- OSC 9;4 progress indicators

### ℹ️ Future Migration Path

When ready to migrate to native `typebox` imports:

1. Update imports:

   ```typescript
   // OLD
   import { Type } from "@sinclair/typebox";

   // NEW
   import { Type } from "typebox";
   ```

2. Verify TypeScript compilation with strict mode

3. Consider using `defineTool()` helper for better type inference:

   ```typescript
   import { defineTool } from "@mariozechner/pi-coding-agent";
   import { Type } from "typebox";

   const myTool = defineTool({
     name: "my_tool",
     parameters: Type.Object({ ... }),
     async execute(...) { ... }
   });

   pi.registerTool(myTool);
   ```

## References

- Pi 0.69.0 Changelog: `CHANGELOG.md` in Pi coding agent package
- TypeBox Migration: `/docs/extensions.md` in Pi coding agent package
- Session Replacement: Breaking change documented in Pi 0.69.0 release notes
