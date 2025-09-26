import { useSession } from "next-auth/react";

export default function ProtectedContent({ children, fallback }) {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-2 text-gray-600">Loading...</span>
      </div>
    );
  }

  if (!session) {
    return fallback || (
      <div className="text-center p-8">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">
          Please sign in to continue
        </h2>
        <p className="text-gray-600">
          You need to be signed in to access this content.
        </p>
      </div>
    );
  }

  return children;
}