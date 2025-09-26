import { signIn, signOut, useSession } from 'next-auth/react';

export default function AuthButtons() {
  const { data: session, status } = useSession();
  const loading = status === 'loading';

  if (loading) {
    return (
      <button
        className="px-3 py-1 text-sm rounded-md bg-neutral-200 text-neutral-700"
        disabled
      >
        loading…
      </button>
    );
  }

  if (!session) {
    return (
      <button
        onClick={() => signIn('google')}
        className="px-3 py-1 text-sm rounded-md bg-brand-blue text-white hover:bg-blue-600"
      >
        Sign in with Google
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-neutral-700 truncate max-w-[180px]">
        {session.user?.email || session.user?.name || 'Signed in'}
      </span>
      <button
        onClick={() => signOut()}
        className="px-3 py-1 text-sm rounded-md bg-neutral-200 text-neutral-800 hover:bg-neutral-300"
      >
        Sign out
      </button>
    </div>
  );
}
