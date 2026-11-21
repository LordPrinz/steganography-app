import { z } from "zod";

// Lowercased so "Ann@x.io" and "ann@x.io" are one account.
export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Upper bound keeps argon2 work per request predictable.
export const Password = z.string().min(8).max(128);

export const RegisterRequest = z.object({ email: Email, password: Password });
export type RegisterRequest = z.infer<typeof RegisterRequest>;

// No length policy on login: accounts keep working if the register policy changes.
export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(128) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AuthUser = z.object({
  id: z.uuid(),
  email: z.string(),
  createdAt: z.iso.datetime(),
});
export type AuthUser = z.infer<typeof AuthUser>;

export const AuthResponse = z.object({ user: AuthUser });
export type AuthResponse = z.infer<typeof AuthResponse>;
