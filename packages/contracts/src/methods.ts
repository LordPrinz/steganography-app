import { z } from "zod";

export const StegoMethod = z.enum(["lsb", "dct-koch-zhao", "dwt-qim"]);
export type StegoMethod = z.infer<typeof StegoMethod>;
