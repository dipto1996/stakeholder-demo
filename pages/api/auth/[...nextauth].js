// pages/api/auth/[...nextauth].js
import NextAuth from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';

export const authOptions = {
  session: { strategy: 'jwt' },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    }),
    CredentialsProvider({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'text' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials) {
        const email = (credentials?.email || '').toLowerCase().trim();
        const password = credentials?.password || '';

        const { rows } = await sql`SELECT id, email, password_hash, email_verified
                                   FROM users WHERE email = ${email} LIMIT 1`;
        const user = rows[0];
        if (!user) throw new Error('No account found');
        if (!user.email_verified) throw new Error('Please verify your email first');

        const ok = await bcrypt.compare(password, user.password_hash || '');
        if (!ok) throw new Error('Invalid credentials');

        return { id: user.id, email: user.email };
      }
    })
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) token.userId = user.id || token.userId;
      return token;
    },
    async session({ session, token }) {
      if (token?.userId) session.user.id = token.userId;
      return session;
    }
  },
  pages: {
    signIn: '/login' // optional custom page
  }
};

export default NextAuth(authOptions);
