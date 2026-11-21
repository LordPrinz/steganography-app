"use client";

import { AuthResponse, LoginRequest, RegisterRequest } from "@stego/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { replaceSession, useSession } from "@/hooks/use-session.ts";
import { apiPost } from "@/lib/api.ts";
import { type AuthAction, authErrorMessage } from "@/lib/auth-errors.ts";
import { safeReturnPath } from "@/lib/return-path.ts";

type Field = "email" | "password";
type FieldErrors = Partial<Record<Field, string>>;

const COPY = {
  "sign-in": {
    title: "Sign in",
    description: "Sign in to your account.",
    submit: "Sign in",
    pending: "Signing in…",
    switchText: "No account yet?",
    switchLabel: "Sign up",
    switchHref: "/sign-up",
    passwordAutocomplete: "current-password",
    emailAutocomplete: "username",
  },
  "sign-up": {
    title: "Create an account",
    description: "Create an account to get started.",
    submit: "Create account",
    pending: "Creating account…",
    switchText: "Already have an account?",
    switchLabel: "Sign in",
    switchHref: "/sign-in",
    passwordAutocomplete: "new-password",
    emailAutocomplete: "email",
  },
} as const;

const PASSWORD_ERROR: Record<AuthAction, string> = {
  "sign-in": "Enter your password.",
  "sign-up": "Use 8 to 128 characters.",
};

function validate(action: AuthAction, input: { email: string; password: string }) {
  const schema = action === "sign-up" ? RegisterRequest : LoginRequest;
  const parsed = schema.safeParse(input);
  if (parsed.success) return { data: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    if (issue.path[0] === "email") errors.email ??= "Enter a valid e-mail address.";
    if (issue.path[0] === "password") errors.password ??= PASSWORD_ERROR[action];
  }
  return { errors };
}

export function AuthForm({ action, next }: { action: AuthAction; next?: string }) {
  const copy = COPY[action];
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const returnTo = safeReturnPath(next);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [showPassword, setShowPassword] = useState(false);

  const mutation = useMutation({
    mutationFn: async (credentials: LoginRequest) => {
      // Registering does not sign in, so the login is a second request.
      if (action === "sign-up") await apiPost("/api/v1/auth/register", credentials);
      return (await apiPost("/api/v1/auth/login", credentials, AuthResponse)).user;
    },
    onSuccess: (user) => replaceSession(queryClient, user),
  });

  const signedIn = Boolean(session.data);
  useEffect(() => {
    if (signedIn) router.replace(returnTo);
  }, [signedIn, router, returnTo]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || signedIn) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const result = validate(action, {
      email: String(values.get("email") ?? ""),
      password: String(values.get("password") ?? ""),
    });
    if (!result.data) {
      setFieldErrors(result.errors);
      const first = result.errors.email ? "email" : "password";
      (form.elements.namedItem(first) as HTMLInputElement | null)?.focus();
      return;
    }
    setFieldErrors({});
    mutation.mutate(result.data);
  }

  const busy = mutation.isPending || signedIn;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <h1 className="font-heading text-lg leading-snug font-medium">{copy.title}</h1>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
          {mutation.isError && (
            <Alert variant="destructive" role="alert">
              {authErrorMessage(mutation.error, action)}
            </Alert>
          )}
          {signedIn && <Alert role="status">Signed in. Redirecting…</Alert>}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete={copy.emailAutocomplete}
              autoCapitalize="none"
              spellCheck={false}
              required
              readOnly={busy}
              aria-disabled={busy}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? "email-error" : undefined}
            />
            {fieldErrors.email && (
              <p id="email-error" className="text-sm text-destructive">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={copy.passwordAutocomplete}
                required
                readOnly={busy}
                aria-disabled={busy}
                className="pr-10"
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={
                  [
                    fieldErrors.password && "password-error",
                    action === "sign-up" && "password-hint",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1 right-1"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            {action === "sign-up" && (
              <p id="password-hint" className="text-sm text-muted-foreground">
                At least 8 characters.
              </p>
            )}
            {fieldErrors.password && (
              <p id="password-error" className="text-sm text-destructive">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <Button
            type="submit"
            size="lg"
            aria-disabled={busy}
            className="w-full aria-disabled:opacity-50"
          >
            {mutation.isPending && <Loader2 className="animate-spin" />}
            {mutation.isPending ? copy.pending : copy.submit}
          </Button>
        </CardContent>
      </form>
      <CardFooter className="justify-center gap-1 text-sm text-muted-foreground">
        {copy.switchText}
        <Link
          href={
            returnTo === "/"
              ? copy.switchHref
              : `${copy.switchHref}?next=${encodeURIComponent(returnTo)}`
          }
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {copy.switchLabel}
        </Link>
      </CardFooter>
    </Card>
  );
}
