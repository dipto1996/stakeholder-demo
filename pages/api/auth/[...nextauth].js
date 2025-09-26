// pages/api/auth/[...nextauth].js
import NextAuth from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';

export const authOptions = {
  session: { strategy: 'jwt' },
  providers: [
    // ---- Google OAuth ----
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    }),

    // ---- Email + Password (uses your own signup + verification flow) ----
    CredentialsProvider({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'text' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials) {
        const email = (credentials?.email || '').toLowerCase().trim();
        const password = credentials?.password || '';

        if (!email || !password) throw new Error('Email and password are required');

        const { rows } = await sql`
          SELECT id, email, password_hash, email_verified
          FROM users
          WHERE email = ${email}
          LIMIT 1
        `;
        const user = rows[0];

        if (!user) throw new Error('No account found');
        if (!user.email_verified) throw new Error('Please verify your email first');

        const ok = await bcrypt.compare(password, user.password_hash || '');
        if (!ok) throw new Error('Invalid credentials');

        return { id: user.id, email: user.email };
      }
    })
  ],
  // Sign-in flow hooks
  callbacks: {
    // Runs on every sign-in, attach userId to token, and ensure Google users exist in DB
    async jwt({ token, user, account, profile }) {
      // If this is a credentials login, user will be set with id + email from authorize()
      if (user?.id && !token.userId) {
        token.userId = user.id;
      }

      // If this is a Google login, upsert the user in the DB and set token.userId
      if (account?.provider === 'google') {
        const email = (profile?.email || user?.email || '').toLowerCase().trim();
        if (email) {
          // Upsert into users (email_verified true for OAuth)
          const { rows } = await sql`
            INSERT INTO users (email, password_hash, created_at, email_verified)
            VALUES (${email}, NULL, now(), TRUE)
            ON CONFLICT (email) DO UPDATE
              SET email_verified = TRUE
            RETURNING id, email
          `;
          const dbUser = rows[0];
          token.userId = dbUser?.id || token.userId;
        }
      }

      return token;
    },

    async session({ session, token }) {
      // Ensure session.user exists
      session.user = session.user || {};
      if (token?.userId) session.user.id = token.userId;
      if (session?.user?.email) {
        session.user.email = session.user.email.toLowerCase();
      }
      return session;
    }
  },

  // Optional: control default pages
  pages: {
    signIn: '/login' // your custom login page
  },

  // Good practice to define a secret via env: NEXTAUTH_SECRET
  // debug: true,
};

export default NextAuth(authOptions);
