'use client';
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }, reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-zinc-900 mb-4">Something went wrong!</h1>
        <button onClick={() => reset()} className="px-4 py-2 bg-zinc-900 text-white rounded-lg">Try again</button>
      </div>
    </div>
  );
}
