// Row types mirroring migrations/*.sql — update both together.
// Bun.SQL returns columns as-is, so fields use the database's snake_case names.

export type ImageKind = "original" | "stego" | "variant";
export type OperationType = "encode" | "decode" | "experiment";
export type StegoMethod = "lsb" | "dct-koch-zhao" | "dwt-qim";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface ImageRow {
  id: string;
  user_id: string;
  kind: ImageKind;
  storage_key: string;
  format: string;
  width: number;
  height: number;
  size_bytes: number;
  sha256: string;
  created_at: Date;
}

export interface OperationRow {
  id: string;
  user_id: string;
  type: OperationType;
  method: StegoMethod | null;
  source_image_id: string | null;
  result_image_id: string | null;
  status: JobStatus;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: Date;
}

export interface JobRow {
  id: string;
  operation_id: string;
  status: JobStatus;
  attempts: number;
  error: string | null;
  run_after: Date;
  locked_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}
