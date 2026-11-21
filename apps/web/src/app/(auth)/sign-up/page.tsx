import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form.tsx";

export const metadata: Metadata = { title: "Sign up" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <AuthForm action="sign-up" next={typeof next === "string" ? next : undefined} />;
}
