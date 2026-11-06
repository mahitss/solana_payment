'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * Renders a self-contained recovery panel in the app's dark visual language
 * (near-black surfaces, purple accents) and exposes the underlying error
 * message so a failure is never silently swallowed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[citerail] unhandled route error:', error);
  }, [error]);

  const message =
    error && typeof error.message === 'string' && error.message.trim()
      ? error.message
      : 'An unknown error occurred.';

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#07080c] text-gray-200 px-4 py-16">
      <div className="w-full max-w-xl rounded-2xl border border-gray-800 bg-[#090a0f] shadow-2xl shadow-purple-900/20 p-8">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-tr from-purple-600 via-indigo-600 to-emerald-400 flex items-center justify-center font-bold text-white text-sm">
            CR
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white tracking-tight">
              Something went wrong
            </h1>
            <p className="text-[10px] uppercase font-mono text-purple-400">
              CiteRail runtime error
            </p>
          </div>
        </div>

        <p className="mt-6 text-sm leading-relaxed text-gray-400">
          An unexpected error occurred while rendering this view. The failure has
          been logged. You can retry the request, or open the public verifier to
          confirm a settlement receipt independently.
        </p>

        <pre className="mt-4 max-h-48 overflow-auto rounded-xl border border-gray-800 bg-[#07080c] p-4 text-xs font-mono text-gray-400 whitespace-pre-wrap break-words">
          {message}
        </pre>

        {error && error.digest ? (
          <p className="mt-3 text-xs font-mono text-gray-600">
            Digest: {error.digest}
          </p>
        ) : null}

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium text-sm px-5 py-2 rounded-lg transition shadow-md shadow-purple-600/20"
          >
            Try again
          </button>
          <span className="text-xs text-gray-600 font-mono">
            settlement is verified server-side, never skipped
          </span>
        </div>
      </div>
    </div>
  );
}
