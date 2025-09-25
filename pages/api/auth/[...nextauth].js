// pages/api/auth/[...nextauth].js
import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { sql } from "@vercel/postgres";

// JWT-based sessions (no DB adapter required)
export const authOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    // Ensure a user row exists in Neon and carry the UUID on the token/session
    async signIn({ account, profile }) {
      if (account?.provider === "google" && profile?.email) {
        try {
          // Create user if missing (email unique)
          await sql`
            INSERT INTO users (email)
            VALUES (${profile.email})
            ON CONFLICT (email) DO NOTHING
          `;
        } catch (e) {
          console.error("users upsert failed:", e);
          return false;
        }
      }
      return true;
    },
    async jwt({ token }) {
      // Attach user id (UUID) to the JWT
      if (token?.email) {
        try {
          const { rows } = await sql`
            SELECT id FROM users WHERE email = ${token.email} LIMIT 1
          `;
          if (rows[0]?.id) token.uid = rows[0].id;
        } catch (e) {
          console.error("fetch user id failed:", e);
        }
      }
      return token;
    },
    async session({ session, token }) {
      // Expose user id to the client
      if (session?.user && token?.uid) {
        session.user.id = token.uid;
      }
      return session;
    },
  },
  // Required for NextAuth in production
  secret: process.env.NEXTAUTH_SECRET,
};

export default NextAuth(authOptions);
