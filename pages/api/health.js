// pages/api/health.js
/**
 * Health Check Endpoint
 * 
 * Returns the health status of the application and its dependencies.
 * Useful for monitoring and uptime checks.
 * 
 * GET /api/health
 * 
 * Response:
 * {
 *   status: "healthy" | "degraded" | "unhealthy",
 *   timestamp: ISO string,
 *   checks: {
 *     database: { status: "ok" | "error", responseTime: number },
 *     openai: { status: "ok" | "error", configured: boolean },
 *     s3: { status: "ok" | "error", configured: boolean }
 *   }
 * }
 */

import { sql } from '@vercel/postgres';

export const config = { runtime: 'nodejs' };

async function checkDatabase() {
  const start = Date.now();
  try {
    await sql`SELECT 1`;
    return {
      status: 'ok',
      responseTime: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message,
      responseTime: Date.now() - start,
    };
  }
}

function checkOpenAI() {
  const configured = !!process.env.OPENAI_API_KEY;
  return {
    status: configured ? 'ok' : 'error',
    configured,
    error: configured ? undefined : 'OPENAI_API_KEY not configured',
  };
}

function checkS3() {
  const configured = !!(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.S3_BUCKET
  );
  return {
    status: configured ? 'ok' : 'warning',
    configured,
    note: configured ? undefined : 'S3 credentials not fully configured (Vault feature disabled)',
  };
}

function checkAuth() {
  const configured = !!(
    process.env.NEXTAUTH_SECRET &&
    process.env.NEXTAUTH_URL
  );
  return {
    status: configured ? 'ok' : 'error',
    configured,
    error: configured ? undefined : 'NextAuth not fully configured',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  // Run health checks
  const [database, openai, s3, auth] = await Promise.all([
    checkDatabase(),
    Promise.resolve(checkOpenAI()),
    Promise.resolve(checkS3()),
    Promise.resolve(checkAuth()),
  ]);

  // Determine overall status
  let overallStatus = 'healthy';
  
  const criticalChecks = [database, openai, auth];
  const hasError = criticalChecks.some((check) => check.status === 'error');
  const hasWarning = [database, openai, s3, auth].some(
    (check) => check.status === 'warning'
  );

  if (hasError) {
    overallStatus = 'unhealthy';
  } else if (hasWarning) {
    overallStatus = 'degraded';
  }

  const response = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
    environment: process.env.NODE_ENV || 'development',
    checks: {
      database,
      openai,
      s3,
      auth,
    },
    responseTime: Date.now() - startTime,
  };

  // Return appropriate status code
  const statusCode = overallStatus === 'healthy' ? 200 : 
                     overallStatus === 'degraded' ? 200 : 503;

  return res.status(statusCode).json(response);
}

