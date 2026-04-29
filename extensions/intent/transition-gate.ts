/**
 * Pure decision: should we proceed with `defining → implementing`?
 * Wrapping the prompt in a small function keeps it unit-testable.
 */
export interface ConfirmGate {
  confirm: () => Promise<boolean>;
}

export async function decideTransitionToImplementing(
  gate: ConfirmGate,
): Promise<"proceed" | "cancel"> {
  const ok = await gate.confirm();
  return ok ? "proceed" : "cancel";
}
