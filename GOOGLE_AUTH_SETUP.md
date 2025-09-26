# Google Authentication Setup Guide

This guide will help you set up Google OAuth authentication for your Next.js application.

## Prerequisites

- A Google Cloud Console account
- Your Next.js application running locally

## Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google+ API (if not already enabled)

## Step 2: Configure OAuth Consent Screen

1. In the Google Cloud Console, go to "APIs & Services" > "OAuth consent screen"
2. Choose "External" user type (unless you have a Google Workspace account)
3. Fill in the required fields:
   - App name: Your application name
   - User support email: Your email
   - Developer contact information: Your email
4. Add scopes:
   - `../auth/userinfo.email`
   - `../auth/userinfo.profile`
   - `openid`
5. Add test users (for development) or publish the app (for production)

## Step 3: Create OAuth 2.0 Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth 2.0 Client IDs"
3. Choose "Web application"
4. Add authorized redirect URIs:
   - For development: `http://localhost:3000/api/auth/callback/google`
   - For production: `https://yourdomain.com/api/auth/callback/google`
5. Copy the Client ID and Client Secret

## Step 4: Environment Variables

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Fill in your environment variables in `.env.local`:
   ```env
   NEXTAUTH_URL=http://localhost:3000
   NEXTAUTH_SECRET=your-random-secret-key-here
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   ```

3. Generate a random secret for `NEXTAUTH_SECRET`:
   ```bash
   openssl rand -base64 32
   ```

## Step 5: Database Setup

Your application uses Vercel Postgres. Make sure you have:

1. A Vercel Postgres database set up
2. The following environment variables configured:
   ```env
   POSTGRES_URL=your-postgres-connection-string
   POSTGRES_PRISMA_URL=your-postgres-prisma-url
   POSTGRES_URL_NON_POOLING=your-postgres-non-pooling-url
   POSTGRES_USER=your-postgres-username
   POSTGRES_HOST=your-postgres-host
   POSTGRES_PASSWORD=your-postgres-password
   POSTGRES_DATABASE=your-postgres-database
   ```

3. Create the users table in your database:
   ```sql
   CREATE TABLE users (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     email TEXT UNIQUE NOT NULL,
     created_at TIMESTAMP DEFAULT NOW()
   );
   ```

## Step 6: Test the Authentication

1. Start your development server:
   ```bash
   npm run dev
   ```

2. Navigate to `http://localhost:3000`
3. Click "Sign in with Google"
4. Complete the OAuth flow
5. You should be redirected back to your app and see your user information

## Troubleshooting

### Common Issues

1. **"redirect_uri_mismatch" error**: Make sure your redirect URI in Google Console matches exactly: `http://localhost:3000/api/auth/callback/google`

2. **"invalid_client" error**: Check that your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct

3. **"access_denied" error**: Make sure your OAuth consent screen is properly configured and you've added yourself as a test user

4. **Database connection issues**: Verify your Postgres connection string and that the users table exists

### Development vs Production

- **Development**: Use `http://localhost:3000` as your redirect URI
- **Production**: Use your actual domain: `https://yourdomain.com/api/auth/callback/google`

## Security Notes

- Never commit your `.env.local` file to version control
- Use strong, random values for `NEXTAUTH_SECRET`
- Regularly rotate your OAuth credentials
- Use HTTPS in production
- Consider implementing additional security measures like CSRF protection

## Next Steps

Once authentication is working, you can:

1. Add user roles and permissions
2. Implement user profile management
3. Add additional OAuth providers (GitHub, Facebook, etc.)
4. Set up user session management
5. Add logout functionality (already implemented)