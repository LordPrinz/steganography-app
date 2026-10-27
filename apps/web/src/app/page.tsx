import { ApiStatus } from "@/components/api-status.tsx";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Steganography App</h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        LSB · DCT (Koch–Zhao) · DWT Haar + QIM — and a lab that measures how hidden data survives
        JPEG compression, resizing and blur.
      </p>
      <ApiStatus />
    </main>
  );
}
