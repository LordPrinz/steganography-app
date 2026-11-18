import { ApiStatus } from "@/components/api-status.tsx";

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-sm text-muted-foreground">
        <p>Piotr Hejmo, Daniel Kowalski, Oskar Płazińskicl</p>
        <ApiStatus />
      </div>
    </footer>
  );
}
