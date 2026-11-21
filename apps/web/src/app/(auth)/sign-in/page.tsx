import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form.tsx";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <AuthForm action="sign-in" next={typeof next === "string" ? next : undefined} />;
}
