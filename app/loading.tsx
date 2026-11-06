/**
 * Route-level loading state.
 *
 * Rendered while the App Router is resolving a server segment. Uses the same
 * dark palette and purple accent as the rest of CiteRail.
 */
export default function Loading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5 bg-[#07080c] text-gray-400">
      <div
        role="status"
        aria-label="Loading"
        className="h-10 w-10 rounded-full border-2 border-purple-500/20 border-t-[#9945FF] animate-spin"
      />
      <p className="text-sm font-medium tracking-wide text-gray-400">
        Loading<span className="text-purple-400">…</span>
      </p>
    </div>
  );
}
