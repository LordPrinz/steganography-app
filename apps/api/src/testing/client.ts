import { expect } from "bun:test";
import { AuthResponse, ImageMeta } from "@stego/contracts";
import { TEST_ORIGIN } from "./server-deps.ts";

export const TEST_PASSWORD = "correct horse battery";

/** A browser stand-in for one user: keeps cookies, sends the app's Origin. */
export class Client {
  readonly cookies = new Map<string, string>();
  userId = "";

  constructor(
    readonly baseUrl: URL,
    readonly email: string,
  ) {}

  async request(method: string, path: string, init: RequestInit = {}) {
    const res = await fetch(new URL(`/api/v1${path}`, this.baseUrl), {
      ...init,
      method,
      headers: {
        origin: TEST_ORIGIN,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...init.headers,
      },
    });
    for (const header of res.headers.getSetCookie()) {
      const cookie = new Bun.Cookie(header);
      if (cookie.isExpired() || cookie.value === "") this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return res;
  }

  postJson(path: string, body: unknown) {
    return this.request("POST", path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  async signIn() {
    const body = JSON.stringify({ email: this.email, password: TEST_PASSWORD });
    const headers = { "content-type": "application/json" };
    await this.request("POST", "/auth/register", { body, headers });
    const login = await this.request("POST", "/auth/login", { body, headers });
    this.userId = AuthResponse.parse(await login.json()).user.id;
  }

  async uploadMeta(bytes: Uint8Array) {
    const form = new FormData();
    form.set(
      "file",
      new File([bytes as Uint8Array<ArrayBuffer>], "photo.png", { type: "image/png" }),
    );
    const res = await this.request("POST", "/images", { body: form });
    expect(res.status).toBe(201);
    return ImageMeta.parse(await res.json());
  }
}
