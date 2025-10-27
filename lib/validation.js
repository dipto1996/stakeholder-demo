// lib/validation.js
/**
 * Input validation schemas using Zod
 * 
 * Install Zod: npm install zod
 * 
 * Usage:
 * import { chatRequestSchema } from '../lib/validation';
 * const validated = chatRequestSchema.parse(body);
 */

import { z } from 'zod';

/**
 * Chat API validation
 */
export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(5000),
  sources: z.array(z.any()).optional(),
  path: z.string().optional(),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(50),
});

/**
 * Conversation save validation
 */
export const saveConversationSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(500).optional(),
  messages: z.array(chatMessageSchema).min(1),
});

/**
 * User profile validation
 */
export const userProfileSchema = z.object({
  name: z.string().max(100).optional(),
  avatar_url: z.string().url().max(500).optional().or(z.literal('')),
  bio: z.string().max(1000).optional(),
  timezone: z.string().max(50).optional(),
});

/**
 * Auth validation
 */
export const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(100),
  confirm: z.string().min(8).max(100),
}).refine((data) => data.password === data.confirm, {
  message: "Passwords don't match",
  path: ["confirm"],
});

export const signinSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(100),
});

/**
 * Vault validation
 */
export const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(100).optional(),
  keyPrefix: z.string().max(100).optional(),
});

export const vaultCompleteSchema = z.object({
  filename: z.string().min(1).max(255),
  storageKey: z.string().min(1).max(500),
  mime: z.string().max(100).optional(),
  size: z.number().int().positive().optional(),
});

/**
 * KYV validation
 */
export const kyvEvaluateSchema = z.object({
  education_level: z.string().max(100),
  experience_years: z.number().int().min(0).max(100),
  exceptional_skill: z.boolean(),
  country: z.string().max(100),
  goal: z.enum(['work', 'study', 'invest']),
});

/**
 * Cred check validation
 */
export const credCheckSchema = z.object({
  answer_text: z.string().min(1).max(10000),
  claims: z.array(z.object({
    id: z.string(),
    text: z.string().min(1).max(2000),
  })).min(1),
  citations: z.array(z.object({
    claim_id: z.string(),
    urls: z.array(z.object({
      url: z.string().url(),
      quoted_snippet: z.string().max(1000).optional(),
    })),
  })),
});

/**
 * Helper function to validate and return errors
 */
export function validateRequest(schema, data) {
  try {
    return { success: true, data: schema.parse(data) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      };
    }
    return { success: false, errors: [{ message: 'Validation failed' }] };
  }
}

/**
 * Middleware-style validator for API routes
 */
export function withValidation(schema) {
  return async (handler) => {
    return async (req, res) => {
      const body = req.body || (await req.json().catch(() => ({})));
      const validation = validateRequest(schema, body);
      
      if (!validation.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: validation.errors,
        });
      }
      
      // Attach validated data to request
      req.validatedBody = validation.data;
      return handler(req, res);
    };
  };
}

