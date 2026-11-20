import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header.tsx";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { NAV_ITEMS } from "@/lib/nav.ts";

export default function HomePage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Steganography App"
        description="LSB · DCT (Koch–Zhao) · DWT Haar + QIM — and a lab that measures how hidden data survives JPEG compression, resizing and blur."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {NAV_ITEMS.map(({ href, label, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Card className="h-full transition-colors group-hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Icon className="size-4" />
                  {label}
                  <ArrowRight className="ml-auto size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
