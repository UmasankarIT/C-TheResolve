// Next.js instrumentation — runs once per server process at startup.
// Provisions the demo accounts in Firebase (fire-and-forget; never blocks
// boot) so the first sign-in of a fresh environment goes through Firebase
// Auth instead of needing a self-heal pass on the local fallback path.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureFirebaseDemoAccounts } = await import('./lib/firebaseAuth');
    void ensureFirebaseDemoAccounts();
  }
}
