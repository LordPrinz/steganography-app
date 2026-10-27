import { z } from "zod";

export const JobType = z.enum(["encode", "decode", "experiment"]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;
