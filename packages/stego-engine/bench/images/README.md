# Natural test images

Four images from the Kodak Lossless True Color Image Suite (`kodim03`, `kodim08`, `kodim15`,
`kodim23`), used by the Koch–Zhao spike (`bun run bench:koch-zhao`, ADR 7) and by the JPEG tests of
`kochZhao`.

- Source: https://r0k.us/graphics/kodak/ (Eastman Kodak Company).
- Licence: Kodak released the images for unrestricted use, including research and publication.
- Changes: scaled from 768 × 512 to 384 × 256 with Bun.Image (Lanczos3) and re-encoded as PNG, to keep
  the repository small (about 740 KB in total).
