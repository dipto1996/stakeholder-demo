// pages/api/auth/[...nextauth].js
import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { sql } from "@vercel/postgres";
import bcrypt from "bcryptjs";

export const authOptions = {
  session: { strategy: "jwt" },

  providers: [
    // ---- Google OAuth ----
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),

    // ---- Email + Password (uses your own signup + verification flow) ----
    CredentialsProvider({
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = (credentials?.email || "").toLowerCase().trim();
        const password = credentials?.password || "";

        if (!email || !password) throw new Error("Email and password are required");

        const { rows } = await sql`
          SELECT id, email, password_hash, email_verified
          FROM users
          WHERE email = ${email}
          LIMIT 1
        `;
        const user = rows[0];

        if (!user) throw new Error("No account found");
        if (!user.email_verified) throw new Error("Please verify your email first");

        const ok = await bcrypt.compare(password, user.password_hash || "");
        if (!ok) throw new Error("Invalid credentials");

        // Return the minimal user object to be saved on the token
        return { id: user.id, email: user.email };
      },
    }),
  ],

  // Sign-in / session hooks
  callbacks: {
    // Runs on each sign-in and whenever a JWT is created/updated
    async jwt({ token, user, account, profile }) {
      // If credentials login created `user`, ensure token gets userId
      if (user?.id && !token.userId) {
        token.userId = user.id;
      }

      // If OAuth (Google) login: upsert the user into DB and attach id to token
      if (account?.provider === "google") {
        const email = (profile?.email || user?.email || "").toLowerCase().trim();
        if (email) {
          // Upsert: create user if not exists, or mark email_verified true
          const { rows } = await sql`
            INSERT INTO users (email, password_hash, created_at, email_verified)
            VALUES (${email}, NULL, now(), TRUE)
            ON CONFLICT (email) DO UPDATE
              SET email_verified = TRUE
            RETURNING id, email
          `;
          const dbUser = rows[0];
          if (dbUser?.id) token.userId = dbUser.id;
        }
      }

      return token;
    },

    // When session() runs, attach token userId and clean email casing
    async session({ session, token }) {
      session.user = session.user || {};
      if (token?.userId) session.user.id = token.userId;
      if (session?.user?.email) session.user.email = session.user.email.toLowerCase();
      return session;
    },

    // Ensure redirects after sign-in/sign-out are safe and land on the app root by default
    async redirect({ url, baseUrl }) {
      const safeBase = baseUrl || process.env.NEXTAUTH_URL || "http://localhost:3000";

      // If url is a relative path, return base + url
      if (url && url.startsWith("/")) return `${safeBase}${url}`;

      // If url is absolute and same origin, return it
      try {
        const parsed = new URL(url);
        if (parsed.origin === safeBase) return url;
      } catch (e) {
        // not a valid absolute URL -> fallback below
      }

      // default fallback
      return `${safeBase}/`;
    },
  },

  // Optional: custom pages like signIn can be configured
  pages: {
    signIn: "/login",
  },

  // Add secret in env: NEXTAUTH_SECRET
  // debug: process.env.NODE_ENV !== "production"
};

export default NextAuth(authOptions);
